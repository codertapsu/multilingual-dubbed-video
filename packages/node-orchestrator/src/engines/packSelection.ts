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
import {
  AppErrorException,
  MIN_GPU_RESIDENT_FRACTION,
  gpuResidentFraction,
  gpuWeightBudgetMb,
  gpuWorkingSetMb,
  type ActivePackSelection,
  type EngineAccel,
  type EnginePackInfo,
  type LocalModelPreferences,
  type SystemProfile,
} from '@videodubber/shared';
import { availablePacks, findPack, WHISPER_CPP_MODEL_FILE } from './enginePackCatalog.js';
import { nvidiaDriverSupportsPack, packFitsForSelection, packHardwareSupported } from './engineRecommendation.js';
import { getSystemProfile } from '../system/systemProfile.js';
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

/**
 * EVERY installed pack for a provider, best-accelerator first.
 *
 * A provider can have several runnable backends installed at once (llama.cpp
 * ships CUDA, Vulkan and Metal builds). {@link pickInstalledPack} returns only
 * the best one, which is right until that build cannot actually run here — a
 * CUDA binary needs a matching driver, and a card can be too small for a given
 * model. Callers that can retry use this to fall back instead of failing the
 * whole step: installing a second runtime should never make the app worse than
 * not installing it.
 *
 * Given a hardware `profile`, a build whose driver requirement this machine
 * misses is DEMOTED to the back rather than dropped. Falling back already works
 * — but only after paying the failed build's whole model load (12-17s on a 4 GB
 * card, every session, before the abort), so ordering is where the cost
 * actually goes away. Demoting rather than removing keeps the fallback honest
 * if the detection is wrong, and keeps a single-pack machine working: trying a
 * build that might fail beats refusing to try anything.
 */
export async function installedPacksForProvider(
  store: EnginePackStore,
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  profile?: SystemProfile,
): Promise<string[]> {
  const packs = packsForProvider(providerId, platform, arch);
  const ids: string[] = [];
  for (const pack of packs) {
    if (await store.isInstalled(pack.id)) ids.push(pack.id);
  }
  if (!profile) return ids;
  const demoted = new Set(
    packs.filter((p) => !nvidiaDriverSupportsPack(p, profile)).map((p) => p.id),
  );
  if (demoted.size === 0) return ids;
  return [...ids.filter((id) => !demoted.has(id)), ...ids.filter((id) => demoted.has(id))];
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

/** The runtime family a weights-only (model) pack runs on. */
const RUNTIME_FOR_MODEL_FAMILY: Readonly<Record<string, string>> = {
  'local-llm-model': 'local-llm',
  'local-llm-chat-model': 'local-llm',
  'whisper-cpp-model': 'whisper-cpp',
  'audio-cpp-separation-model': 'audio-cpp',
};

/**
 * The runtime pack to install alongside a model pack: the most capable build
 * this hardware can actually run (accelerator present, NVIDIA driver new
 * enough), or undefined when the family already has a runtime installed or
 * none fits. The model packs' descriptions promised "installed automatically
 * alongside" long before anything did it, so installing a TranslateGemma model
 * alone left a model the app could not run.
 */
export async function companionRuntimeFor(
  store: EnginePackStore,
  packId: string,
  profile: SystemProfile,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const family = RUNTIME_FOR_MODEL_FAMILY[findPack(packId)?.providerId ?? ''];
  if (!family) return undefined;
  if (await pickInstalledPack(store, family, platform, arch)) return undefined;
  return packsForProvider(family, platform, arch).find(
    (p) => packHardwareSupported(p, profile) && nvidiaDriverSupportsPack(p, profile),
  )?.id;
}

/**
 * Runtime families whose graphics build cannot fall back to its own processor
 * backend on a platform, so their processor build is installed beside it.
 *
 * audio.cpp on Windows: the Vulkan package has no per-CPU ggml variants, and
 * its processor backend dies at start with 0xC000001D (illegal instruction) on
 * an i5-13400F (Phase 0, and again 2026-11-19), where the processor package
 * separated the same clip. Without it, a graphics card the Vulkan build cannot
 * use left separation with nothing that runs. It is 34 MB. (The Mac's Metal
 * package runs on its processor backend fine.)
 */
const PROCESSOR_BUILD_BESIDE: Readonly<Record<string, readonly NodeJS.Platform[]>> = {
  'audio-cpp': ['win32'],
};

/** True when `family`'s graphics builds have a processor backend that runs here. */
export function graphicsBuildRunsOnProcessor(family: string, platform: NodeJS.Platform = process.platform): boolean {
  return !PROCESSOR_BUILD_BESIDE[family]?.includes(platform);
}

/**
 * Every runtime to install with a model pack: the best one for the machine
 * ({@link companionRuntimeFor}), plus the processor build where the family's
 * graphics builds cannot fall back to the processor themselves.
 */
export async function companionRuntimesFor(
  store: EnginePackStore,
  packId: string,
  profile: SystemProfile,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string[]> {
  const family = RUNTIME_FOR_MODEL_FAMILY[findPack(packId)?.providerId ?? ''];
  if (!family) return [];
  const out: string[] = [];
  const best = await companionRuntimeFor(store, packId, profile, platform, arch);
  if (best) out.push(best);
  if (!graphicsBuildRunsOnProcessor(family, platform)) {
    const processor = packsForProvider(family, platform, arch).find((p) => p.accel === 'cpu');
    if (processor && !out.includes(processor.id) && !(await store.get(processor.id))) out.push(processor.id);
  }
  return out;
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
// Model packs of the same FUNCTION: pick the best one the machine can run
// --------------------------------------------------------------------------

/** Fixed GGUF filename every `local-llm-model` pack installs (see the catalog). */
const LOCAL_LLM_MODEL_FILE = 'model.gguf';

/** A chosen model pack, plus why a more capable installed one was passed over. */
export interface ModelPackSelection {
  packId: string;
  modelPath: string;
  /**
   * Set when a MORE capable pack is installed but was not chosen (it needs more
   * memory than this machine has). Surfaced in Settings so the user understands
   * which model is actually running — and can free the disk space.
   */
  skipped?: { packId: string; reason: string };
  /** The user picked this pack in Settings → Engines. */
  chosenByUser?: boolean;
}

/** Is `modelPath` a real file (a half-finished download has no GGUF)? */
function isFile(p: string): Promise<boolean> {
  return fsp
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** Machine profile, or undefined when detection fails (selection must not break). */
async function machineProfile(): Promise<SystemProfile | undefined> {
  try {
    return await getSystemProfile();
  } catch {
    return undefined;
  }
}

/**
 * Choose among installed packs of the SAME function.
 *
 * `ranked` is most-capable-first, so the naive rule is "take the first
 * installed". That is wrong when the user installs a model bigger than the
 * machine: a 26B on a 16 GB laptop would be picked and then thrash. So we take
 * the most capable pack that FITS (catalog `minRamMb`/`minVramMb` vs the real
 * machine), and only if none fits fall back to the LEAST demanding installed
 * one — running something beats running nothing.
 *
 * Hardware detection failing is not a reason to change the answer: we then use
 * the plain ranked order, exactly as before.
 */
async function pickRankedModelPack(
  store: EnginePackStore,
  ranked: readonly string[],
  profileOverride?: SystemProfile,
  preferred?: string,
): Promise<ModelPackSelection | undefined> {
  const candidates: { packId: string; modelPath: string }[] = [];
  for (const packId of ranked) {
    const rec = await store.get(packId);
    if (!rec) continue;
    const modelPath = path.join(rec.path, LOCAL_LLM_MODEL_FILE);
    if (await isFile(modelPath)) candidates.push({ packId, modelPath });
  }
  if (candidates.length === 0) return undefined;
  const best = candidates[0]!;

  // The user's choice (Settings → Engines) wins whatever the hardware advice:
  // a slower, better model is theirs to pick.
  const chosenByUser = preferred ? candidates.find((c) => c.packId === preferred) : undefined;
  if (chosenByUser) return { ...chosenByUser, chosenByUser: true };

  const profile = profileOverride ?? (await machineProfile());
  if (!profile) return best;

  const fits = (packId: string): boolean => {
    const pack = findPack(packId);
    // Tolerant fit: os.totalmem() under-reports on Windows/Linux, and every
    // catalog gate is an exact GiB power of two, so a strict compare would make
    // every tier boundary unreachable there (see packFitsForSelection).
    return !pack || packFitsForSelection(pack, profile);
  };
  // With a graphics card, the most capable model that sits mostly ON it — the
  // same rule the recommendation uses. RAM alone used to decide, and on an
  // 8 GB RTX 3050 with 32 GB of RAM that picked the 15 GB TranslateGemma 27B:
  // most of it ran on the processor, and translation plus review took 1,248 s
  // of a 2,220 s dub.
  const residentEnough = (packId: string): boolean => {
    const pack = findPack(packId);
    const size = pack ? gpuWorkingSetMb(pack) : 0;
    return size > 0 && gpuResidentFraction(size, profile) >= MIN_GPU_RESIDENT_FRACTION;
  };
  const onGpu = gpuWeightBudgetMb(profile) > 0 ? candidates.find((c) => fits(c.packId) && residentEnough(c.packId)) : undefined;
  const chosen =
    onGpu ??
    candidates.find((c) => fits(c.packId)) ??
    // Nothing fits — use the least memory-hungry installed pack.
    [...candidates].sort((a, b) => (findPack(a.packId)?.minRamMb ?? 0) - (findPack(b.packId)?.minRamMb ?? 0))[0]!;

  if (chosen.packId === best.packId) return chosen;
  const bestPack = findPack(best.packId);
  const bestName = bestPack?.displayName ?? best.packId;
  if (onGpu && fits(best.packId)) {
    const pct = Math.round(gpuResidentFraction(bestPack ? gpuWorkingSetMb(bestPack) : 0, profile) * 100);
    return {
      ...chosen,
      skipped: {
        packId: best.packId,
        reason: `Only about ${pct}% of ${bestName} fits in the graphics card's memory, so most of it would run on the processor; choose it in Settings → Engines to use it anyway.`,
      },
    };
  }
  const needGb = bestPack?.minRamMb ? Math.round(bestPack.minRamMb / 1024) : undefined;
  const haveGb = Math.floor(profile.totalRamMb / 1024);
  return {
    ...chosen,
    skipped: {
      packId: best.packId,
      reason: needGb
        ? `${bestName} needs about ${needGb} GB of memory; this computer has ${haveGb} GB.`
        : `${bestName} needs more memory than this computer has (${haveGb} GB).`,
    },
  };
}

/** Model packs, MOST CAPABLE first — we prefer the largest the machine can run. */
const LOCAL_LLM_MODEL_PACKS = ['translategemma-27b', 'translategemma-12b', 'translategemma-4b'] as const;

/**
 * The best INSTALLED TranslateGemma model pack whose GGUF is actually on disk,
 * or undefined if none. "Best" = the most capable one this machine can actually
 * run (see {@link pickRankedModelPack}); a half-finished download (no
 * model.gguf) is skipped so readiness and the run gate don't green-light a model
 * that can't load.
 */
export async function pickInstalledLocalLlmModel(
  store: EnginePackStore,
  profile?: SystemProfile,
  preferred?: string,
): Promise<ModelPackSelection | undefined> {
  return pickRankedModelPack(store, LOCAL_LLM_MODEL_PACKS, profile, preferred);
}

/** Resolve the GGUF path of the best installed model pack, or throw ENGINE_PACK_MISSING. */
export async function resolveLocalLlmModelPath(store: EnginePackStore, preferred?: string): Promise<string> {
  const found = await pickInstalledLocalLlmModel(store, undefined, preferred);
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
export interface LocalLlmChatModelSelection extends ModelPackSelection {
  promptFormat: ChatModelPromptFormat;
}

/**
 * The best INSTALLED Gemma instruct model pack whose GGUF is actually on
 * disk, or undefined if none — same semantics as
 * {@link pickInstalledLocalLlmModel}, for the `local-llm-chat-model` packs.
 * With several installed (say Gemma 3 4B + 12B and Gemma 4 12B + 26B), the most
 * capable one this machine can run wins, and its prompt grammar comes with it.
 */
export async function pickInstalledLocalLlmChatModel(
  store: EnginePackStore,
  profile?: SystemProfile,
  preferred?: string,
): Promise<LocalLlmChatModelSelection | undefined> {
  const picked = await pickRankedModelPack(store, LOCAL_LLM_CHAT_MODEL_PACKS, profile, preferred);
  if (!picked) return undefined;
  const promptFormat = CHAT_MODEL_PROMPT_FORMATS[picked.packId as (typeof LOCAL_LLM_CHAT_MODEL_PACKS)[number]];
  return { ...picked, promptFormat };
}

/**
 * Which installed pack the app actually USES for each function, for every
 * family where more than one is installed.
 *
 * Installing Gemma 3 4B, Gemma 3 12B, Gemma 4 12B and Gemma 4 26B leaves three
 * of them idle — without this the Settings screen shows four identical
 * "Installed" rows and no way to tell which one runs. Only families with a real
 * choice are reported (one installed pack needs no explanation).
 */
export async function resolveActivePackSelections(
  store: EnginePackStore,
  profile?: SystemProfile,
  preferred: LocalModelPreferences = {},
): Promise<ActivePackSelection[]> {
  const out: ActivePackSelection[] = [];

  for (const [providerId, pick, choice] of [
    ['local-llm-model', pickInstalledLocalLlmModel, preferred.translation],
    ['local-llm-chat-model', pickInstalledLocalLlmChatModel, preferred.chat],
  ] as const) {
    const installedInFamily = await installedIdsFor(store, providerId);
    if (installedInFamily.length < 2) continue;
    const chosen = await pick(store, profile, choice);
    if (!chosen) continue;
    out.push({
      providerId,
      packId: chosen.packId,
      ...(chosen.skipped ? { note: chosen.skipped.reason } : {}),
      ...(chosen.chosenByUser ? { chosenByUser: true } : {}),
    });
  }

  // Runtime/binary families (llama.cpp, whisper.cpp, and VieNeu's CPU and GPU
  // builds): the best ACCELERATOR build installed wins, via the same resolution
  // the providers use.
  for (const providerId of ['local-llm', 'whisper-cpp', 'neural-tts', 'vieneu-tts']) {
    const installedInFamily = await installedIdsFor(store, providerId);
    if (installedInFamily.length < 2) continue;
    const packId = await pickInstalledPack(store, providerId);
    if (packId) out.push({ providerId, packId });
  }

  return out;
}

/** Installed pack ids belonging to one provider family. */
async function installedIdsFor(store: EnginePackStore, providerId: string): Promise<string[]> {
  const installed = await store.list();
  return installed.filter((rec) => findPack(rec.id)?.providerId === providerId).map((rec) => rec.id);
}

/** Resolve the best installed chat model, or throw ENGINE_PACK_MISSING. */
export async function resolveLocalLlmChatModel(
  store: EnginePackStore,
  profile?: SystemProfile,
  preferred?: string,
): Promise<LocalLlmChatModelSelection> {
  const found = await pickInstalledLocalLlmChatModel(store, profile, preferred);
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

// --------------------------------------------------------------------------
// whisper.cpp speech models (the `whisper-cpp-model` packs)
// --------------------------------------------------------------------------

/**
 * The model pack whisper.cpp needs for a project's speech model, keyed by the
 * ids the model picker offers. Unlike TranslateGemma there is no "best
 * installed" pick: the project names its model, and running a different size
 * would hand the user a transcript they did not choose.
 */
const WHISPER_CPP_MODEL_PACKS: Readonly<Record<string, string>> = {
  tiny: 'whisper-model-tiny',
  base: 'whisper-model-base',
  small: 'whisper-model-small',
  medium: 'whisper-model-medium',
  'large-v3': 'whisper-model-large-v3',
  'large-v3-turbo': 'whisper-model-large-v3-turbo',
  turbo: 'whisper-model-large-v3-turbo',
};

/** Where whisper.cpp problems are explained, for the user and for support. */
export const WHISPER_CPP_DOCS_REF = 'docs/TROUBLESHOOTING.md#whispercpp-needs-its-speech-model';

/**
 * The whisper.cpp model pack for `sttModel`, or undefined when that model has
 * no whisper.cpp build (PhoWhisper and distil-large-v3.5 exist only for
 * faster-whisper).
 */
export function whisperCppModelPackFor(sttModel: string): string | undefined {
  return WHISPER_CPP_MODEL_PACKS[sttModel.trim()];
}

/** Why whisper.cpp cannot run `sttModel` at all — no download fixes this. */
export function whisperCppUnsupportedModelError(sttModel: string): AppErrorException {
  return new AppErrorException('STT_MODEL_MISSING', `whisper.cpp cannot run the "${sttModel}" speech model.`, {
    remediation:
      `"${sttModel}" exists only for faster-whisper. Pick large-v3-turbo (or another standard Whisper size) as this ` +
      'project’s speech model, or switch its speech-to-text back to faster-whisper.',
    docsRef: WHISPER_CPP_DOCS_REF,
  });
}

/**
 * The absolute path of the ggml file whisper.cpp must load for `sttModel`.
 * Throws when the model has no whisper.cpp build, or when its pack is not
 * installed (or is a half-finished download with no model file).
 */
export async function resolveWhisperCppModel(store: EnginePackStore, sttModel: string): Promise<string> {
  const packId = whisperCppModelPackFor(sttModel);
  if (!packId) throw whisperCppUnsupportedModelError(sttModel);
  const rec = await store.get(packId);
  const modelPath = rec ? path.join(rec.path, WHISPER_CPP_MODEL_FILE) : undefined;
  if (modelPath && (await isFile(modelPath))) return modelPath;
  const pack = findPack(packId);
  throw new AppErrorException('ENGINE_PACK_MISSING', `whisper.cpp needs the "${sttModel}" speech model, which is not installed.`, {
    remediation:
      `Install "${pack?.displayName ?? packId}" in Settings → Engines (it also starts downloading by itself when you ` +
      'press Start), or switch this project’s speech-to-text to faster-whisper.',
    docsRef: WHISPER_CPP_DOCS_REF,
  });
}
