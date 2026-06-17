import type { OnDestroy, OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { IpcService } from '../../core/ipc/ipc.service';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { environment } from '../../core/environment';
import type { AppError, EnginePackInfo, EnginePrerequisites, InstalledEnginePack } from '../../core/models';
import type {
  ArgosPair,
  CloudCredentialInfo,
  CloudServiceId,
  CredentialTestResult,
  ProviderDefaults,
  ProvidersResponse,
  SystemProfileResponse,
  UpdateInfo,
} from '../../core/models/setup';

/** One row in the Translation-packs manager (a pair + resolved names + state). */
interface ArgosPackRow extends ArgosPair {
  key: string;
  installed: boolean;
  fromName: string;
  toName: string;
}

/** Outcome of the most recent "Check for updates" action. */
type CheckOutcome = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';

/** Display metadata per cloud service. */
const SERVICE_META: Record<CloudServiceId, { label: string; keyHint: string }> = {
  openai: { label: 'OpenAI (ChatGPT)', keyHint: 'sk-…  — used by cloud STT, translation and TTS' },
  anthropic: { label: 'Anthropic (Claude)', keyHint: 'sk-ant-…  — used by cloud translation' },
  gemini: { label: 'Google Gemini', keyHint: 'AIza…  — used by cloud translation' },
};

/**
 * SettingsComponent (route "settings").
 *
 * Three concerns:
 *  1. Processing setup — what this machine can handle (GET /system), the
 *     default provider per phase for new projects, and cloud API keys
 *     (masked; full keys never leave the orchestrator).
 *  2. Auto-update controls backed by tauri-plugin-updater + /preferences.
 *  3. About.
 */
@Component({
  selector: 'vd-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);

  protected readonly inTauri = this.ipc.inTauri;
  protected readonly serviceMeta = SERVICE_META;
  protected readonly services: readonly CloudServiceId[] = ['openai', 'anthropic', 'gemini'];

  protected readonly error = signal<AppError | null>(null);

  // -------- processing setup --------
  protected readonly system = signal<SystemProfileResponse | null>(null);
  protected readonly providers = signal<ProvidersResponse | null>(null);
  protected readonly credentials = signal<CloudCredentialInfo[]>([]);
  protected readonly defaults = signal<ProviderDefaults>({});
  protected readonly defaultsSaving = signal(false);
  protected readonly defaultsSaved = signal(false);

  /** Whisper model choices for the default-model picker. */
  protected readonly whisperModels: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'tiny', label: 'Tiny — fastest, lowest accuracy (~75 MB)' },
    { id: 'base', label: 'Base — balanced; good on 8 GB (~145 MB)' },
    { id: 'small', label: 'Small — better accuracy (~480 MB)' },
    { id: 'large-v3-turbo', label: 'Large v3 Turbo — recommended: near-best, 6-8x faster (~1.6 GB)' },
    { id: 'distil-large-v3.5', label: 'Distil Large v3.5 — English only, fastest large (~760 MB)' },
    { id: 'medium', label: 'Medium — high accuracy (~1.5 GB)' },
    { id: 'large-v3', label: 'Large v3 — best accuracy, slow on CPU (~3 GB)' },
    { id: 'phowhisper-medium', label: 'PhoWhisper Medium — best for Vietnamese-source audio' },
    { id: 'phowhisper-large', label: 'PhoWhisper Large — Vietnamese-source, highest accuracy' },
  ];

  // Per-service key editing state.
  protected readonly keyInputs = signal<Partial<Record<CloudServiceId, string>>>({});
  protected readonly credBusy = signal<CloudServiceId | null>(null);
  protected readonly testResults = signal<Partial<Record<CloudServiceId, CredentialTestResult>>>({});

  // -------- engine packs --------
  protected readonly enginePacks = signal<EnginePackInfo[]>([]);
  protected readonly installedEngines = signal<InstalledEnginePack[]>([]);
  protected readonly recommendedEngineIds = signal<Set<string>>(new Set());
  /** Packs this machine's hardware can run (local-first fit check). null = the
   * backend didn't report fit (older build) -> assume everything fits. */
  protected readonly engineFits = signal<Set<string> | null>(null);
  protected readonly engineProgress = signal<Record<string, { percent: number | null; message: string }>>({});
  protected readonly prerequisites = signal<EnginePrerequisites | null>(null);
  private engineEvents: EventSource | null = null;

  /** True for packs delivered as a uv-managed Python env (need uv). */
  protected needsUv(pack: EnginePackInfo): boolean {
    return pack.packKind === 'python-uv';
  }

  // -------- Argos translation packs (browse the full index + install/remove) --
  protected readonly argosInstalled = signal<ArgosPair[]>([]);
  protected readonly argosAvailable = signal<ArgosPair[]>([]);
  protected readonly argosRefreshing = signal(false);
  /** "from->to" key of the pair currently installing/removing (per-row spinner). */
  protected readonly argosBusy = signal<string | null>(null);
  protected readonly argosFilter = signal('');

  private static readonly langDisplay = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      return null;
    }
  })();

  /** Human language name for a code (e.g. "zh" -> "Chinese"); falls back to the code. */
  protected langName(code: string): string {
    try {
      return SettingsComponent.langDisplay?.of(code) ?? code;
    } catch {
      return code;
    }
  }

  private pairKey(p: ArgosPair): string {
    return `${p.from}->${p.to}`;
  }

  /** Installed ∪ available pairs as display rows (installed first, then by name),
   * filtered by the search box. Pure read — safe inside a computed. */
  protected readonly argosRows = computed<ArgosPackRow[]>(() => {
    const installedKeys = new Set(this.argosInstalled().map((p) => this.pairKey(p)));
    const byKey = new Map<string, ArgosPair>();
    for (const p of this.argosInstalled()) byKey.set(this.pairKey(p), p);
    for (const p of this.argosAvailable()) byKey.set(this.pairKey(p), p);

    const q = this.argosFilter().trim().toLowerCase();
    const rows: ArgosPackRow[] = [...byKey.values()].map((p) => ({
      ...p,
      key: this.pairKey(p),
      installed: installedKeys.has(this.pairKey(p)),
      fromName: this.langName(p.from),
      toName: this.langName(p.to),
    }));
    const filtered = q
      ? rows.filter((r) => `${r.fromName} ${r.toName} ${r.from} ${r.to}`.toLowerCase().includes(q))
      : rows;
    return filtered.sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        a.fromName.localeCompare(b.fromName) ||
        a.toName.localeCompare(b.toName),
    );
  });

  /** Load installed pairs (fast); pass `refresh` to also fetch the full index. */
  protected async loadArgosPackages(refresh = false): Promise<void> {
    if (refresh) this.argosRefreshing.set(true);
    this.error.set(null);
    try {
      const res = await this.ipc.getArgosPackages(refresh);
      this.argosInstalled.set(res.installed);
      // Only a refresh returns the index; a plain reload (after install/remove)
      // must NOT wipe the browsed list.
      if (refresh) this.argosAvailable.set(res.available);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      if (refresh) this.argosRefreshing.set(false);
    }
  }

  protected async installArgosPair(pair: ArgosPair): Promise<void> {
    const key = this.pairKey(pair);
    if (this.argosBusy()) return;
    this.argosBusy.set(key);
    this.error.set(null);
    try {
      await this.ipc.ensureArgosPackage({ from: pair.from, to: pair.to });
      await this.loadArgosPackages(false);
      void this.loadProcessingSetup(); // a newly-installed pair can flip availability
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.argosBusy.set(null);
    }
  }

  protected async removeArgosPair(pair: ArgosPair): Promise<void> {
    const key = this.pairKey(pair);
    if (this.argosBusy()) return;
    this.argosBusy.set(key);
    this.error.set(null);
    try {
      await this.ipc.removeArgosPackage({ from: pair.from, to: pair.to });
      await this.loadArgosPackages(false);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.argosBusy.set(null);
    }
  }

  protected readonly ramLabel = computed(() => {
    const profile = this.system()?.profile;
    return profile ? `${Math.round(profile.totalRamMb / 1024)} GB RAM` : '';
  });

  // -------- auto-update preference --------
  protected readonly autoUpdate = signal<boolean>(true);
  protected readonly prefLoading = signal(false);
  protected readonly prefSaving = signal(false);

  // -------- update check / install --------
  protected readonly checkOutcome = signal<CheckOutcome>('idle');
  protected readonly updateInfo = signal<UpdateInfo | null>(null);
  protected readonly installing = signal(false);

  /** Installed app version (network-free, via get_app_version in Tauri). */
  protected readonly appVersion = signal<string | null>(null);

  protected readonly updateAvailable = computed(
    () => this.updateInfo()?.available === true,
  );

  ngOnInit(): void {
    void this.loadPreference();
    void this.loadVersion();
    void this.loadProcessingSetup();
    void this.loadEngines();
    void this.loadArgosPackages(); // installed-only (fast); index loads on demand
  }

  ngOnDestroy(): void {
    this.engineEvents?.close();
    this.engineEvents = null;
  }

  // ----------------------------- engine packs -----------------------------

  private async loadEngines(): Promise<void> {
    await Promise.all([
      this.ipc
        .getEngines()
        .then((e) => {
          this.enginePacks.set(e.available);
          this.installedEngines.set(e.installed);
        })
        .catch(() => undefined),
      this.ipc
        .getRecommendedEngines()
        .then((r) => {
          this.recommendedEngineIds.set(new Set(r.recommendations.map((x) => x.packId)));
          this.engineFits.set(r.fits ? new Set(r.fits) : null);
        })
        .catch(() => undefined),
      this.ipc
        .getEnginePrerequisites()
        .then((p) => this.prerequisites.set(p))
        .catch(() => undefined),
    ]);
  }

  protected isEngineInstalled(packId: string): boolean {
    return this.installedEngines().some((i) => i.id === packId);
  }

  protected isEngineRecommended(packId: string): boolean {
    return this.recommendedEngineIds().has(packId);
  }

  /** True if this machine's hardware can run the pack (or fit is unknown). */
  protected isEngineFit(packId: string): boolean {
    const fits = this.engineFits();
    return fits === null || fits.has(packId);
  }

  /** Short "needs ~N GB RAM" hint for a pack the machine can't comfortably run. */
  protected engineRamHint(pack: EnginePackInfo): string {
    const gb = pack.minRamMb ? Math.round(pack.minRamMb / 1024) : 0;
    return gb > 0 ? `Needs ~${gb} GB RAM` : 'May be heavy for this machine';
  }

  protected engineProgressFor(packId: string): { percent: number | null; message: string } | undefined {
    return this.engineProgress()[packId];
  }

  /** Subscribe to /engines/events once; updates progress + refreshes on done. */
  private ensureEngineEvents(): void {
    if (this.engineEvents || !environment.orchestratorUrl) return;
    const es = new EventSource(`${environment.orchestratorUrl}/engines/events`);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as
          | { type: 'progress'; packId: string; percent: number | null; message: string }
          | { type: 'done'; packId: string }
          | { type: 'error'; packId: string; error: AppError }
          | { type: 'log' };
        if (event.type === 'progress') {
          this.engineProgress.update((m) => ({ ...m, [event.packId]: { percent: event.percent, message: event.message } }));
        } else if (event.type === 'done') {
          this.engineProgress.update((m) => {
            const next = { ...m };
            delete next[event.packId];
            return next;
          });
          void this.loadEngines();
          void this.loadProcessingSetup(); // availability flips once a pack lands
        } else if (event.type === 'error') {
          this.engineProgress.update((m) => {
            const next = { ...m };
            delete next[event.packId];
            return next;
          });
          this.error.set(event.error);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    this.engineEvents = es;
  }

  protected async installEngine(packId: string): Promise<void> {
    this.error.set(null);
    this.ensureEngineEvents();
    this.engineProgress.update((m) => ({ ...m, [packId]: { percent: 0, message: 'Starting…' } }));
    try {
      await this.ipc.installEngine(packId);
    } catch (err) {
      this.engineProgress.update((m) => {
        const next = { ...m };
        delete next[packId];
        return next;
      });
      this.error.set(toAppError(err));
    }
  }

  protected async uninstallEngine(packId: string): Promise<void> {
    this.error.set(null);
    try {
      await this.ipc.uninstallEngine(packId);
      await this.loadEngines();
      await this.loadProcessingSetup();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  // ----------------------------- processing setup -----------------------------

  private async loadProcessingSetup(): Promise<void> {
    // Each block is independent and non-fatal: a missing orchestrator should
    // not blank the whole Settings screen.
    await Promise.all([
      this.ipc
        .getSystemProfile()
        .then((s) => this.system.set(s))
        .catch(() => undefined),
      this.ipc
        .getProviders()
        .then((p) => this.providers.set(p))
        .catch(() => undefined),
      this.ipc
        .getCredentials()
        .then((c) => this.credentials.set(c.services))
        .catch(() => undefined),
      this.ipc
        .getAppPreferences()
        .then((prefs) => this.defaults.set(prefs.providerDefaults ?? {}))
        .catch(() => undefined),
    ]);
  }

  protected patchDefault<K extends keyof ProviderDefaults>(key: K, value: ProviderDefaults[K]): void {
    this.defaults.update((d) => ({ ...d, [key]: value }));
    this.defaultsSaved.set(false);
  }

  protected async saveDefaults(): Promise<void> {
    if (this.defaultsSaving()) return;
    this.defaultsSaving.set(true);
    this.error.set(null);
    try {
      await this.ipc.saveAppPreferences({ providerDefaults: this.defaults() });
      this.defaultsSaved.set(true);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.defaultsSaving.set(false);
    }
  }

  /** One-click: adopt the hardware-aware recommendation as the defaults. */
  protected async applyRecommended(): Promise<void> {
    const rec = this.system()?.recommendation;
    if (!rec) return;
    this.defaults.update((d) => ({
      ...d,
      sttModel: rec.whisperModel,
      // The recommendation only proposes cloud where it clearly helps; keys may
      // not be configured yet, so we keep local defaults and let the user pick
      // cloud explicitly — except the whisper model, which is always safe.
    }));
    await this.saveDefaults();
  }

  protected credentialFor(service: CloudServiceId): CloudCredentialInfo | undefined {
    return this.credentials().find((c) => c.service === service);
  }

  protected keyInputFor(service: CloudServiceId): string {
    return this.keyInputs()[service] ?? '';
  }

  protected setKeyInput(service: CloudServiceId, value: string): void {
    this.keyInputs.update((m) => ({ ...m, [service]: value }));
  }

  protected async saveKey(service: CloudServiceId): Promise<void> {
    const key = this.keyInputFor(service).trim();
    if (!key || this.credBusy()) return;
    this.credBusy.set(service);
    this.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service, apiKey: key });
      this.credentials.set(res.services);
      this.setKeyInput(service, '');
      this.testResults.update((m) => ({ ...m, [service]: undefined }));
      // Refresh availability flags on the provider pickers.
      this.providers.set(await this.ipc.getProviders().catch(() => this.providers()));
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.credBusy.set(null);
    }
  }

  protected async clearKey(service: CloudServiceId): Promise<void> {
    if (this.credBusy()) return;
    this.credBusy.set(service);
    this.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service, apiKey: null });
      this.credentials.set(res.services);
      this.testResults.update((m) => ({ ...m, [service]: undefined }));
      this.providers.set(await this.ipc.getProviders().catch(() => this.providers()));
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.credBusy.set(null);
    }
  }

  protected async testKey(service: CloudServiceId): Promise<void> {
    if (this.credBusy()) return;
    this.credBusy.set(service);
    try {
      const result = await this.ipc.testCredential(service);
      this.testResults.update((m) => ({ ...m, [service]: result }));
    } catch (err) {
      this.testResults.update((m) => ({
        ...m,
        [service]: { service, ok: false, detail: toAppError(err).message },
      }));
    } finally {
      this.credBusy.set(null);
    }
  }

  // ----------------------------- version -----------------------------

  private async loadVersion(): Promise<void> {
    try {
      this.appVersion.set(await this.ipc.getAppVersion());
    } catch {
      // Non-fatal — leave the version blank rather than showing an error.
    }
  }

  // ----------------------------- preference -----------------------------

  private async loadPreference(): Promise<void> {
    this.prefLoading.set(true);
    try {
      const pref = await this.ipc.getUpdatePreference();
      this.autoUpdate.set(pref.autoUpdate);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.prefLoading.set(false);
    }
  }

  protected async toggleAutoUpdate(value: boolean): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.autoUpdate();
    this.autoUpdate.set(value); // optimistic
    this.prefSaving.set(true);
    this.error.set(null);
    try {
      await this.ipc.setUpdatePreference({ autoUpdate: value });
    } catch (err) {
      this.autoUpdate.set(previous); // roll back on failure
      this.error.set(toAppError(err));
    } finally {
      this.prefSaving.set(false);
    }
  }

  // ----------------------------- update check -----------------------------

  protected async check(): Promise<void> {
    if (this.checkOutcome() === 'checking') return;
    this.checkOutcome.set('checking');
    this.error.set(null);
    try {
      const info = await this.ipc.checkForUpdate();
      this.updateInfo.set(info);
      this.checkOutcome.set(info.available ? 'available' : 'up-to-date');
    } catch (err) {
      this.checkOutcome.set('error');
      this.error.set(toAppError(err));
    }
  }

  protected async installUpdate(): Promise<void> {
    if (this.installing() || !this.updateAvailable()) return;
    this.installing.set(true);
    this.error.set(null);
    try {
      // On success the app relaunches; this promise typically never resolves in
      // the running window. We still clear `installing` for the edge case where
      // install completes without an immediate relaunch.
      const res = await this.ipc.downloadAndInstallUpdate();
      if (!res.ok) {
        this.installing.set(false);
      }
    } catch (err) {
      this.installing.set(false);
      this.error.set(toAppError(err));
    }
  }

  // ----------------------------- helpers -----------------------------

  protected async openReleaseNotes(): Promise<void> {
    const info = this.updateInfo();
    if (!info?.version) return;
    // Best-effort: link to the GitHub releases page for the new tag.
    await this.ipc.openExternal(
      `https://github.com/codertapsu/multilingual-dubbed-video/releases/tag/v${info.version}`,
    );
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}
