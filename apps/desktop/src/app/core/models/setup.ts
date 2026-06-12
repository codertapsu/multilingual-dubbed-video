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
  /** Quality tier — x_low < low < medium < high (when known). */
  quality?: 'x_low' | 'low' | 'medium' | 'high';
  /** Speaker count; >1 needs a speaker index the dub doesn't pass, so avoid as a default. */
  numSpeakers?: number;
  /** Raw Piper language code, e.g. "vi_VN" (for grouping/labels). */
  languageCode?: string;
  /** True for the curated default voice for its language (shown first). */
  recommended?: boolean;
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

/** Default per-phase providers applied to NEW projects. */
export interface ProviderDefaults {
  sttProviderId?: string;
  translationProviderId?: string;
  ttsProviderId?: string;
  sttModel?: string;
}

/** GET/PUT /preferences -> persisted preferences. */
export interface UpdatePreferences {
  autoUpdate: boolean;
  providerDefaults?: ProviderDefaults;
}

// ---------------------------------------------------------------------------
// Cloud services, credentials, providers, system profile (mirror shared)
// ---------------------------------------------------------------------------

/** Cloud AI services the app can call directly (per-phase, opt-in). */
export type CloudServiceId = 'openai' | 'anthropic' | 'gemini';

/** Masked, display-safe state of one cloud service's credentials. */
export interface CloudCredentialInfo {
  service: CloudServiceId;
  configured: boolean;
  maskedKey?: string;
  fromEnv?: boolean;
  baseUrl?: string;
  model?: string;
}

/** PUT /credentials body. */
export interface SaveCredentialRequest {
  service: CloudServiceId;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}

/** POST /credentials/test result. */
export interface CredentialTestResult {
  service: CloudServiceId;
  ok: boolean;
  detail: string;
}

/** Why a provider is (not) ready — mirrors the orchestrator readiness contract. */
export type ProviderReadinessStatus =
  | 'ready'
  | 'cloud-key-missing'
  | 'engine-pack-missing'
  | 'daemon-unreachable'
  | 'model-missing';

/** A one-click affordance that would make a not-ready provider ready. */
export interface ProviderReadinessAction {
  kind: 'install-pack' | 'pull-ollama-model' | 'open-credentials' | 'guide';
  ref?: string;
}

/** One selectable provider for a pipeline phase (GET /providers). */
export interface ProviderInfo {
  id: string;
  displayName: string;
  isLocal: boolean;
  credentialService?: CloudServiceId;
  available: boolean;
  /** Readiness verdict + remediation, so the UI can disable + explain + offer a fix. */
  readinessStatus?: ProviderReadinessStatus;
  remediation?: string;
  action?: ProviderReadinessAction;
}

/** GET /providers response. */
export interface ProvidersResponse {
  stt: ProviderInfo[];
  translation: ProviderInfo[];
  tts: ProviderInfo[];
}

/** One provider's readiness for a project's run (GET /projects/:id/run-preflight). */
export interface RunPreflightProvider {
  phase: 'stt' | 'translation' | 'tts';
  providerId: string;
  status: ProviderReadinessStatus;
  ready: boolean;
  message: string;
  remediation?: string;
  action?: ProviderReadinessAction;
}

/** GET /projects/:id/run-preflight response. */
export interface RunPreflightResult {
  ok: boolean;
  providers: RunPreflightProvider[];
}

/** A detected GPU (best-effort). */
export interface GpuInfo {
  name: string;
  vramMb?: number;
}

/** GET /system -> hardware/OS profile. */
export interface SystemProfile {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  freeRamMb: number;
  gpus: GpuInfo[];
  appleSilicon: boolean;
}

/** Capability tier derived from the profile. */
export type HardwareTier = 'constrained' | 'balanced' | 'performance';

/** Hardware-aware setup recommendation. */
export interface HardwareRecommendation {
  tier: HardwareTier;
  whisperModel: string;
  suggestCloud: { stt: boolean; translation: boolean; tts: boolean };
  reasons: string[];
}

/** GET /system response envelope. */
export interface SystemProfileResponse {
  profile: SystemProfile;
  recommendation: HardwareRecommendation;
}

/** Result of `check_for_update` (tauri-plugin-updater). */
export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}
