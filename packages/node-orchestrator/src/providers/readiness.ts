/**
 * Provider readiness contract — the single source of truth for "can this
 * provider actually run right now?".
 *
 * Readiness logic used to be scattered (and inconsistent) across the /providers
 * route, /engines/prerequisites, packSelection, and the providers themselves —
 * which is why a not-ready provider (Ollama with no daemon) could be selected
 * and only fail deep inside a pipeline step. This collapses it into one place:
 *
 *   - cloud providers      -> their API key is configured
 *   - engine-pack providers-> a matching pack is installed
 *   - the Ollama provider   -> the daemon is reachable AND the model is pulled
 *   - default local         -> ready (precise whisper/argos/piper model gating
 *                              lands with the background-installer stage)
 *
 * It is consumed by the run-start gate (so a run NEVER dies mid-step) and is
 * surfaced to the UI via /providers, so the same verdict drives both.
 */
import {
  AppErrorException,
  pipelineStepIndex,
  type CloudServiceId,
  type ErrorCode,
  type PipelineStepId,
  type Project,
} from '@videodubber/shared';
import type { CredentialsStore } from '../credentials/credentialsStore.js';
import type { EnginePackStore } from '../engines/enginePackStore.js';
import { pickInstalledPack } from '../engines/packSelection.js';
import { commandOnPath } from '../engines/uv.js';
import { OLLAMA_MODEL, OLLAMA_URL, type ProviderRegistry } from './registry.js';

/** Why a provider is (not) ready. `ready` means usable right now. */
export type ReadinessStatus =
  | 'ready'
  | 'cloud-key-missing'
  | 'engine-pack-missing'
  | 'daemon-unreachable'
  | 'model-missing';

/** A UI affordance that would make a not-ready provider ready. */
export interface ReadinessAction {
  kind: 'install-pack' | 'pull-ollama-model' | 'open-credentials' | 'guide';
  /** Pack id / model name / cloud service / guide key, depending on `kind`. */
  ref?: string;
}

/** Readiness verdict for one provider in one phase. */
export interface ProviderReadiness {
  phase: ProviderPhase;
  providerId: string;
  status: ReadinessStatus;
  ready: boolean;
  message: string;
  remediation?: string;
  action?: ReadinessAction;
}

export type ProviderPhase = 'stt' | 'translation' | 'tts';

/** Result of probing the Ollama daemon for liveness + a specific model. */
export interface OllamaProbe {
  daemon: boolean;
  model: boolean;
}

/** Dependencies the readiness checks need (all already constructed at startup). */
export interface ReadinessDeps {
  registry: ProviderRegistry;
  credentials: CredentialsStore;
  enginePackStore: EnginePackStore;
  /** Injectable Ollama probe (defaults to the real /v1/models check). */
  probeOllama?: (model: string) => Promise<OllamaProbe>;
  /** Injectable espeak-ng probe (defaults to a PATH lookup). */
  probeEspeak?: () => Promise<boolean>;
}

/** Real espeak-ng probe: the binary is on PATH. */
async function defaultProbeEspeak(): Promise<boolean> {
  return (await commandOnPath('espeak-ng')) !== null;
}

/** Just the provider fields readiness cares about (instances + descriptors satisfy this). */
export interface ProviderTraits {
  id: string;
  displayName?: string;
  isLocal?: boolean;
  credentialService?: CloudServiceId;
  requiresEnginePack?: string;
}

/** Real Ollama probe: daemon is up if /v1/models answers; model present if listed. */
async function defaultProbeOllama(model: string): Promise<OllamaProbe> {
  try {
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { daemon: false, model: false };
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    return { daemon: true, model: ids.includes(model) };
  } catch {
    return { daemon: false, model: false };
  }
}

const PHASES: { phase: ProviderPhase; step: PipelineStepId }[] = [
  { phase: 'stt', step: 'stt' },
  { phase: 'translation', step: 'translation' },
  { phase: 'tts', step: 'tts' },
];

function providerFor(phase: ProviderPhase, registry: ProviderRegistry, project: Project): ProviderTraits {
  switch (phase) {
    case 'stt':
      return registry.getStt(project.settings.sttProviderId);
    case 'translation':
      return registry.getTranslation(project.settings.translationProviderId);
    case 'tts':
      return registry.getTts(project.settings.ttsProviderId);
  }
}

/** Per-request shared context so we only probe Ollama / read credentials once. */
export interface ReadinessContext {
  configured: Set<CloudServiceId>;
  ollama: () => Promise<OllamaProbe>;
}

/**
 * Build the shared readiness context once (resolve configured cloud services +
 * a memoized Ollama probe), so checking many providers in one request doesn't
 * re-read credentials or re-probe the daemon per provider.
 */
export async function buildReadinessContext(deps: ReadinessDeps): Promise<ReadinessContext> {
  const creds = await deps.credentials.describe();
  const configured = new Set(creds.filter((c) => c.configured).map((c) => c.service));
  const probe = deps.probeOllama ?? defaultProbeOllama;
  let ollamaPromise: Promise<OllamaProbe> | undefined;
  return { configured, ollama: () => (ollamaPromise ??= probe(OLLAMA_MODEL)) };
}

/** Readiness of a single provider (cloud key / engine pack / Ollama daemon+model). */
export async function describeProviderReadiness(
  phase: ProviderPhase,
  provider: ProviderTraits,
  deps: ReadinessDeps,
  ctx: ReadinessContext,
): Promise<ProviderReadiness> {
  const name = provider.displayName ?? provider.id;
  const base = { phase, providerId: provider.id };
  const ready: ProviderReadiness = { ...base, status: 'ready', ready: true, message: 'Ready.' };

  if (provider.credentialService) {
    if (ctx.configured.has(provider.credentialService)) return ready;
    return {
      ...base,
      status: 'cloud-key-missing',
      ready: false,
      message: `${name} needs an API key.`,
      remediation: 'Add the API key in Settings → Cloud providers, or pick a local provider for this phase.',
      action: { kind: 'open-credentials', ref: provider.credentialService },
    };
  }

  if (provider.requiresEnginePack) {
    const pack = await pickInstalledPack(deps.enginePackStore, provider.requiresEnginePack);
    if (!pack) {
      return {
        ...base,
        status: 'engine-pack-missing',
        ready: false,
        message: `${name} needs the "${provider.requiresEnginePack}" engine pack.`,
        remediation: 'Install it in Settings → Engines, or pick a different provider for this phase.',
        action: { kind: 'install-pack', ref: provider.requiresEnginePack },
      };
    }
    // The VieNeu neural-TTS pack also needs espeak-ng (a system binary) for
    // pronunciation. Gate on it so a run can't silently produce a fully SILENT
    // dub (the worker falls back to silence when espeak-ng is absent).
    if (provider.requiresEnginePack === 'neural-tts') {
      const espeakOk = await (deps.probeEspeak ?? defaultProbeEspeak)();
      if (!espeakOk) {
        return {
          ...base,
          status: 'model-missing',
          ready: false,
          message: `${name} needs the espeak-ng system tool for pronunciation.`,
          remediation:
            'Install espeak-ng (macOS: `brew install espeak-ng`; Debian/Ubuntu: `apt install espeak-ng`; Windows: install eSpeak NG and add it to PATH), then retry — or pick a different voice engine.',
          action: { kind: 'guide', ref: 'espeak-ng' },
        };
      }
    }
    return ready;
  }

  if (provider.id === 'ollama') {
    const probe = await ctx.ollama();
    if (!probe.daemon) {
      return {
        ...base,
        status: 'daemon-unreachable',
        ready: false,
        message: 'The Ollama daemon is not running.',
        remediation:
          'Start Ollama (`ollama serve`) and pull a model, or pick Argos / the llama.cpp engine pack (no daemon).',
        action: { kind: 'guide', ref: 'ollama' },
      };
    }
    if (!probe.model) {
      return {
        ...base,
        status: 'model-missing',
        ready: false,
        message: `Ollama is running but the model "${OLLAMA_MODEL}" is not pulled.`,
        remediation: `Pull it with \`ollama pull ${OLLAMA_MODEL}\` (or set OLLAMA_MODEL to a model you have).`,
        action: { kind: 'pull-ollama-model', ref: OLLAMA_MODEL },
      };
    }
    return ready;
  }

  // Default local providers (faster-whisper / argos / piper-local) and any other
  // local engine are treated as ready here. Precise model/voice-presence gating
  // arrives with the background-installer + setupStore tracking stage.
  return ready;
}

/**
 * Readiness of the providers a run would actually use. When `fromStep` is given
 * (a retry), only phases whose step runs at-or-after it are checked, so a
 * retry-from-render isn't blocked by an unready (already-done) translator.
 * Returns one entry per checked phase (ready ones included), so callers can both
 * gate (filter not-ready) and surface the full picture to the UI.
 */
export async function checkProviderReadiness(
  project: Project,
  deps: ReadinessDeps,
  fromStep?: PipelineStepId,
): Promise<ProviderReadiness[]> {
  const ctx = await buildReadinessContext(deps);
  const retryIndex = fromStep ? pipelineStepIndex(fromStep) : 0;
  const phases = PHASES.filter((p) => pipelineStepIndex(p.step) >= retryIndex);
  return Promise.all(
    phases.map((p) => describeProviderReadiness(p.phase, providerFor(p.phase, deps.registry, project), deps, ctx)),
  );
}

const STATUS_CODE: Record<Exclude<ReadinessStatus, 'ready'>, ErrorCode> = {
  'cloud-key-missing': 'CLOUD_CREDENTIALS_MISSING',
  'engine-pack-missing': 'ENGINE_PACK_MISSING',
  'daemon-unreachable': 'ENGINE_UNAVAILABLE',
  'model-missing': 'ENGINE_UNAVAILABLE',
};

/**
 * Throw a structured, actionable {@link AppErrorException} if any checked
 * provider isn't ready — used by the run-start gate so a run refuses to begin
 * (with remediation) instead of failing deep in a step.
 */
export function assertRunReady(results: ProviderReadiness[]): void {
  const problems = results.filter((r) => !r.ready);
  if (problems.length === 0) return;
  const p = problems[0]!;
  const extra = problems.length > 1 ? ` (and ${problems.length - 1} more provider issue(s))` : '';
  throw new AppErrorException(STATUS_CODE[p.status as Exclude<ReadinessStatus, 'ready'>], `${p.message}${extra}`, {
    remediation: p.remediation,
  });
}
