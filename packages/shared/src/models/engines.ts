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
  /** Hardware tier this pack targets (for the recommendation engine). */
  tier?: 'balanced' | 'performance' | 'workstation';
  /** Licensing note shown before install (transparency). */
  licenseNote?: string;
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
    /** Usable now (bundled with the app, or installed on PATH). */
    available: boolean;
    /** True when it's the app-bundled copy (the user installed nothing). */
    bundled: boolean;
  };
  /** Ollama daemon for the optional `ollama` local-LLM translation provider. */
  ollama: {
    /** The daemon answered at its local API. */
    available: boolean;
  };
}

/** GET /engines response: catalog (runnable on this machine) + installed set. */
export interface EnginesResponse {
  /** Packs whose platform/arch match the current machine. */
  available: EnginePackInfo[];
  /** Packs currently installed. */
  installed: InstalledEnginePack[];
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
