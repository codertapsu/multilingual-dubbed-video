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
// Cloud services & credentials
// ---------------------------------------------------------------------------

/**
 * Cloud AI services VideoDubber can call directly (per-phase, opt-in).
 * Each maps to one stored API key; providers reference the service they need.
 */
export type CloudServiceId = 'openai' | 'anthropic' | 'gemini';

/** All cloud service ids (for iteration in UIs and stores). */
export const ALL_CLOUD_SERVICES: readonly CloudServiceId[] = ['openai', 'anthropic', 'gemini'];

/** Masked, safe-to-display state of one cloud service's stored credentials. */
export interface CloudCredentialInfo {
  /** Which service this entry describes. */
  service: CloudServiceId;
  /** True when an API key is available (stored or via environment variable). */
  configured: boolean;
  /** Masked key for display, e.g. "sk-…h1Q4". Never the full key. */
  maskedKey?: string;
  /** True when the key comes from an environment variable, not the store. */
  fromEnv?: boolean;
  /** Optional custom base URL (e.g. an OpenAI-compatible proxy). */
  baseUrl?: string;
  /** Optional model override used by this service's providers. */
  model?: string;
}

/** Body for PUT /credentials — set/replace/clear one service's credentials. */
export interface SaveCredentialRequest {
  /** Which service to update. */
  service: CloudServiceId;
  /** New API key; null or empty string clears the stored key. */
  apiKey?: string | null;
  /** Optional custom base URL; null clears it. */
  baseUrl?: string | null;
  /** Optional model override; null clears it. */
  model?: string | null;
}

/** Result of POST /credentials/test — a live round-trip to the service. */
export interface CredentialTestResult {
  service: CloudServiceId;
  ok: boolean;
  /** Human-readable outcome (e.g. model count, or the auth error). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Providers (per-phase local/cloud engine listing)
// ---------------------------------------------------------------------------

/** A selectable provider for one pipeline phase, as listed by GET /providers. */
export interface ProviderInfo {
  /** Stable provider id (e.g. "faster-whisper", "openai-stt"). */
  id: string;
  /** Human-readable name for pickers. */
  displayName: string;
  /** True when the provider runs fully on this machine. */
  isLocal: boolean;
  /** Cloud service whose API key this provider needs (cloud providers only). */
  credentialService?: CloudServiceId;
  /** True when the provider is usable right now (local, or key configured). */
  available: boolean;
}

/** GET /providers response: selectable providers per phase. */
export interface ProvidersResponse {
  stt: ProviderInfo[];
  translation: ProviderInfo[];
  tts: ProviderInfo[];
}

// ---------------------------------------------------------------------------
// System profile & hardware-aware recommendations
// ---------------------------------------------------------------------------

/** A detected GPU (best-effort; absent on detection failure). */
export interface GpuInfo {
  /** Marketing/name string, e.g. "Apple M3 Pro", "NVIDIA GeForce RTX 4070". */
  name: string;
  /** Dedicated VRAM in MB when known (unified-memory GPUs omit this). */
  vramMb?: number;
}

/** Best-effort hardware/OS profile of this machine (GET /system). */
export interface SystemProfile {
  /** Node platform id: "darwin" | "win32" | "linux". */
  platform: string;
  /** CPU architecture, e.g. "arm64", "x64". */
  arch: string;
  /** CPU model string. */
  cpuModel: string;
  /** Logical CPU core count. */
  cpuCores: number;
  /** Total physical memory in MB. */
  totalRamMb: number;
  /** Currently free memory in MB (snapshot). */
  freeRamMb: number;
  /** Detected GPUs (may be empty when detection fails). */
  gpus: GpuInfo[];
  /** True on Apple Silicon (unified memory; fast local inference). */
  appleSilicon: boolean;
}

/** Coarse capability tier derived from the hardware profile. */
export type HardwareTier = 'constrained' | 'balanced' | 'performance';

/** Hardware-aware setup recommendation (GET /system). */
export interface HardwareRecommendation {
  /** Overall capability tier of this machine. */
  tier: HardwareTier;
  /** Recommended faster-whisper model for local STT on this machine. */
  whisperModel: string;
  /** Per-phase suggestion: true = cloud likely serves this user better. */
  suggestCloud: { stt: boolean; translation: boolean; tts: boolean };
  /** Human-readable reasons behind the recommendation. */
  reasons: string[];
}

/** GET /system response envelope. */
export interface SystemProfileResponse {
  profile: SystemProfile;
  recommendation: HardwareRecommendation;
}

// ---------------------------------------------------------------------------
// Update preferences / info
// ---------------------------------------------------------------------------

/**
 * Default provider selection applied to NEW projects (changeable per project
 * in the wizard, and at any time in Settings).
 */
export interface ProviderDefaults {
  /** Default STT provider id. */
  sttProviderId?: string;
  /** Default translation provider id. */
  translationProviderId?: string;
  /** Default TTS provider id. */
  ttsProviderId?: string;
  /** Default faster-whisper model for local STT. */
  sttModel?: string;
}

/** Persisted user preferences (`<config>/preferences.json`). */
export interface UpdatePreferences {
  /** When true, the desktop app installs updates automatically. */
  autoUpdate: boolean;
  /** Default per-phase providers for new projects. */
  providerDefaults?: ProviderDefaults;
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
