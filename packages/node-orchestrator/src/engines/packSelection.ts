/**
 * Pick the right engine pack for a provider on this machine.
 *
 * A logical provider (e.g. `whisper-cpp`) has several catalog packs, one per
 * acceleration backend. We prefer the most capable backend the machine has
 * (cuda > metal > vulkan > coreml > mps > cpu) among the packs that both run on
 * this platform AND are installed.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, type EngineAccel, type EnginePackInfo } from '@videodubber/shared';
import { availablePacks, findPack } from './enginePackCatalog.js';
import type { EnginePackStore } from './enginePackStore.js';

/**
 * Is a recorded pack actually RUNNABLE — not merely present on disk?
 *
 * `EnginePackStore.isInstalled` only checks the pack DIRECTORY still exists, so a
 * pack whose venv is missing/broken (e.g. its venv `python` symlink points at a
 * bundled CPython that moved when the app was reinstalled, or a half-finished
 * install) reads as "installed", is offered as available, then fails at run with
 * "Python venv missing". This verifies the real launch artifact:
 *   - uv-env (python-uv) packs → the venv's python executable resolves (stat
 *     follows the symlink, so a dangling target correctly fails);
 *   - binary packs → the extracted directory is enough.
 */
export async function isPackUsable(store: EnginePackStore, packId: string): Promise<boolean> {
  const rec = await store.get(packId);
  if (!rec) return false;
  const dirOk = await fsp
    .stat(rec.path)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!dirOk) return false;

  const pack = findPack(packId);
  const isUvEnv = pack?.artifacts.some((a) => a.url.startsWith('uv-env://')) ?? false;
  if (!isUvEnv) return true;

  const venvPython =
    process.platform === 'win32'
      ? path.join(rec.path, 'venv', 'Scripts', 'python.exe')
      : path.join(rec.path, 'venv', 'bin', 'python');
  return fsp
    .stat(venvPython)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** Higher = preferred. */
const ACCEL_RANK: Record<EngineAccel, number> = {
  cuda: 5,
  metal: 4,
  vulkan: 3,
  coreml: 2,
  mps: 2,
  cpu: 1,
};

/** Catalog packs for a provider that run on the given machine, best-accel first. */
export function packsForProvider(
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo[] {
  return availablePacks(platform, arch)
    .filter((p) => p.providerId === providerId)
    .sort((a, b) => ACCEL_RANK[b.accel] - ACCEL_RANK[a.accel]);
}

/** The best INSTALLED pack id for a provider, or undefined if none installed. */
export async function pickInstalledPack(
  store: EnginePackStore,
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const candidates = packsForProvider(providerId, platform, arch);
  for (const pack of candidates) {
    if (await store.isInstalled(pack.id)) return pack.id;
  }
  return undefined;
}

/** Resolve an installed pack id or throw a clear ENGINE_PACK_MISSING. */
export async function requireInstalledPack(store: EnginePackStore, providerId: string): Promise<string> {
  const id = await pickInstalledPack(store, providerId);
  if (!id) {
    throw new AppErrorException('ENGINE_PACK_MISSING', `No engine pack installed for "${providerId}".`, {
      remediation: 'Install the engine pack in Settings → Engines, or pick a different provider for this phase.',
    });
  }
  return id;
}

/** The best pack to SUGGEST installing for a provider (most capable for the machine). */
export function recommendedPackFor(
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo | undefined {
  return packsForProvider(providerId, platform, arch)[0];
}

// --------------------------------------------------------------------------
// TranslateGemma model packs (consumed by the llama.cpp `local-llm` runtime)
// --------------------------------------------------------------------------

/** Fixed GGUF filename every `local-llm-model` pack installs (see the catalog). */
const LOCAL_LLM_MODEL_FILE = 'model.gguf';

/** Model packs, MOST CAPABLE first — we prefer the largest the user installed. */
const LOCAL_LLM_MODEL_PACKS = ['translategemma-27b', 'translategemma-12b', 'translategemma-4b'] as const;

/**
 * The best INSTALLED TranslateGemma model pack whose GGUF is actually on disk,
 * or undefined if none. "Best" = largest (more quality) the user chose to
 * install; a half-finished download (no model.gguf) is skipped so readiness and
 * the run gate don't green-light a model that can't load.
 */
export async function pickInstalledLocalLlmModel(
  store: EnginePackStore,
): Promise<{ packId: string; modelPath: string } | undefined> {
  for (const packId of LOCAL_LLM_MODEL_PACKS) {
    const rec = await store.get(packId);
    if (!rec) continue;
    const modelPath = path.join(rec.path, LOCAL_LLM_MODEL_FILE);
    const ok = await fsp
      .stat(modelPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (ok) return { packId, modelPath };
  }
  return undefined;
}

/** Resolve the GGUF path of the best installed model pack, or throw ENGINE_PACK_MISSING. */
export async function resolveLocalLlmModelPath(store: EnginePackStore): Promise<string> {
  const found = await pickInstalledLocalLlmModel(store);
  if (!found) {
    throw new AppErrorException('ENGINE_PACK_MISSING', 'No TranslateGemma model is installed for the local LLM.', {
      remediation:
        'Install a TranslateGemma model (4B / 12B / 27B) in Settings → Engines, or switch this project’s Translation provider to Argos (offline, no setup) or Ollama.',
    });
  }
  return found.modelPath;
}

// --------------------------------------------------------------------------
// Gemma INSTRUCT chat-model packs (context-aware translation / repair)
// --------------------------------------------------------------------------

/** Chat-model packs, MOST CAPABLE first — we prefer the largest installed. */
const LOCAL_LLM_CHAT_MODEL_PACKS = [
  'chat-gemma4-26b-a4b',
  'chat-gemma4-12b',
  'chat-gemma3-12b',
  'chat-gemma3-4b',
] as const;

/**
 * The chat-turn format each pack's model was TRAINED on. Gemma 4 replaced the
 * `<start_of_turn>`/`<end_of_turn>` turns of Gemma 1–3 with `<|turn>`/`<turn|>`
 * plus thought channels, so the local-LLM provider (which renders turns itself
 * because we run llama-server with `--no-jinja`) must know which grammar the
 * selected GGUF expects. Wrong format = degraded output, not an error, so this
 * lives HERE, keyed by the same ids as the preference list — a new pack id
 * without a format entry fails the typecheck instead of silently defaulting.
 */
export type ChatModelPromptFormat = 'gemma' | 'gemma4';
const CHAT_MODEL_PROMPT_FORMATS: Record<(typeof LOCAL_LLM_CHAT_MODEL_PACKS)[number], ChatModelPromptFormat> = {
  'chat-gemma4-26b-a4b': 'gemma4',
  'chat-gemma4-12b': 'gemma4',
  'chat-gemma3-12b': 'gemma',
  'chat-gemma3-4b': 'gemma',
};

/** The selected chat model: which pack, where its GGUF is, how to prompt it. */
export interface LocalLlmChatModelSelection {
  packId: string;
  modelPath: string;
  promptFormat: ChatModelPromptFormat;
}

/**
 * The best INSTALLED Gemma instruct model pack whose GGUF is actually on
 * disk, or undefined if none — same semantics as
 * {@link pickInstalledLocalLlmModel}, for the `local-llm-chat-model` packs.
 */
export async function pickInstalledLocalLlmChatModel(
  store: EnginePackStore,
): Promise<LocalLlmChatModelSelection | undefined> {
  for (const packId of LOCAL_LLM_CHAT_MODEL_PACKS) {
    const rec = await store.get(packId);
    if (!rec) continue;
    const modelPath = path.join(rec.path, LOCAL_LLM_MODEL_FILE);
    const ok = await fsp
      .stat(modelPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (ok) return { packId, modelPath, promptFormat: CHAT_MODEL_PROMPT_FORMATS[packId] };
  }
  return undefined;
}

/** Resolve the best installed chat model, or throw ENGINE_PACK_MISSING. */
export async function resolveLocalLlmChatModel(store: EnginePackStore): Promise<LocalLlmChatModelSelection> {
  const found = await pickInstalledLocalLlmChatModel(store);
  if (!found) {
    throw new AppErrorException(
      'ENGINE_PACK_MISSING',
      'No Gemma instruct model is installed for context-aware local translation.',
      {
        remediation:
          'Install a Gemma instruct model pack (e.g. "Gemma 3 4B instruct") in Settings → Engines, or pick another translation provider for this project.',
      },
    );
  }
  return found;
}
