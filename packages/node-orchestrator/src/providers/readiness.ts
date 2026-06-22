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
  type InstalledModels,
  type PipelineStepId,
  type Project,
} from '@videodubber/shared';
import { computeRequiredResources } from '../setup/requiredResources.js';
import type { CredentialsStore } from '../credentials/credentialsStore.js';
import type { EnginePackStore } from '../engines/enginePackStore.js';
import {
  isPackUsable,
  pickInstalledLocalLlmModel,
  pickInstalledPack,
  recommendedPackFor,
} from '../engines/packSelection.js';
import { OLLAMA_MODEL, OLLAMA_URL, type ProviderRegistry } from './registry.js';

/** Why a provider is (not) ready. `ready` means usable right now. */
export type ReadinessStatus =
  | 'ready'
  | 'cloud-key-missing'
  | 'engine-pack-missing'
  | 'daemon-unreachable'
  | 'model-missing'
  /** A local provider's bundled worker (STT/translation/TTS) is still booting. */
  | 'worker-loading';

/** Human phase labels for messages. */
const PHASE_LABEL: Record<ProviderPhase, string> = {
  stt: 'speech-to-text',
  translation: 'translation',
  tts: 'text-to-speech',
};

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
  /**
   * Probe whether the bundled worker backing a LOCAL provider is reachable
   * (true = up). The base workers (faster-whisper :5101, argos :5102, piper :5103)
   * take a few seconds to boot on launch; until then a local provider isn't
   * usable. Omitted (e.g. in unit tests) => local providers are assumed ready.
   */
  probeWorker?: (phase: ProviderPhase) => Promise<boolean>;
  /**
   * Verify a recorded engine pack is RUNNABLE (venv/binary present), not just
   * recorded. Defaults to the real {@link isPackUsable}; unit tests inject a
   * simple boolean so they don't need a real venv on disk.
   */
  packUsable?: (packId: string) => Promise<boolean>;
  /**
   * The installed default-pipeline model inventory (whisper / argos / piper), so
   * the run gate can block a run whose selected default model isn't downloaded
   * yet (e.g. a project in a new language whose background fetch hasn't finished)
   * instead of failing mid-pipeline. Omitted (unit tests, the generic /providers
   * listing) => model-presence gating is skipped.
   */
  installedModels?: () => Promise<InstalledModels>;
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
  /** Memoized per-phase worker reachability (true if up, or if no probe wired). */
  worker: (phase: ProviderPhase) => Promise<boolean>;
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
  const workerCache = new Map<ProviderPhase, Promise<boolean>>();
  const worker = (phase: ProviderPhase): Promise<boolean> => {
    if (!deps.probeWorker) return Promise.resolve(true); // no gating when unwired
    let p = workerCache.get(phase);
    if (!p) {
      p = deps.probeWorker(phase);
      workerCache.set(phase, p);
    }
    return p;
  };
  return { configured, ollama: () => (ollamaPromise ??= probe(OLLAMA_MODEL)), worker };
}

/** Readiness of a single provider (cloud key / engine pack / Ollama daemon+model). */
export async function describeProviderReadiness(
  phase: ProviderPhase,
  provider: ProviderTraits,
  deps: ReadinessDeps,
  ctx: ReadinessContext,
  /** Whether THIS phase's default-pipeline model is not yet downloaded (project-scoped checks only). */
  modelMissing = false,
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

  // Managed llama.cpp (TranslateGemma) is special: it needs BOTH a runtime
  // binary pack AND a separate GGUF model pack, each RUNNABLE (not merely
  // recorded). Checked before the generic requiresEnginePack branch so the
  // two-part requirement gets its own, more specific remediation.
  if (provider.id === 'llama-cpp') {
    const usable = deps.packUsable ?? ((id: string) => isPackUsable(deps.enginePackStore, id));
    const runtime = await pickInstalledPack(deps.enginePackStore, 'local-llm');
    if (!runtime || !(await usable(runtime))) {
      return {
        ...base,
        status: 'engine-pack-missing',
        ready: false,
        message: `${name} needs the llama.cpp runtime engine pack.`,
        remediation:
          'Install the llama.cpp runtime (and a TranslateGemma model) in Settings → Engines, or pick Argos / Ollama for this phase.',
        action: { kind: 'install-pack', ref: recommendedPackFor('local-llm')?.id ?? 'local-llm' },
      };
    }
    const model = await pickInstalledLocalLlmModel(deps.enginePackStore);
    if (!model) {
      return {
        ...base,
        status: 'engine-pack-missing',
        ready: false,
        message: `${name} has the runtime but no TranslateGemma model installed.`,
        remediation: 'Install a TranslateGemma model (4B / 12B / 27B) in Settings → Engines.',
        action: { kind: 'install-pack', ref: 'translategemma-4b' },
      };
    }
    return ready;
  }

  if (provider.requiresEnginePack) {
    const pack = await pickInstalledPack(deps.enginePackStore, provider.requiresEnginePack);
    // "Installed" isn't enough — the pack must be RUNNABLE (its venv/binary
    // present). A recorded-but-broken pack (e.g. a venv whose bundled-Python
    // target moved on reinstall, or a half-finished install) is reported missing
    // so the UI offers re-install and the run gate refuses, instead of the run
    // dying mid-step with "Python venv missing".
    const usable = pack
      ? await (deps.packUsable ?? ((id: string) => isPackUsable(deps.enginePackStore, id)))(pack)
      : false;
    if (pack && usable) return ready;
    return {
      ...base,
      status: 'engine-pack-missing',
      ready: false,
      message: pack
        ? `${name}'s "${provider.requiresEnginePack}" engine pack is installed but incomplete.`
        : `${name} needs the "${provider.requiresEnginePack}" engine pack.`,
      remediation: pack
        ? 'Reinstall it in Settings → Engines (the previous install was interrupted or its files moved).'
        : 'Install it in Settings → Engines, or pick a different provider for this phase.',
      action: { kind: 'install-pack', ref: provider.requiresEnginePack },
    };
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
          "Switch this project's Translation to Argos (offline, nothing to install) or TranslateGemma (built-in) " +
          'from Settings → Engines — neither needs Ollama. (Ollama is optional; to use it, start it with `ollama serve`.)',
        action: { kind: 'guide', ref: 'ollama' },
      };
    }
    if (!probe.model) {
      return {
        ...base,
        status: 'model-missing',
        ready: false,
        message: `Ollama is running but the model "${OLLAMA_MODEL}" is not pulled.`,
        remediation:
          `Click “Pull ${OLLAMA_MODEL}” here to download it, or switch this project's Translation to Argos / ` +
          `TranslateGemma (built-in). (Advanced: \`ollama pull ${OLLAMA_MODEL}\`.)`,
        action: { kind: 'pull-ollama-model', ref: OLLAMA_MODEL },
      };
    }
    return ready;
  }

  // Default local providers (faster-whisper / argos / piper-local) run inside a
  // bundled worker for this phase. If that worker is still booting (a few seconds
  // after launch), the provider isn't usable yet — block the run with a clear
  // "still starting" message instead of letting it fail deep in a step.
  if (!(await ctx.worker(phase))) {
    return {
      ...base,
      status: 'worker-loading',
      ready: false,
      message: `The ${PHASE_LABEL[phase]} service is still starting.`,
      remediation: 'It loads in the background shortly after launch — try again in a few seconds.',
      action: { kind: 'guide', ref: 'worker-loading' },
    };
  }
  // Default local provider (faster-whisper / argos / piper-local): if its model
  // for the selected language hasn't finished downloading, block the run with a
  // clear message instead of letting it die mid-pipeline. Only set for
  // project-scoped checks (the generic /providers listing passes false).
  if (modelMissing) {
    return {
      ...base,
      status: 'model-missing',
      ready: false,
      message: `The ${PHASE_LABEL[phase]} model for this language is still downloading or isn't installed yet.`,
      remediation:
        'A new language downloads its model automatically the first time you use it — give it a moment and ' +
        'press Start again, or pick a different provider for this phase.',
      action: { kind: 'guide', ref: 'downloading-models' },
    };
  }
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

  // Which of this project's DEFAULT-pipeline models aren't downloaded yet, so the
  // gate can block before a run dies on a missing model. computeRequiredResources
  // only reports for the default local providers (faster-whisper/argos/piper), so
  // a phase using cloud/Ollama/an engine pack is never falsely flagged. Skipped
  // when installedModels isn't wired (tests / the generic /providers listing).
  const installed = deps.installedModels ? await deps.installedModels() : undefined;
  const required = installed ? computeRequiredResources(project.settings, installed) : undefined;
  const modelMissing = (phase: ProviderPhase): boolean => {
    if (!required) return false;
    if (phase === 'stt') return Boolean(required.whisperModel);
    if (phase === 'translation') return (required.argosPairs?.length ?? 0) > 0;
    return (required.piperVoices?.length ?? 0) > 0; // tts
  };

  return Promise.all(
    phases.map((p) =>
      describeProviderReadiness(p.phase, providerFor(p.phase, deps.registry, project), deps, ctx, modelMissing(p.phase)),
    ),
  );
}

const STATUS_CODE: Record<Exclude<ReadinessStatus, 'ready'>, ErrorCode> = {
  'cloud-key-missing': 'CLOUD_CREDENTIALS_MISSING',
  'engine-pack-missing': 'ENGINE_PACK_MISSING',
  'daemon-unreachable': 'ENGINE_UNAVAILABLE',
  'model-missing': 'ENGINE_UNAVAILABLE',
  'worker-loading': 'ENGINE_UNAVAILABLE',
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
