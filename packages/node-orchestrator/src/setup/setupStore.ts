/**
 * Persistence for first-run setup state and update preferences.
 *
 * Owns two files in the app config directory:
 *   - `<configDir>/setup.json`       -> {@link SetupStatus}
 *   - `<configDir>/preferences.json` -> {@link UpdatePreferences}
 *
 * Both are written atomically (temp file + rename within the same directory) so
 * a crash mid-write can never corrupt them. Reads tolerate a missing or
 * malformed file by returning a sensible default.
 *
 * This is the source of truth the UI reads; the Tauri shell may keep its own
 * mirror of `autoUpdate`, but the orchestrator file wins.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ArgosPair,
  InstalledModels,
  SetupStatus,
  UpdatePreferences,
} from '@videodubber/shared';

/** The empty installed-models state (nothing downloaded yet). */
export function emptyInstalledModels(): InstalledModels {
  return { whisperModels: [], argosPairs: [], piperVoices: [] };
}

/** The default first-run state: incomplete, nothing installed. */
export function defaultSetupStatus(): SetupStatus {
  return { firstRunComplete: false, installed: emptyInstalledModels() };
}

/** The default update preferences: auto-update enabled. */
export function defaultPreferences(): UpdatePreferences {
  return { autoUpdate: true };
}

/** Write JSON atomically: temp file + rename within the same directory. */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, filePath);
}

/** Read and parse a JSON file, or return undefined if missing/unreadable. */
async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    // Malformed JSON: treat as missing rather than crashing the server.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** True if two Argos pairs are equal (case-sensitive on the stored codes). */
function pairsEqual(a: ArgosPair, b: ArgosPair): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * Store for first-run setup state + update preferences. Stateless beyond the
 * config-dir path, so it is trivially mockable in tests via a temp directory.
 */
export class SetupStore {
  private readonly setupPath: string;
  private readonly preferencesPath: string;

  constructor(private readonly configDir: string) {
    this.setupPath = path.join(configDir, 'setup.json');
    this.preferencesPath = path.join(configDir, 'preferences.json');
  }

  // ----- setup.json --------------------------------------------------------

  /** Load setup state, defaulting to a fresh first-run state if missing. */
  async getStatus(): Promise<SetupStatus> {
    const stored = await readJson<Partial<SetupStatus>>(this.setupPath);
    if (!stored) return defaultSetupStatus();
    // Backfill any missing fields so older/partial files round-trip cleanly.
    const installed: Partial<InstalledModels> = stored.installed ?? {};
    return {
      firstRunComplete: stored.firstRunComplete === true,
      installed: {
        whisperModels: installed.whisperModels ?? [],
        argosPairs: installed.argosPairs ?? [],
        piperVoices: installed.piperVoices ?? [],
      },
    };
  }

  /** Persist the full setup state atomically. */
  async saveStatus(status: SetupStatus): Promise<void> {
    await writeJsonAtomic(this.setupPath, status);
  }

  /** Mark the first-run wizard complete (preserving the installed lists). */
  async markFirstRunComplete(): Promise<SetupStatus> {
    const current = await this.getStatus();
    const next: SetupStatus = { ...current, firstRunComplete: true };
    await this.saveStatus(next);
    return next;
  }

  /**
   * Record a newly-installed whisper model (idempotent), returning the updated
   * status. Used by the installer as each item completes.
   */
  async addWhisperModel(modelId: string): Promise<SetupStatus> {
    const current = await this.getStatus();
    if (current.installed.whisperModels.includes(modelId)) return current;
    const next: SetupStatus = {
      ...current,
      installed: {
        ...current.installed,
        whisperModels: [...current.installed.whisperModels, modelId],
      },
    };
    await this.saveStatus(next);
    return next;
  }

  /** Record a newly-installed Argos pair (idempotent). */
  async addArgosPair(pair: ArgosPair): Promise<SetupStatus> {
    const current = await this.getStatus();
    if (current.installed.argosPairs.some((p) => pairsEqual(p, pair))) return current;
    const next: SetupStatus = {
      ...current,
      installed: {
        ...current.installed,
        argosPairs: [...current.installed.argosPairs, pair],
      },
    };
    await this.saveStatus(next);
    return next;
  }

  /** Record a newly-installed Piper voice (idempotent). */
  async addPiperVoice(voiceId: string): Promise<SetupStatus> {
    const current = await this.getStatus();
    if (current.installed.piperVoices.includes(voiceId)) return current;
    const next: SetupStatus = {
      ...current,
      installed: {
        ...current.installed,
        piperVoices: [...current.installed.piperVoices, voiceId],
      },
    };
    await this.saveStatus(next);
    return next;
  }

  // ----- preferences.json --------------------------------------------------

  /** Load preferences, defaulting to auto-update enabled. */
  async getPreferences(): Promise<UpdatePreferences> {
    const stored = await readJson<Partial<UpdatePreferences>>(this.preferencesPath);
    if (!stored) return defaultPreferences();
    return {
      autoUpdate: stored.autoUpdate !== false,
      ...(stored.providerDefaults && typeof stored.providerDefaults === 'object'
        ? { providerDefaults: stored.providerDefaults }
        : {}),
    };
  }

  /** Persist preferences atomically (autoUpdate + per-phase provider defaults). */
  async savePreferences(prefs: UpdatePreferences): Promise<UpdatePreferences> {
    const next: UpdatePreferences = {
      autoUpdate: prefs.autoUpdate === true,
      ...(prefs.providerDefaults ? { providerDefaults: prefs.providerDefaults } : {}),
    };
    await writeJsonAtomic(this.preferencesPath, next);
    return next;
  }
}
