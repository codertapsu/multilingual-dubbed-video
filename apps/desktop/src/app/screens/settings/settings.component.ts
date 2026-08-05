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
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { environment } from '../../core/environment';
// Runtime helper (not a type), so it comes straight from the shared package per
// the re-export note in core/models/index.ts. Shared with the orchestrator's
// pack gate so the badge and the gate can never disagree about the same driver.
import { outdatedNvidiaDriver } from '@videodubber/shared';
import type {
  ActivePackSelection,
  AppError,
  EnginePackInfo,
  EnginePrerequisites,
  InstalledEnginePack,
  StorageInfo,
} from '../../core/models';
import type {
  ArgosPair,
  CloudCredentialInfo,
  ConcurrencyPreferences,
  CloudServiceId,
  CredentialTestResult,
  ProviderDefaults,
  ProviderInfo,
  ProvidersResponse,
  SystemProfileResponse,
  UpdateInfo,
} from '../../core/models/setup';
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  TranslatePipe,
  TranslateService,
  type SupportedLocale,
} from '../../core/i18n';

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
  // Product names stay as they are; only the hint is translated (it is a key).
  openai: { label: 'OpenAI (ChatGPT)', keyHint: 'svc.openai-hint' },
  anthropic: { label: 'Anthropic (Claude)', keyHint: 'svc.anthropic-hint' },
  gemini: { label: 'Google Gemini', keyHint: 'svc.gemini-hint' },
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
  imports: [FormsModule, ErrorBannerComponent, BusyIndicatorComponent, TranslatePipe],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  /** Language picker. Vietnamese is the default — see DEFAULT_LOCALE. */
  protected readonly supportedLocales = SUPPORTED_LOCALES;
  protected readonly localeLabels = LOCALE_LABELS;
  protected readonly locale = this.translate.locale;

  private readonly confirmSvc = inject(ConfirmService);

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
  /** `label` is a TRANSLATION KEY — the template pipes it. */
  protected readonly whisperModels: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'tiny', label: 'whisper.tiny' },
    { id: 'base', label: 'whisper.base' },
    { id: 'small', label: 'whisper.small' },
    { id: 'large-v3-turbo', label: 'whisper.large-v3-turbo' },
    { id: 'distil-large-v3.5', label: 'whisper.distil-large-v3.5' },
    { id: 'medium', label: 'whisper.medium' },
    { id: 'large-v3', label: 'whisper.large-v3' },
    { id: 'phowhisper-medium', label: 'whisper.phowhisper-medium' },
    { id: 'phowhisper-large', label: 'whisper.phowhisper-large' },
  ];

  // Per-service key editing state.
  protected readonly keyInputs = signal<Partial<Record<CloudServiceId, string>>>({});
  protected readonly credBusy = signal<CloudServiceId | null>(null);
  protected readonly testResults = signal<Partial<Record<CloudServiceId, CredentialTestResult>>>({});

  // -------- engine packs --------
  protected readonly enginePacks = signal<EnginePackInfo[]>([]);
  protected readonly installedEngines = signal<InstalledEnginePack[]>([]);
  /** Installed packs with a newer version in the catalog (reinstall to update). */
  protected readonly updatableEngineIds = signal<Set<string>>(new Set());
  /** Per-function winner when several installed packs compete (GET /engines). */
  protected readonly activeSelections = signal<ActivePackSelection[]>([]);
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

  /**
   * Can uv be used or fetched? The install flow downloads a pinned,
   * checksum-verified uv when none is present, so a missing uv is not a dead
   * end — only a platform with no published uv build is. Older orchestrators
   * omit the flag; treat that as "only if already available".
   */
  protected uvObtainable(): boolean {
    const uv = this.prerequisites()?.uv;
    if (!uv) return false;
    return uv.obtainable ?? uv.available;
  }

  // -------- storage (free up disk space) --------
  protected readonly storage = signal<StorageInfo | null>(null);
  protected readonly storageLoading = signal(false);
  protected readonly storageClearing = signal(false);
  /** Last "freed N" message after a successful clear. */
  protected readonly storageMessage = signal<string | null>(null);

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
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-argos-title'),
      message: this.translate.instant('confirm.remove-argos-body', {
        from: this.langName(pair.from),
        to: this.langName(pair.to),
      }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
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
    void this.loadStorage();
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
          this.updatableEngineIds.set(new Set(e.updatable ?? []));
          this.activeSelections.set(e.activeSelections ?? []);
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

  /**
   * When several installed packs do the SAME job (e.g. Gemma 3 4B/12B and
   * Gemma 4 12B/26B), the app runs the most capable one this machine can
   * handle. These helpers label that in the list so the extra installs don't
   * look like they're all doing something.
   */
  protected activeSelectionFor(pack: EnginePackInfo): ActivePackSelection | undefined {
    return this.activeSelections().find((s) => s.providerId === pack.providerId);
  }

  /** This pack is the one actually used for its function. */
  protected isEngineActive(pack: EnginePackInfo): boolean {
    return this.activeSelectionFor(pack)?.packId === pack.id;
  }

  /** Installed, but another pack of the same function is the one being used. */
  protected isEngineShadowed(pack: EnginePackInfo): boolean {
    const active = this.activeSelectionFor(pack);
    return Boolean(active && active.packId !== pack.id && this.isEngineInstalled(pack.id));
  }

  /** Display name of the pack actually used for this pack's function. */
  protected activePackName(pack: EnginePackInfo): string {
    const active = this.activeSelectionFor(pack);
    if (!active) return '';
    return this.enginePacks().find((p) => p.id === active.packId)?.displayName ?? active.packId;
  }

  /** Why a more capable installed pack was passed over (memory), if that happened. */
  protected activeSelectionNote(pack: EnginePackInfo): string {
    return this.activeSelectionFor(pack)?.note ?? '';
  }

  /** True if an installed pack has a newer version available (reinstall to update). */
  protected isEngineUpdatable(packId: string): boolean {
    return this.updatableEngineIds().has(packId);
  }

  protected isEngineRecommended(packId: string): boolean {
    return this.recommendedEngineIds().has(packId);
  }

  /** True if this machine's hardware can run the pack (or fit is unknown). */
  protected isEngineFit(packId: string): boolean {
    const fits = this.engineFits();
    return fits === null || fits.has(packId);
  }

  /**
   * Why this machine can't comfortably run a pack — the whole sentence, because
   * the two cases don't end the same way.
   *
   * The driver case comes FIRST and deliberately does not say "may run slowly":
   * a CUDA build on a driver older than its toolkit doesn't run slowly, it loads
   * the model, allocates every buffer and then aborts. Falling through to the
   * RAM wording would send that user to buy hardware for something a driver
   * update fixes — and the crash itself carries no hint of a driver, so this
   * badge is the only place they can learn it.
   */
  protected engineFitHint(pack: EnginePackInfo): string {
    const driver = outdatedNvidiaDriver(pack, this.system()?.profile.gpus ?? []);
    if (driver) {
      return `Needs NVIDIA driver ${pack.minNvidiaDriver} or newer — this machine has ${driver}. Update the driver, or use the Vulkan build instead.`;
    }
    const gb = pack.minRamMb ? Math.round(pack.minRamMb / 1024) : 0;
    return gb > 0
      ? `Needs ~${gb} GB RAM — may run slowly on this machine`
      : this.translate.instant('misc.heavy-for-machine');
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
    es.onerror = () => {
      // EventSource auto-reconnects on transient blips; only act on a genuine
      // close so an in-flight row doesn't sit at "Starting…" forever with no
      // feedback. Clear progress, surface a retryable error, and allow a reconnect.
      if (es.readyState === EventSource.CLOSED) {
        this.engineProgress.set({});
        this.error.set({
          code: 'WORKER_UNAVAILABLE',
          message: this.translate.instant('misc.engine-stream-lost'),
          remediation:
            this.translate.instant('misc.engine-stream-lost-fix'),
        });
        this.engineEvents = null;
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
    const pack = this.enginePacks().find((p) => p.id === packId);
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-engine-title'),
      message: this.translate.instant('confirm.remove-engine-body', {
        name: pack?.displayName ?? this.translate.instant('confirm.remove-engine-fallback'),
      }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
    this.error.set(null);
    try {
      await this.ipc.uninstallEngine(packId);
      await this.loadEngines();
      await this.loadProcessingSetup();
      void this.loadStorage();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  // ----------------------------- storage -----------------------------

  private async loadStorage(): Promise<void> {
    this.storageLoading.set(true);
    try {
      this.storage.set(await this.ipc.getStorage());
    } catch {
      // Non-fatal — leave the panel empty rather than blanking Settings.
    } finally {
      this.storageLoading.set(false);
    }
  }

  /** Human file size (decimal, matching the engine-pack size chips). */
  protected formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const gb = bytes / 1e9;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / 1e6;
    if (mb >= 1) return `${mb.toFixed(0)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  /** OS-specific label for the reveal-folder button. */
  protected openFolderLabel(): string {
    const platform = this.system()?.profile.platform;
    if (platform === 'darwin') return this.translate.instant('misc.show-in-finder');
    if (platform === 'win32') return this.translate.instant('misc.show-in-explorer');
    return this.translate.instant('misc.open-folder');
  }

  protected async openStorageFolder(): Promise<void> {
    const root = this.storage()?.root;
    if (!root) return;
    this.error.set(null);
    try {
      await this.ipc.openManagedFolder(root);
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  /** Delete all downloaded engine packs, models, and caches (with confirm), then refresh. */
  protected async clearStorage(): Promise<void> {
    if (this.storageClearing()) return;
    const s = this.storage();
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.clear-storage-title'),
      message: this.translate.instant('confirm.clear-storage-body', {
        packs: s?.installedEnginePacks ?? 0,
        size: s ? ` (${this.formatBytes(s.totalBytes)})` : '',
      }),
      confirmLabel: this.translate.instant('confirm.delete-everything'),
    });
    if (!ok) return;
    this.storageClearing.set(true);
    this.storageMessage.set(null);
    this.error.set(null);
    try {
      const res = await this.ipc.clearStorage();
      this.storageMessage.set(`Freed ${this.formatBytes(res.freedBytes)}.`);
      // Refresh everything the wipe affected.
      await Promise.all([this.loadStorage(), this.loadEngines(), this.loadProcessingSetup()]);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.storageClearing.set(false);
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
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-key-title'),
      message: this.translate.instant('confirm.remove-key-body', {
        service: this.serviceMeta[service].label,
      }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
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
      const c = pref.concurrency;
      this.concurrencyValue.set(
        c?.mode === 'manual' && c.maxProjects ? String(c.maxProjects) : 'auto',
      );
      this.queuePaused.set(c?.paused === true);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.prefLoading.set(false);
    }
  }

  // -------------------- simultaneous dubs (run queue) --------------------
  /** 'auto' (follow the hardware recommendation) or a pinned number. */
  protected readonly concurrencyValue = signal<string>('auto');
  protected readonly queuePaused = signal(false);
  protected readonly concurrencyChoices = [1, 2, 3, 4, 5, 6, 7, 8];

  /** Persist the simultaneous-dub limit (auto = follow the recommendation). */
  protected async setConcurrency(value: string): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.concurrencyValue();
    this.concurrencyValue.set(value);
    await this.saveConcurrency(
      value === 'auto'
        ? { mode: 'auto', paused: this.queuePaused() }
        : { mode: 'manual', maxProjects: Number(value), paused: this.queuePaused() },
      () => this.concurrencyValue.set(previous),
    );
  }

  /** Pause/resume dispatching queued dubs. */
  protected async setQueuePaused(paused: boolean): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.queuePaused();
    this.queuePaused.set(paused);
    const pinned = this.concurrencyValue();
    await this.saveConcurrency(
      pinned === 'auto'
        ? { mode: 'auto', paused }
        : { mode: 'manual', maxProjects: Number(pinned), paused },
      () => this.queuePaused.set(previous),
    );
  }

  private async saveConcurrency(concurrency: ConcurrencyPreferences, rollback: () => void): Promise<void> {
    this.prefSaving.set(true);
    this.error.set(null);
    try {
      // Send autoUpdate too: /preferences merges partials, but the Tauri
      // command mirrors the whole object.
      await this.ipc.setUpdatePreference({ autoUpdate: this.autoUpdate(), concurrency });
    } catch (err) {
      rollback();
      this.error.set(toAppError(err));
    } finally {
      this.prefSaving.set(false);
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

  /**
   * The phases cloud processing is suggested for, as one localized list.
   *
   * Built here rather than concatenated in the template: the old markup glued
   * "speech-to-text" + "+" + "translation" together with ternaries, which is
   * exactly the kind of sentence assembly that cannot be translated — word
   * order and separators differ per language.
   */
  protected cloudSuggestPhases(): string {
    const rec = this.system()?.recommendation;
    if (!rec) return '';
    const parts: string[] = [];
    if (rec.suggestCloud.stt) parts.push(this.translate.instant('settings.computer.stt'));
    if (rec.suggestCloud.translation) parts.push(this.translate.instant('settings.computer.translation'));
    return parts.join(' + ');
  }

  /**
   * Providers offerable in a `<select>`: the available ones, PLUS whatever is
   * currently selected even if it is not.
   *
   * Hiding an unusable option is right — a disabled row you cannot pick is
   * noise. But hiding the SELECTED one is not: the control would render some
   * other provider while the stored setting still said the old one, silently
   * misreporting the user's own configuration. So the current value always
   * survives the filter, carrying its "needs API key" suffix as the explanation.
   */
  protected selectable(list: readonly ProviderInfo[] | undefined, current: string | undefined): ProviderInfo[] {
    return (list ?? []).filter((p) => p.available || p.id === current);
  }

  /** Switch the app language. Applies immediately; no reload needed. */
  protected setLocale(next: SupportedLocale): void {
    this.translate.use(next);
  }

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
