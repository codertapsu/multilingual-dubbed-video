/**
 * First-run setup, model-management, and auto-update types.
 *
 * These describe the contract between the orchestrator's `/setup/*` and
 * `/preferences` endpoints, the Tauri shell, and the Angular onboarding wizard
 * / settings screen. The AI models are language-dependent and large, so they
 * are NOT bundled in the installer — they are downloaded on first run via these
 * APIs.
 *
 * All symbols are re-exported from `@videodubber/shared`.
 */

import type { AppError } from '../errors.js';
import type { LanguageCode } from './domain.js';
import type { CommonLanguage } from '../language/normalize.js';

// ---------------------------------------------------------------------------
// Preflight (self-check)
// ---------------------------------------------------------------------------

/** A single environment self-check shown in the onboarding wizard. */
export interface PreflightCheck {
  /** Stable id, e.g. "ffmpeg", "stt-worker", "network", "disk". */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Outcome severity. */
  status: 'ok' | 'warn' | 'fail';
  /** Optional detail string (e.g. the version found, or the failure reason). */
  detail?: string;
  /** Optional remediation hint for a warn/fail. */
  remediation?: string;
}

/** Aggregate result of all preflight checks. */
export interface PreflightResult {
  /** True when no check has status "fail". */
  ok: boolean;
  /** The ordered list of individual checks. */
  checks: PreflightCheck[];
}

// ---------------------------------------------------------------------------
// Catalog (downloadable models)
// ---------------------------------------------------------------------------

/** A curated faster-whisper STT model the user may download. */
export interface WhisperModelInfo {
  /** faster-whisper model id, e.g. "base", "large-v3". */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Approximate on-disk size in megabytes. */
  approxSizeMb: number;
  /** Whether this is the recommended default selection. */
  recommended?: boolean;
}

/** A downloadable Piper TTS voice and where to fetch it. */
export interface PiperVoiceInfo {
  /** Voice id, e.g. "vi_VN-vais1000-medium". */
  id: string;
  /** Language this voice speaks. */
  language: LanguageCode;
  /** Human-readable label for the UI. */
  label: string;
  /** Approximate combined size (.onnx + .onnx.json) in megabytes. */
  approxSizeMb: number;
  /** URL of the `.onnx` model file. */
  url: string;
  /** URL of the `.onnx.json` config file. */
  configUrl: string;
}

/** A directed Argos Translate language pair (from -> to). */
export interface ArgosPair {
  /** Source language code. */
  from: LanguageCode;
  /** Target language code. */
  to: LanguageCode;
}

/** Everything the first-run wizard needs to let the user pick what to install. */
export interface SetupCatalog {
  /** Curated whisper models (tiny..large-v3) with one recommended. */
  whisperModels: WhisperModelInfo[];
  /** Common languages for the source/target pickers. */
  languages: CommonLanguage[];
  /** Curated Argos pairs known to be downloadable (e.g. en->vi). */
  argosAvailable: ArgosPair[];
  /** Curated Piper voices (incl. vi_VN-vais1000-medium). */
  piperVoices: PiperVoiceInfo[];
}

// ---------------------------------------------------------------------------
// Installed state
// ---------------------------------------------------------------------------

/** The set of models currently installed on this machine. */
export interface InstalledModels {
  /** Installed whisper model ids. */
  whisperModels: string[];
  /** Installed Argos translation pairs. */
  argosPairs: ArgosPair[];
  /** Installed Piper voice ids. */
  piperVoices: string[];
}

/** Persisted first-run state (`<config>/setup.json`). */
export interface SetupStatus {
  /** True once the user has completed the first-run wizard. */
  firstRunComplete: boolean;
  /** The models known to be installed. */
  installed: InstalledModels;
}

/** Body for POST /setup/install — what the user chose to download. */
export interface SetupInstallRequest {
  /** Whisper model id to ensure (download into the HF cache). */
  whisperModel?: string;
  /** Argos pairs to ensure (download + install). */
  argosPairs?: ArgosPair[];
  /** Piper voice ids to download into the models dir. */
  piperVoices?: string[];
}

/**
 * An event streamed over `GET /setup/events` (SSE) while an install runs.
 *
 * Mirrors the pipeline SSE style: a discriminated union on `type`.
 */
export type SetupEvent =
  | { type: 'progress'; item: string; percent: number | null; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'item-done'; item: string }
  | { type: 'done'; status: SetupStatus }
  | { type: 'error'; error: AppError };

// ---------------------------------------------------------------------------
// Update preferences / info
// ---------------------------------------------------------------------------

/** Persisted user preference for auto-update behavior. */
export interface UpdatePreferences {
  /** When true, the desktop app installs updates automatically. */
  autoUpdate: boolean;
}

/** Result of an update check via the Tauri updater plugin. */
export interface UpdateInfo {
  /** Whether a newer release is available. */
  available: boolean;
  /** The available version (when `available` is true). */
  version?: string;
  /** The currently-installed app version. */
  currentVersion: string;
  /** Release notes for the available version. */
  notes?: string;
  /** Release date (ISO-8601) of the available version. */
  date?: string;
}
