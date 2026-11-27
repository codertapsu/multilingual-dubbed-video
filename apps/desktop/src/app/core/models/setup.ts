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

/**
 * GET /providers/argos/packages — installed pairs always; `available` (the full
 * downloadable Argos index) is populated only when called with `refresh=true`.
 */
export interface ArgosPackagesResponse {
  installed: ArgosPair[];
  available: ArgosPair[];
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
  concurrency?: ConcurrencyPreferences;
  /** Installed local model packs the user picked per job ('' = back to automatic). */
  localModels?: { translation?: string; chat?: string };
  /** What downloads do while a dub runs (Settings → Downloads). */
  downloads?: { whileDubbing?: 'auto' | 'pause-heavy' | 'one-task' | 'no-limit' };
  /** The user's voices for the leads, in order per gender (Voices → Lead voices). */
  leadVoices?: { male?: string[]; female?: string[] };
}

/** A change to the preferences: only the fields sent change, the queue settings field by field too. */
export type UpdatePreferencesChange = Partial<Omit<UpdatePreferences, 'concurrency'>> & { concurrency?: Partial<ConcurrencyPreferences> };

// ---------------------------------------------------------------------------
// Cloud services, credentials, providers, system profile (mirror shared)
// ---------------------------------------------------------------------------

/** Cloud AI services the app can call directly (per-phase, opt-in). */
export type CloudServiceId = 'openai' | 'anthropic' | 'gemini';

/** How Claude is reached: the Anthropic API key, or the user's Claude plan through Mother Claude. */
export type ClaudeConnection = 'api-key' | 'mother-claude';

/** Mother Claude's HTTP API on its default port (mirrors MOTHER_CLAUDE_DEFAULT_URL in shared). */
export const MOTHER_CLAUDE_DEFAULT_URL = 'http://127.0.0.1:5612';

/** Masked, display-safe state of one cloud service's credentials. */
export interface CloudCredentialInfo {
  service: CloudServiceId;
  /** A key is set, or (Claude) Mother Claude is chosen. */
  configured: boolean;
  /** The API key, masked. Still shown while Claude goes through Mother Claude. */
  maskedKey?: string;
  fromEnv?: boolean;
  baseUrl?: string;
  model?: string;
  /** Claude goes through Mother Claude instead of the API key. */
  via?: 'mother-claude';
  /** Claude only: Mother Claude's address, and whether a key for its HTTP API is saved (never the key). */
  motherClaude?: { url: string; keySet: boolean };
}

/** PUT /credentials body. */
export interface SaveCredentialRequest {
  service: CloudServiceId;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  /** Claude only. Switching keeps the API key saved either way. */
  via?: ClaudeConnection;
  /** Claude only: Mother Claude's Base URL; null goes back to the default. */
  motherClaudeUrl?: string | null;
  /** Claude only: the key set on Mother Claude's HTTP API; null clears it. */
  motherClaudeKey?: string | null;
}

/** GET /credentials/mother-claude: is its HTTP API running? */
export interface MotherClaudeStatus {
  url: string;
  reachable: boolean;
  /** It answered 401/403: its HTTP API has a key that is not (correctly) saved here. */
  keyRejected?: boolean;
}

/** POST /credentials/test result. */
export interface CredentialTestResult {
  service: CloudServiceId;
  ok: boolean;
  detail: string;
  /** Claude through Mother Claude: the model that answered the test message. */
  model?: string;
}

/** Why a provider is (not) ready — mirrors the orchestrator readiness contract. */
export type ProviderReadinessStatus =
  | 'ready'
  | 'cloud-key-missing'
  | 'engine-pack-missing'
  | 'daemon-unreachable'
  | 'model-missing'
  /** A local provider's bundled worker is still booting (briefly, after launch). */
  | 'worker-loading'
  | 'voice-mismatch';

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
  /** Translation providers only: can run the optional review-and-refine pass. */
  supportsRefinement?: boolean;
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

/** GET /integrations/claude — how Claude starts VideoDubber's MCP server here. */
/**
 * Claude Code's view of VideoDubber (orchestrator integrations/claude.ts):
 * connected; not connected; `other-copy` = our name points to another copy of
 * VideoDubber (a reinstall or move); `unreadable` = its .claude.json could not
 * be read; `cli-missing` = no entry, and no `claude` CLI found to make one.
 */
export type ClaudeCodeState = 'connected' | 'not-connected' | 'other-copy' | 'unreadable' | 'cli-missing';

export interface ClaudeIntegration {
  /** The command a client runs (this app's binary + `--mcp`), or null if this build cannot. */
  mcp: { command: string; args: string[] } | null;
  claudeCode: {
    state: ClaudeCodeState;
    /** The one-line `claude mcp add …`, for doing it by hand. */
    command: string;
    /** The CLI the buttons run, or null when Claude Code was not found. */
    cli: string | null;
    configPath: string;
    /** What our name points to now, when it is not this app. */
    registered: { command: string; args: string[] } | null;
    detail?: string;
  } | null;
  claudeDesktop: { installed: boolean; configPath: string | null; connected: boolean };
  /** Mother Claude (it starts Claude Code sessions, so it uses the Claude Code connection). */
  motherClaude: { running: boolean; version: string | null };
}

/** What the Claude Code buttons do. */
export type ClaudeCodeAction = 'connect' | 'reconnect' | 'disconnect';

/** A detected GPU (best-effort). */
export interface GpuInfo {
  name: string;
  vramMb?: number;
  /** Vendor driver version when detectable (NVIDIA, via nvidia-smi), e.g. "551.61". */
  driverVersion?: string;
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
  /** Whether the GPU probe ran. 'failed' = "could not tell", not "has none". */
  gpuProbe?: 'ok' | 'failed';
  appleSilicon: boolean;
}

/** Capability tier derived from the profile. */
export type HardwareTier = 'constrained' | 'balanced' | 'performance';

/** Hardware-aware setup recommendation. */
export interface HardwareRecommendation {
  tier: HardwareTier;
  whisperModel: string;
  suggestCloud: { stt: boolean; translation: boolean; tts: boolean };
  reasons: { key: string; params?: Record<string, string | number> }[];
}

/** How many dubs this machine should run at once (mirrors the shared type). */
export interface CapacityRecommendation {
  maxProjects: number;
  budgetPoints: number;
  heavyLanes: 1;
  cpuSlots: number;
  ramSlots: number;
  hardCapped: boolean;
  reasons: { key: string; params?: Record<string, string | number> }[];
}

/** GET /system response envelope. */
export interface SystemProfileResponse {
  profile: SystemProfile;
  recommendation: HardwareRecommendation;
  capacity: CapacityRecommendation;
}

/** User control over simultaneous dubbing runs (persisted in preferences). */
export interface ConcurrencyPreferences {
  mode: 'auto' | 'manual';
  maxProjects?: number;
  paused?: boolean;
  /** Dubs take turns on the graphics card (default on). */
  shareGpu?: boolean;
}

/** Why a queued project has not started yet. */
export type QueueReason = 'no-slot' | 'heavy-busy' | 'paused' | 'pressure' | 'gpu-hold' | 'gpu-turns';

/** One project waiting for a run slot. */
export interface QueueEntry {
  projectId: string;
  name: string;
  position: number;
  reason: QueueReason;
  message: string;
  /** For `gpu-hold`: the app holding the graphics card ("Voice Mask"). */
  heldBy?: string;
}

/** Another app's live hold on the graphics card (Voice Mask's live sessions). */
export interface GpuHold {
  holdId: string;
  holder: string;
  /** Its name on the screens ("Voice Mask"). */
  name: string;
  expiresAt: string;
}

/** A currently-executing run. */
export interface RunningEntry {
  projectId: string;
  name: string;
  heavy: boolean;
  /** The graphics card for this run now: using it, or waiting for its turn (behind `gpuWaitFor`). */
  gpu?: 'using' | 'waiting';
  gpuWaitSince?: string;
  gpuWaitFor?: string;
}

/** GET /queue — the live scheduler state. */
export interface QueueState {
  maxProjects: number;
  budgetPoints: number;
  usedPoints: number;
  paused: boolean;
  running: RunningEntry[];
  entries: QueueEntry[];
  capacity: CapacityRecommendation;
  /** Other apps' live holds on the graphics card: new dubs that need it wait. */
  holds?: GpuHold[];
  /** Dubs take turns on the graphics card (ConcurrencyPreferences.shareGpu). */
  shareGpu?: boolean;
}

/** Result of `check_for_update` (tauri-plugin-updater). */
export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

/**
 * How far an app update is (`update_status` / the `update-status` event,
 * src-tauri/src/update.rs). `ready`: downloaded and verified, not installed
 * because a dub started meanwhile.
 */
export interface UpdateStatus {
  phase: 'idle' | 'downloading' | 'ready' | 'installing' | 'failed';
  version: string | null;
  downloaded: number;
  total: number | null;
  bytesPerSecond: number | null;
  error: string | null;
  /** Started by the background update at launch, not by a button. */
  auto: boolean;
}

/** What the last update attempt came to, read once at launch (`update_outcome`). */
export interface UpdateOutcome {
  outcome: 'updated' | 'failed';
  from: string;
  to: string;
  at?: string;
}
