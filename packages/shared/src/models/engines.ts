/**
 * Engine packs — the delivery mechanism for heavy, optional on-device engines.
 *
 * The base installer stays small (faster-whisper CPU, Argos, Piper, ffmpeg).
 * Everything resource-intensive — Metal/CUDA Whisper binaries, local LLM
 * servers, neural TTS, vocal separation, forced alignment — ships as a
 * downloadable **engine pack**: a platform/arch-specific bundle of binaries
 * and/or a managed Python environment that the orchestrator fetches on demand,
 * verifies, and spawns. This mirrors how ML models already download on first
 * run, and keeps the app installer lean while letting capable machines opt into
 * the best available engines.
 *
 * See docs/TECH_STACK_RESEARCH.md for the rationale and the per-tier matrix.
 */

import type { AppError } from '../errors.js';

/** The pipeline capability an engine pack provides. */
export type EngineKind = 'stt' | 'translation' | 'tts' | 'separation' | 'alignment';

/**
 * How a pack is delivered/run:
 * - `binary`     — one or more native executables (e.g. whisper.cpp, llama.cpp,
 *                  rubberband); spawned directly like ffmpeg.
 * - `python-uv`  — a self-contained uv-managed Python environment (the ComfyUI
 *                  Desktop model) for torch/MLX engines that don't freeze well;
 *                  spawned as `<venv>/bin/python -m <module>`.
 * - `model`      — weights only, consumed by an already-installed engine
 *                  (e.g. a GGUF for llama.cpp, a voice model for a TTS pack).
 */
export type EnginePackKind = 'binary' | 'python-uv' | 'model';

/** Hardware acceleration a pack build targets. */
export type EngineAccel = 'cpu' | 'metal' | 'coreml' | 'cuda' | 'vulkan' | 'mps';

/** A single downloadable file within a pack (archive or loose file). */
export interface EnginePackArtifact {
  /** Download URL. */
  url: string;
  /** SHA-256 checksum (hex) for integrity verification. Empty = unverified. */
  sha256?: string;
  /** Approximate download size in MB (for the UI). */
  approxSizeMb: number;
  /** Path within the pack dir to extract/write to (relative). */
  destPath: string;
  /** If true, the artifact is a .tar.gz/.zip to extract; else written as-is. */
  archive?: boolean;
}

/**
 * A curated engine pack: the unit the user installs. One logical engine may
 * have several packs (one per platform/arch/accel); the catalog filters to the
 * ones runnable on the current machine.
 */
export interface EnginePackInfo {
  /** Stable id, e.g. "whisper-cpp-metal", "llama-cpp-cuda", "tts-neural". */
  id: string;
  /** Which pipeline capability it serves. */
  kind: EngineKind;
  /** Delivery mechanism. */
  packKind: EnginePackKind;
  /** Human-readable name. */
  displayName: string;
  /** One-line description for the UI. */
  description: string;
  /** Provider id this pack enables (matches the provider registry). */
  providerId: string;
  /**
   * Version of the artifacts this pack ships (upstream release tag, pinned SDK
   * version, or model revision). Recorded at install time; when the catalog's
   * version later differs from an installed pack's, the UI flags an update.
   * Bump this whenever the artifact URLs / pinned deps change.
   */
  version?: string;
  /** Target OS platforms (Node `process.platform`); empty = all. */
  platforms?: NodeJS.Platform[];
  /** Target CPU architectures (Node `process.arch`); empty = all. */
  arch?: string[];
  /**
   * Specific platform+arch combinations this pack CANNOT run on, beyond the
   * coarse `platforms`/`arch` filters (which are ANDed independently and can't
   * express a combination). E.g. Intel macOS, where a required wheel (torch) has
   * no x86_64 build. A machine matching any entry is excluded.
   */
  excludePlatformArch?: { platform: NodeJS.Platform; arch: string }[];
  /** Hardware acceleration this build uses. */
  accel: EngineAccel;
  /** Files to download. */
  artifacts: EnginePackArtifact[];
  /** Total approximate size in MB. */
  approxSizeMb: number;
  /** Minimum total RAM (MB) recommended to run this engine well. */
  minRamMb?: number;
  /** Minimum dedicated VRAM (MB) for GPU packs. */
  minVramMb?: number;
  /**
   * Minimum NVIDIA driver version for a CUDA build, as the driver that shipped
   * the CUDA toolkit the artifacts are compiled against (12.4 → 551.61 on
   * Windows). Keep it in step with the toolkit in the artifact URLs.
   *
   * NVIDIA documents "minor version compatibility" — 12.x code on any r525+
   * driver — and that is exactly what makes this gate necessary rather than
   * redundant: it does NOT hold in practice for these builds, and when it
   * breaks it breaks silently. A GTX 1650 on driver 546.29 (CUDA 12.3) enumerates
   * the device, loads the model and allocates every buffer, then aborts inside
   * CUDA_CHECK the first time a real graph executes — identically for a 26B MoE
   * and a dense 12B, and identically at 4, 5 and 20 offloaded layers. Driver
   * 610.88 runs the byte-for-byte same allocation. So the failure looks like a
   * crash, never like "your driver is old", and nothing downstream can infer it.
   *
   * Deliberately a SOFT gate (see packFitsMachine / installedPacksForProvider):
   * unlike a missing GPU, the user can fix this, so the pack stays visible and
   * merely stops being recommended and preferred.
   */
  minNvidiaDriver?: string;
  /** Hardware tier this pack targets (for the recommendation engine). */
  tier?: 'balanced' | 'performance' | 'workstation';
  /** Licensing note shown before install (transparency). */
  licenseNote?: string;
  /**
   * Coarse licensing posture, so the UI can badge a pack's weights without
   * parsing {@link licenseNote}:
   *   - `permissive`            — MIT/Apache/BSD-class: commercial use, no
   *                               pass-through obligations (the default — Argos,
   *                               whisper.cpp, llama.cpp binaries, MADLAD).
   *   - `commercial-restricted` — commercial use OK BUT carries pass-through
   *                               obligations / a use policy the app must
   *                               propagate (e.g. the Gemma Terms of Use for
   *                               TranslateGemma; OpenRAIL use restrictions).
   *   - `non-commercial`        — weights are NC (e.g. CC-BY-NC): off-limits for
   *                               commercial dubbing (VieNeu v2 preset voices).
   * Omitted is treated as `permissive`.
   */
  licenseCategory?: 'permissive' | 'commercial-restricted' | 'non-commercial';
}

/** Install state of one engine pack on this machine. */
export interface InstalledEnginePack {
  id: string;
  /** Absolute path to the installed pack directory. */
  path: string;
  /** Version/etag recorded at install time (for update checks). */
  version?: string;
  /** ISO-8601 install timestamp. */
  installedAt: string;
}

/**
 * Availability of the system tools some engines rely on, so the UI can guide
 * the user (GET /engines/prerequisites).
 */
export interface EnginePrerequisites {
  /** uv (Python env manager for the neural-TTS/separation/alignment packs). */
  uv: {
    /** Usable now (bundled with the app, previously downloaded, or on PATH). */
    available: boolean;
    /** True when it's the app-bundled copy (the user installed nothing). */
    bundled: boolean;
    /**
     * Usable now OR downloadable on demand: the install flow fetches our
     * pinned, checksum-verified uv as its first step. Gate the Install button
     * on THIS, not `available` — otherwise a dev/source build shows a dead end
     * for something the app can fix itself. Optional for wire-compat with an
     * older orchestrator (treat a missing value as `available`).
     */
    obtainable?: boolean;
  };
  /** Ollama daemon for the optional `ollama` local-LLM translation provider. */
  ollama: {
    /** The daemon answered at its local API. */
    available: boolean;
  };
}

/**
 * Which installed pack the app USES for a function that several installed packs
 * could serve (e.g. four Gemma chat models). Reported only for families with
 * more than one installed pack — otherwise there is nothing to explain.
 */
export interface ActivePackSelection {
  /** The function/family (catalog `providerId`), e.g. `local-llm-chat-model`. */
  providerId: string;
  /** The pack actually used — the most capable one this machine can run. */
  packId: string;
  /** Why a MORE capable installed pack was passed over (memory, usually). */
  note?: string;
}

/** GET /engines response: catalog (runnable on this machine) + installed set. */
export interface EnginesResponse {
  /** Packs whose platform/arch match the current machine. */
  available: EnginePackInfo[];
  /** Packs currently installed. */
  installed: InstalledEnginePack[];
  /** Ids of installed packs whose catalog version is newer than what's installed
   * (an update is available — reinstall to get it). */
  updatable: string[];
  /** Per-function winner when several installed packs compete (see above). */
  activeSelections?: ActivePackSelection[];
}

/** Body for POST /engines/install. */
export interface EnginePackInstallRequest {
  /** Engine pack id to install. */
  packId: string;
}

/** Body for POST /engines/uninstall. */
export interface EnginePackUninstallRequest {
  packId: string;
}

/**
 * SSE event streamed over GET /engines/events while a pack installs.
 * Mirrors the model-install SSE style (discriminated on `type`).
 */
export type EngineInstallEvent =
  | { type: 'progress'; packId: string; percent: number | null; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'done'; packId: string; installed: InstalledEnginePack }
  | { type: 'error'; packId: string; error: AppError };

// ---- Storage management (Settings → free up disk space) --------------------

/** A deletable, re-downloadable category of app-managed disk. */
export type StorageCategory = 'engines' | 'models' | 'cache';

/** One measured storage location the app owns. */
export interface StorageLocation {
  /** Stable key (also the clear-request flag). */
  key: StorageCategory;
  /** Human-readable label for the UI. */
  label: string;
  /** Absolute path on disk. */
  path: string;
  /** Total size in bytes (0 if the directory is missing). */
  bytes: number;
}

/** GET /storage — the app's deletable on-disk footprint. */
export interface StorageInfo {
  /** App data root (the folder "Open folder" reveals). */
  root: string;
  /** Per-category sizes: engine packs, downloaded models, caches. */
  locations: StorageLocation[];
  /** Sum of all locations (bytes). */
  totalBytes: number;
  /** Free disk space at the root (bytes), or null if the platform can't report it. */
  freeBytes: number | null;
  /** Number of installed engine packs (for the confirmation copy). */
  installedEnginePacks: number;
}

/** POST /storage/clear body. An omitted/true flag clears that category (default: all). */
export interface StorageClearRequest {
  engines?: boolean;
  models?: boolean;
  cache?: boolean;
}

/** POST /storage/clear result. */
export interface StorageClearResult {
  ok: true;
  /** Best-effort bytes freed (measured before deletion). */
  freedBytes: number;
  /** Categories that were actually cleared. */
  cleared: StorageCategory[];
}

// ---------------------------------------------------------------------------
// NVIDIA driver gate
//
// Lives in shared because BOTH sides need the same answer: the orchestrator to
// decide what to recommend and which installed runtime to prefer, and the
// desktop UI to explain why a pack is badged. Two copies of a version compare
// would drift, and this one decides whether a user is told to update a driver
// or to buy RAM.
// ---------------------------------------------------------------------------

/**
 * Compare dotted numeric versions ("546.29" vs "551.61", "550.54.14"), like a
 * comparator. Segment-wise and numeric, so "9.99" correctly loses to "551.61"
 * (a lexicographic compare gets that backwards). A non-numeric segment counts
 * as 0, degrading a surprising vendor string to "equal" rather than "too old".
 */
export function compareDriverVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10);
    const nb = Number.parseInt(pb[i] ?? '0', 10);
    const d = (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** GPU marketing names that indicate an NVIDIA (CUDA-capable) GPU. */
export const NVIDIA_GPU_RE = /nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i;

/**
 * The machine's NVIDIA driver version when it is OLDER than `pack` requires,
 * else undefined. Undefined therefore means "fine, or unknowable" — callers get
 * the string precisely when they can say something true and specific about it.
 *
 * FAILS OPEN by design: GPU detection is best-effort, so an undetectable driver
 * must read as "don't judge". Wrongly hiding a working CUDA build from the user
 * who most wants it is worse than one failed start that the runtime fallback
 * already survives.
 */
export function outdatedNvidiaDriver(
  pack: Pick<EnginePackInfo, 'minNvidiaDriver'>,
  gpus: readonly { name: string; driverVersion?: string }[],
): string | undefined {
  const required = pack.minNvidiaDriver;
  if (!required) return undefined;
  const detected = gpus
    .filter((g) => NVIDIA_GPU_RE.test(g.name))
    .map((g) => g.driverVersion)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (detected.length === 0) return undefined; // unknown — see above
  // One new-enough GPU is enough: CUDA picks a single device, and llama.cpp
  // takes the best one rather than every one.
  if (detected.some((v) => compareDriverVersions(v, required) >= 0)) return undefined;
  // Report the newest driver present — the one the runtime would actually use.
  return [...detected].sort(compareDriverVersions).at(-1);
}

// ---------------------------------------------------------------------------
// GPU memory budget
//
// "Prefer the GPU" is only useful if what we put on it actually fits. A model
// whose weights spill to system RAM runs at CPU speed no matter which backend
// won selection — measured on a GTX 1650, a 14.6 GB MoE placed 13.9 GB in
// CPU_Mapped and 1.75 GB on the device, and CUDA and Vulkan were within 7% of
// each other because neither was doing much of the work.
//
// Shared with the desktop UI so the recommendation and the badge explaining it
// can never disagree.
// ---------------------------------------------------------------------------

/** The hardware facts the budget depends on. `SystemProfile` satisfies this. */
export interface GpuBudgetInput {
  gpus: readonly { name: string; vramMb?: number }[];
  appleSilicon: boolean;
  totalRamMb: number;
}

/**
 * Share of a DISCRETE card's VRAM that model weights can realistically claim.
 *
 * Not 1.0, and not a guess: on a 4096 MiB GTX 1650 the desktop already held
 * ~790 MiB before we started, and of the ~3300 MiB llama.cpp could see it spent
 * 1750 on weights, 668 on the KV cache, 325 on the compute buffer and kept 566
 * in reserve. Weights got 43% of the card. Rounded up slightly because that run
 * also carried an 8192-token context, which is our upper bound rather than
 * typical.
 */
const DISCRETE_WEIGHT_SHARE = 0.45;

/**
 * Share of UNIFIED memory that model weights can claim on Apple Silicon.
 *
 * Higher than the discrete share — there is no separate VRAM pool to leave room
 * in — but well under Metal's ~75% working-set limit, because on a unified
 * machine the OS, the app and the same model's KV cache are all competing for
 * the number we are dividing up.
 */
const UNIFIED_WEIGHT_SHARE = 0.5;

/**
 * How many MB of GPU-resident model weights this machine can carry, or 0 when
 * there is no usable GPU (so callers fall back to a CPU-tier choice).
 *
 * A GPU whose VRAM we could not detect returns 0 rather than a guess: an
 * invented budget would silently pick a model on evidence we do not have.
 */
export function gpuWeightBudgetMb(profile: GpuBudgetInput): number {
  if (profile.appleSilicon) return Math.floor(profile.totalRamMb * UNIFIED_WEIGHT_SHARE);
  const vram = Math.max(0, ...profile.gpus.map((g) => g.vramMb ?? 0));
  return vram > 0 ? Math.floor(vram * DISCRETE_WEIGHT_SHARE) : 0;
}

/**
 * Fraction (0..1) of a model's weights that would sit on the GPU. 0 means no
 * usable GPU; 1 means it fits entirely.
 */
export function gpuResidentFraction(sizeMb: number, profile: GpuBudgetInput): number {
  if (!(sizeMb > 0)) return 0;
  const budget = gpuWeightBudgetMb(profile);
  return budget <= 0 ? 0 : Math.min(1, budget / sizeMb);
}

/**
 * The floor for recommending a model on a GPU machine: below this the GPU is a
 * bystander and a smaller model is genuinely faster end to end, so we step down
 * rather than recommend something the card cannot carry.
 *
 * Deliberately a RECOMMENDATION rule, never a restriction — an oversized model
 * stays visible and installable, exactly like the CUDA pack below its driver
 * floor. Users with a reason to prefer quality over speed keep that choice.
 */
export const MIN_GPU_RESIDENT_FRACTION = 0.6;
