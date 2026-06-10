/**
 * First-run setup + auto-update view models.
 *
 * These mirror the SHARED setup contract (`@videodubber/shared`) but live here
 * in `core/models` so the UI keeps a single transport-facing seam (matching the
 * pattern in {@link ./view-models.ts}). They describe the JSON shapes returned
 * by the orchestrator's `/setup/*` and `/preferences` endpoints and the Tauri
 * updater commands. Keep them byte-compatible with the shared types — if the
 * shared package starts exporting them, these can be replaced with re-exports.
 */
import type { AppError, LanguageCode } from './index';

/** A single preflight self-check result. */
export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  remediation?: string;
}

/** GET /setup/preflight -> overall ok flag + the individual checks. */
export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/** A curated Whisper model offered in the onboarding catalog. */
export interface WhisperModelInfo {
  id: string;
  label: string;
  approxSizeMb: number;
  recommended?: boolean;
}

/** A downloadable Piper TTS voice. */
export interface PiperVoiceInfo {
  id: string;
  language: LanguageCode;
  label: string;
  approxSizeMb: number;
  url: string;
  configUrl: string;
}

/** A from -> to Argos translation pair. */
export interface ArgosPair {
  from: LanguageCode;
  to: LanguageCode;
}

/** A curated common language entry (code + human label). */
export interface CommonLanguage {
  code: LanguageCode;
  label: string;
}

/** GET /setup/catalog -> everything the wizard offers to install. */
export interface SetupCatalog {
  whisperModels: WhisperModelInfo[];
  languages: CommonLanguage[];
  argosAvailable: ArgosPair[];
  piperVoices: PiperVoiceInfo[];
}

/** What is already installed on this machine. */
export interface InstalledModels {
  whisperModels: string[];
  argosPairs: ArgosPair[];
  piperVoices: string[];
}

/** GET /setup/status -> first-run flag + installed inventory. */
export interface SetupStatus {
  firstRunComplete: boolean;
  installed: InstalledModels;
}

/** POST /setup/install body — what the user chose to fetch. */
export interface SetupInstallRequest {
  whisperModel?: string;
  argosPairs?: ArgosPair[];
  piperVoices?: string[];
}

/** Discriminated union streamed over GET /setup/events (SSE). */
export type SetupEvent =
  | { type: 'progress'; item: string; percent: number | null; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'item-done'; item: string }
  | { type: 'done'; status: SetupStatus }
  | { type: 'error'; error: AppError };

/** GET/PUT /preferences -> the auto-update preference. */
export interface UpdatePreferences {
  autoUpdate: boolean;
}

/** Result of `check_for_update` (tauri-plugin-updater). */
export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}
