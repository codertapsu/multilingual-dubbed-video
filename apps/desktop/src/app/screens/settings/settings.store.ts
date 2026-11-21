import { Injectable, computed, effect, inject, signal, untracked, type OnDestroy } from '@angular/core';
import type { DownloadsWhileDubbing } from '@videodubber/shared';
// Runtime helper (not a type), so it comes straight from the shared package per
// the re-export note in core/models/index.ts. Shared with the orchestrator's
// pack gate so the badge and the gate can never disagree about the same driver.
import { outdatedNvidiaDriver } from '@videodubber/shared';

import { DEFAULT_LOCALE, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import { ActivityService } from '../../core/activity/activity.service';
import type {
  ActivePackSelection,
  AppError,
  EnginePackInfo,
  EnginePrerequisites,
  InstalledEnginePack,
  ProjectSettings,
} from '../../core/models';
import type {
  CloudCredentialInfo,
  CloudServiceId,
  ConcurrencyPreferences,
  ProviderDefaults,
  ProviderInfo,
  ProvidersResponse,
  SystemProfileResponse,
} from '../../core/models/setup';
import { toAppError } from '../../core/state/project.store';
import { ThemeService } from '../../core/theme/theme.service';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { groupEngineFamilies, type EngineFamilyView } from './engine-families';
import type { SettingsSectionId } from './settings-sections';

/** A provider as GET /providers sends it: the descriptor's engine-pack family too. */
export type SettingsProvider = ProviderInfo & { requiresEnginePack?: string };

/** The phases with a "default for new projects" choice. */
export type DefaultPhase = 'stt' | 'translation' | 'tts';

/** Where each phase's "default for new projects" is saved (preferences.providerDefaults). */
const DEFAULT_FIELD = {
  stt: 'sttProviderId',
  translation: 'translationProviderId',
  tts: 'ttsProviderId',
} as const satisfies Record<DefaultPhase, keyof ProviderDefaults>;

/** The sections whose defaults one reset restores (Advanced → Reset all is every one). */
type ResettableSection = Extract<SettingsSectionId, 'general' | 'stt' | 'translation' | 'tts' | 'downloads' | 'performance'>;

const RESETTABLE: readonly ResettableSection[] = ['general', 'stt', 'translation', 'tts', 'downloads', 'performance'];

/** Install progress of one engine pack (GET /engines/events). */
export interface EngineProgress {
  percent: number | null;
  message: string;
}

/**
 * The state the Settings sections share, and what changes it.
 *
 * Settings was one component that loaded everything and held it all; split
 * into sections, the engine pages, the overview and Performance all need the
 * same system profile, provider list, defaults and engine packs, and an install
 * started on one page must keep its progress on another. So that state lives
 * here, provided by the Settings shell (one instance while Settings is open),
 * and each section keeps only what is its own. The logic is the old
 * component's, moved, except where a comment says otherwise.
 */
@Injectable()
export class SettingsStore implements OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly activity = inject(ActivityService);
  private readonly translate = inject(TranslateService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly theme = inject(ThemeService);

  /** The banner at the top of Settings: the last thing that failed. */
  readonly error = signal<AppError | null>(null);

  // ------------------------------------------------------------------ machine
  readonly system = signal<SystemProfileResponse | null>(null);
  readonly providers = signal<ProvidersResponse | null>(null);
  readonly credentials = signal<CloudCredentialInfo[]>([]);

  // ---------------------------------------------- defaults for new projects
  readonly defaults = signal<ProviderDefaults>({});
  readonly defaultsSaving = signal(false);
  /** A default was saved since Settings opened: "Saved — applies to new projects". */
  readonly defaultsSaved = signal(false);
  /**
   * What a new project would use now (GET /project-defaults), for a dub into
   * Vietnamese: "Automatic" spelled out. The orchestrator decides it
   * (projectDefaults.ts), so the page shows its answer rather than a guess.
   */
  readonly effective = signal<ProjectSettings | null>(null);

  // -------------------------------------------------------------- engine packs
  readonly enginePacks = signal<EnginePackInfo[]>([]);
  readonly installedEngines = signal<InstalledEnginePack[]>([]);
  /** Installed packs with a newer version in the catalog (reinstall to update). */
  readonly updatableEngineIds = signal<Set<string>>(new Set());
  /** Per-function winner when several installed packs compete (GET /engines). */
  readonly activeSelections = signal<ActivePackSelection[]>([]);
  readonly recommendedEngineIds = signal<Set<string>>(new Set());
  /** Packs this machine's hardware can run (local-first fit check). null = the
   * backend didn't report fit (older build) -> assume everything fits. */
  readonly engineFits = signal<Set<string> | null>(null);
  /**
   * Install progress per pack, from the app-wide activity service: an
   * install keeps showing after Settings is left and opened again (it used
   * to follow a stream of its own that died with the page, 0.17.0).
   */
  readonly engineProgress = computed<Record<string, EngineProgress>>(() => {
    const out: Record<string, EngineProgress> = {};
    for (const t of this.activity.running()) {
      if (t.kind === 'engine') out[t.id.slice('engine:'.length)] = { percent: t.percent, message: t.message };
    }
    return out;
  });
  readonly prerequisites = signal<EnginePrerequisites | null>(null);
  readonly enginesLoaded = signal(false);

  /** The packs as family cards (engine-families.ts). */
  readonly families = computed<EngineFamilyView[]>(() => groupEngineFamilies(this.enginePacks()));

  // --------------------------------------------------------------- preferences
  readonly autoUpdate = signal<boolean>(true);
  readonly prefLoading = signal(false);
  readonly prefSaving = signal(false);
  /** 'auto' (follow the hardware recommendation) or a pinned number. */
  readonly concurrencyValue = signal<string>('auto');
  readonly queuePaused = signal(false);
  readonly downloadsChoice = signal<DownloadsWhileDubbing>('auto');
  readonly downloadsEffective = signal<Exclude<DownloadsWhileDubbing, 'auto'> | null>(null);

  /** Load everything the sections share; each part is independent and non-fatal. */
  init(): void {
    void this.loadPreference();
    void this.loadProcessingSetup();
    void this.loadEngines();
    void this.loadDownloadsPolicy();
    void this.loadEffective();
  }

  constructor() {
    // A pack finished (here or on another screen): the list, what can run and
    // the defaults may all have changed.
    let seen = this.activity.engineChanges();
    effect(() => {
      const n = this.activity.engineChanges();
      if (n === seen) return;
      seen = n;
      untracked(() => this.afterEngineChange());
    });
  }

  ngOnDestroy(): void {
    /* the activity service keeps following installs */
  }

  // ========================================================================
  // Machine, providers, credentials, defaults
  // ========================================================================

  async loadProcessingSetup(): Promise<void> {
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

  /** Refresh the provider pickers' availability (a key saved, a pack installed). */
  async refreshProviders(): Promise<void> {
    this.providers.set(await this.ipc.getProviders().catch(() => this.providers()));
  }

  async loadEffective(): Promise<void> {
    try {
      this.effective.set((await this.ipc.getProjectDefaults('', 'vi-VN')).settings);
    } catch {
      this.effective.set(null); // an older backend: the pages say "Automatic" only
    }
  }

  credentialFor(service: CloudServiceId): CloudCredentialInfo | undefined {
    return this.credentials().find((c) => c.service === service);
  }

  /** The providers of a phase, as GET /providers lists them. */
  providersFor(phase: DefaultPhase): SettingsProvider[] {
    return (this.providers()?.[phase] ?? []) as SettingsProvider[];
  }

  /**
   * Providers offerable in a `<select>`: the available ones, PLUS whatever is
   * currently selected even if it is not.
   *
   * Hiding an unusable option is right — a disabled row you cannot pick is
   * noise. But hiding the SELECTED one is not: the control would render some
   * other provider while the stored setting still said the old one, silently
   * misreporting the user's own configuration. So the current value always
   * survives the filter, carrying the reason it cannot run as the explanation.
   */
  selectable(phase: DefaultPhase, current: string | undefined): SettingsProvider[] {
    return this.providersFor(phase).filter((p) => p.available || p.id === current);
  }

  /**
   * A provider's name in the user's language. GET /providers names them in
   * English ("Piper / system / fallback (local)"); Settings has its own words
   * for the ones it knows, and shows the backend's name for any other.
   */
  providerLabel(id: string | undefined): string {
    if (!id) return '';
    const key = `settings.providers.${id}`;
    const text = this.translate.instant(key);
    if (text !== key) return text;
    for (const phase of ['stt', 'translation', 'tts'] as const) {
      const p = this.providersFor(phase).find((x) => x.id === id);
      if (p) return p.displayName;
    }
    return id;
  }

  /**
   * Why a provider cannot run now, in a few words, for the option list. The old
   * list said "needs API key" for every unavailable provider, a missing engine
   * or a stopped Ollama included.
   */
  unavailableReason(p: SettingsProvider): string {
    if (p.available) return '';
    switch (p.readinessStatus) {
      case 'cloud-key-missing':
        return this.translate.instant('settings.defaults.needs-key');
      case 'engine-pack-missing':
        return this.translate.instant('settings.fn.reason-not-installed');
      case 'model-missing':
        return this.translate.instant('settings.fn.reason-model-missing');
      case 'daemon-unreachable':
        return this.translate.instant('settings.fn.reason-not-running');
      case 'worker-loading':
        return this.translate.instant('settings.fn.reason-starting');
      default:
        return this.translate.instant('settings.fn.reason-unavailable');
    }
  }

  /** The default a phase's picker shows ('' = Automatic). */
  defaultFor(phase: DefaultPhase): string {
    return this.defaults()[DEFAULT_FIELD[phase]] ?? '';
  }

  /** What new projects use for a phase now: the saved choice, else what Automatic picks. */
  effectiveProvider(phase: DefaultPhase): string | undefined {
    return this.defaultFor(phase) || this.effective()?.[DEFAULT_FIELD[phase]];
  }

  /** Make `providerId` what new projects use for `phase` ('' = Automatic). */
  setPhaseDefault(phase: DefaultPhase, providerId: string): Promise<void> {
    return this.setDefault(DEFAULT_FIELD[phase], providerId);
  }

  /**
   * Change one default and save it at once. The old page saved the defaults
   * with a button while every other setting saved itself; split over three
   * pages, an unsaved choice on one page would have been lost on the next.
   */
  async setDefault<K extends keyof ProviderDefaults>(key: K, value: ProviderDefaults[K] | ''): Promise<void> {
    const next = { ...this.defaults() };
    if (value === '' || value === undefined) delete next[key];
    else next[key] = value as ProviderDefaults[K];
    await this.saveDefaults(next);
  }

  private async saveDefaults(next: ProviderDefaults): Promise<boolean> {
    const previous = this.defaults();
    this.defaults.set(next);
    this.defaultsSaving.set(true);
    this.error.set(null);
    try {
      await this.ipc.saveAppPreferences({ providerDefaults: next });
      this.defaultsSaved.set(true);
      void this.loadEffective();
      return true;
    } catch (err) {
      this.defaults.set(previous);
      this.error.set(toAppError(err));
      return false;
    } finally {
      this.defaultsSaving.set(false);
    }
  }

  /**
   * One-click: adopt the hardware-aware recommendation as the defaults — the
   * recommended speech model, and every engine back to "Automatic", which the
   * orchestrator resolves to the best engine INSTALLED on this machine
   * (projectDefaults.ts). It used to set only the model, so a user who had
   * installed the recommended GPU engines kept dubbing on the CPU.
   */
  async applyRecommended(): Promise<void> {
    const rec = this.system()?.recommendation;
    if (!rec) return;
    await this.saveDefaults({ sttModel: rec.whisperModel });
  }

  /**
   * The phases cloud processing is suggested for, as one localized list.
   *
   * Built here rather than concatenated in the template: the old markup glued
   * "speech-to-text" + "+" + "translation" together with ternaries, which is
   * exactly the kind of sentence assembly that cannot be translated — word
   * order and separators differ per language.
   */
  cloudSuggestPhases(): string {
    const rec = this.system()?.recommendation;
    if (!rec) return '';
    const parts: string[] = [];
    if (rec.suggestCloud.stt) parts.push(this.translate.instant('settings.computer.stt'));
    if (rec.suggestCloud.translation) parts.push(this.translate.instant('settings.computer.translation'));
    return parts.join(' + ');
  }

  readonly ramLabel = computed(() => {
    const profile = this.system()?.profile;
    return profile ? `${Math.round(profile.totalRamMb / 1024)} GB RAM` : '';
  });

  // ========================================================================
  // Engine packs
  // ========================================================================

  async loadEngines(): Promise<void> {
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
    this.enginesLoaded.set(true);
  }

  isEngineInstalled(packId: string): boolean {
    return this.installedEngines().some((i) => i.id === packId);
  }

  /** True for packs delivered as a uv-managed Python env (need uv). */
  needsUv(pack: EnginePackInfo): boolean {
    return pack.packKind === 'python-uv';
  }

  /**
   * Can uv be used or fetched? The install flow downloads a pinned,
   * checksum-verified uv when none is present, so a missing uv is not a dead
   * end — only a platform with no published uv build is. Older orchestrators
   * omit the flag; treat that as "only if already available".
   */
  uvObtainable(): boolean {
    const uv = this.prerequisites()?.uv;
    if (!uv) return false;
    return uv.obtainable ?? uv.available;
  }

  /** Install is impossible here: a Python pack on a platform with no uv build. */
  installBlocked(pack: EnginePackInfo): boolean {
    const pre = this.prerequisites();
    return this.needsUv(pack) && pre !== null && !pre.uv.available && !this.uvObtainable();
  }

  /**
   * When several installed packs do the SAME job (e.g. Gemma 3 4B/12B and
   * Gemma 4 12B/26B), the app runs the most capable one this machine can
   * handle. These helpers label that in the list so the extra installs don't
   * look like they're all doing something.
   */
  activeSelectionFor(pack: EnginePackInfo): ActivePackSelection | undefined {
    return this.activeSelections().find((s) => s.providerId === pack.providerId);
  }

  /**
   * This pack is the one actually used for its function. GET /engines names a
   * winner only when packs compete, so a pack installed alone in its function
   * is the one used too (the list used to badge nothing then) — except the
   * whisper.cpp models: whisper.cpp runs the size each PROJECT picks, so no
   * installed size is "the one in use" (the speech-model default says which).
   */
  isEngineActive(pack: EnginePackInfo): boolean {
    const active = this.activeSelectionFor(pack);
    if (active) return active.packId === pack.id;
    if (SettingsStore.PER_PROJECT_MODELS.has(pack.providerId) || !this.isEngineInstalled(pack.id)) return false;
    return !this.enginePacks().some((p) => p.id !== pack.id && p.providerId === pack.providerId && this.isEngineInstalled(p.id));
  }

  /** Model packs a project picks one of itself (see isEngineActive). */
  private static readonly PER_PROJECT_MODELS: ReadonlySet<string> = new Set(['whisper-cpp-model']);

  /** Installed, but another pack of the same function is the one being used. */
  isEngineShadowed(pack: EnginePackInfo): boolean {
    const active = this.activeSelectionFor(pack);
    return Boolean(active && active.packId !== pack.id && this.isEngineInstalled(pack.id));
  }

  /**
   * The local-LLM model packs the user may pick between (TranslateGemma sizes,
   * Gemma chat models). The app picks automatically — the most capable one that
   * fits the graphics card — but the choice is the user's: a slower, better
   * model is a legitimate trade.
   */
  private static readonly MODEL_JOB: Readonly<Record<string, 'translation' | 'chat'>> = {
    'local-llm-model': 'translation',
    'local-llm-chat-model': 'chat',
  };

  isChoosableModel(pack: EnginePackInfo): boolean {
    return pack.providerId in SettingsStore.MODEL_JOB && this.isEngineInstalled(pack.id);
  }

  /** The running model of this pack's job was picked by the user, not automatically. */
  isModelChosenByUser(pack: EnginePackInfo): boolean {
    return this.activeSelectionFor(pack)?.chosenByUser === true;
  }

  /** Use this model for its job (`use`), or go back to the automatic choice. */
  async chooseModel(pack: EnginePackInfo, use: boolean): Promise<void> {
    const job = SettingsStore.MODEL_JOB[pack.providerId];
    if (!job) return;
    this.error.set(null);
    try {
      await this.ipc.saveAppPreferences({ localModels: { [job]: use ? pack.id : '' } });
      await this.loadEngines();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  /** Display name of the pack actually used for this pack's function. */
  activePackName(pack: EnginePackInfo): string {
    const active = this.activeSelectionFor(pack);
    if (!active) return '';
    return this.enginePacks().find((p) => p.id === active.packId)?.displayName ?? active.packId;
  }

  /** Why a more capable installed pack was passed over (memory), if that happened. */
  activeSelectionNote(pack: EnginePackInfo): string {
    return this.activeSelectionFor(pack)?.note ?? '';
  }

  /** True if an installed pack has a newer version available (reinstall to update). */
  isEngineUpdatable(packId: string): boolean {
    return this.updatableEngineIds().has(packId);
  }

  isEngineRecommended(packId: string): boolean {
    return this.recommendedEngineIds().has(packId);
  }

  /** True if this machine's hardware can run the pack (or fit is unknown). */
  isEngineFit(packId: string): boolean {
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
  engineFitHint(pack: EnginePackInfo): string {
    const driver = outdatedNvidiaDriver(pack, this.system()?.profile.gpus ?? []);
    if (driver) {
      return this.translate.instant('misc.needs-nvidia-driver', {
        required: pack.minNvidiaDriver ?? '',
        found: driver,
      });
    }
    const gb = pack.minRamMb ? Math.round(pack.minRamMb / 1024) : 0;
    return gb > 0
      ? this.translate.instant('misc.needs-ram', { gb })
      : this.translate.instant('misc.heavy-for-machine');
  }

  engineProgressFor(packId: string): EngineProgress | undefined {
    return this.engineProgress()[packId];
  }

  private afterEngineChange(): void {
    void this.loadEngines();
    void this.loadProcessingSetup(); // availability flips once a pack lands
    void this.loadEffective();
  }

  async installEngine(packId: string): Promise<void> {
    this.error.set(null);
    // Listed as starting at once (and in the top bar), before the first progress event.
    this.activity.markStarting('engine', packId, this.enginePacks().find((p) => p.id === packId)?.displayName);
    try {
      await this.ipc.installEngine(packId);
    } catch (err) {
      this.activity.markFailed('engine', packId, toAppError(err));
      this.error.set(toAppError(err));
    }
  }

  /** A pack installed from the recommendations panel: refresh the full list and what can run. */
  onRecommendedInstalled(): void {
    this.afterEngineChange();
  }

  async uninstallEngine(packId: string): Promise<void> {
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
      void this.loadEffective();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  // ========================================================================
  // Preferences: updates, simultaneous dubs, downloads while dubbing
  // ========================================================================

  private async loadPreference(): Promise<void> {
    this.prefLoading.set(true);
    try {
      const pref = await this.ipc.getUpdatePreference();
      this.autoUpdate.set(pref.autoUpdate);
      const c = pref.concurrency;
      this.concurrencyValue.set(c?.mode === 'manual' && c.maxProjects ? String(c.maxProjects) : 'auto');
      this.queuePaused.set(c?.paused === true);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.prefLoading.set(false);
    }
  }

  async toggleAutoUpdate(value: boolean): Promise<void> {
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

  /** Persist the simultaneous-dub limit (auto = follow the recommendation). */
  async setConcurrency(value: string): Promise<void> {
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
  async setQueuePaused(paused: boolean): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.queuePaused();
    this.queuePaused.set(paused);
    const pinned = this.concurrencyValue();
    await this.saveConcurrency(
      pinned === 'auto' ? { mode: 'auto', paused } : { mode: 'manual', maxProjects: Number(pinned), paused },
      () => this.queuePaused.set(previous),
    );
  }

  private async saveConcurrency(concurrency: ConcurrencyPreferences, rollback: () => void): Promise<boolean> {
    this.prefSaving.set(true);
    this.error.set(null);
    try {
      // Send autoUpdate too: /preferences merges partials, but the Tauri
      // command mirrors the whole object.
      await this.ipc.setUpdatePreference({ autoUpdate: this.autoUpdate(), concurrency });
      return true;
    } catch (err) {
      rollback();
      this.error.set(toAppError(err));
      return false;
    } finally {
      this.prefSaving.set(false);
    }
  }

  async loadDownloadsPolicy(): Promise<void> {
    try {
      const p = await this.ipc.downloadsPolicy();
      this.downloadsChoice.set(p.choice);
      this.downloadsEffective.set(p.effective);
    } catch {
      /* an older backend: the card shows the choice only */
    }
  }

  async setDownloadsChoice(value: DownloadsWhileDubbing): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.downloadsChoice();
    this.downloadsChoice.set(value);
    this.prefSaving.set(true);
    this.error.set(null);
    try {
      // autoUpdate too: the Tauri command mirrors the whole object.
      await this.ipc.setUpdatePreference({ autoUpdate: this.autoUpdate(), downloads: { whileDubbing: value } });
      await this.loadDownloadsPolicy();
    } catch (err) {
      this.downloadsChoice.set(previous);
      this.error.set(toAppError(err));
    } finally {
      this.prefSaving.set(false);
    }
  }

  // ========================================================================
  // Reset to defaults
  // ========================================================================

  /**
   * Put a section's settings back to the defaults the app ships with, after
   * asking. Only what has a known default: never an API key, a login, the brand
   * kit, a preset, an installed engine or where the projects are (moving them
   * is its own button). Every value goes through the same save as its control,
   * so a reset is exactly the clicks it replaces. True when it was done.
   */
  async resetSection(section: SettingsSectionId | 'all'): Promise<boolean> {
    const targets: readonly ResettableSection[] =
      section === 'all' ? RESETTABLE : RESETTABLE.includes(section as ResettableSection) ? [section as ResettableSection] : [];
    if (targets.length === 0) return false;
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant(section === 'all' ? 'settings.reset.all-title' : 'settings.reset.title'),
      message: this.translate.instant(`settings.reset.body-${section}`),
      confirmLabel: this.translate.instant('settings.reset.confirm'),
      danger: false,
    });
    if (!ok) return false;
    this.error.set(null);
    let done = true;
    for (const target of targets) done = (await this.resetOne(target)) && done;
    return done;
  }

  private async resetOne(section: ResettableSection): Promise<boolean> {
    switch (section) {
      case 'general':
        this.translate.use(DEFAULT_LOCALE);
        this.theme.use('system');
        if (!this.autoUpdate()) await this.toggleAutoUpdate(true);
        return this.autoUpdate();
      case 'stt': {
        const { sttProviderId: _p, sttModel: _m, ...rest } = this.defaults();
        return this.saveDefaults(rest);
      }
      case 'translation': {
        const { translationProviderId: _t, ...rest } = this.defaults();
        if (!(await this.saveDefaults(rest))) return false;
        try {
          // Back to the automatic model choice for both jobs ('' = automatic).
          await this.ipc.saveAppPreferences({ localModels: { translation: '', chat: '' } });
          await this.loadEngines();
          return true;
        } catch (err) {
          this.error.set(toAppError(err));
          return false;
        }
      }
      case 'tts': {
        const { ttsProviderId: _t, ...rest } = this.defaults();
        return this.saveDefaults(rest);
      }
      case 'downloads':
        if (this.downloadsChoice() !== 'auto') await this.setDownloadsChoice('auto');
        return this.downloadsChoice() === 'auto';
      case 'performance': {
        const previous = { value: this.concurrencyValue(), paused: this.queuePaused() };
        this.concurrencyValue.set('auto');
        this.queuePaused.set(false);
        return this.saveConcurrency({ mode: 'auto', paused: false }, () => {
          this.concurrencyValue.set(previous.value);
          this.queuePaused.set(previous.paused);
        });
      }
    }
  }

  // ========================================================================
  // Formatting
  // ========================================================================

  /** A download size in the catalog's MB, as the pack rows show it. */
  sizeLabel(mb: number): string {
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
  }

  /** "6 GB" for a requirement in MB. */
  gbLabel(mb: number): string {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }

  /** OS-specific label for the reveal-folder button. */
  openFolderLabel(): string {
    const platform = this.system()?.profile.platform;
    if (platform === 'darwin') return this.translate.instant('misc.show-in-finder');
    if (platform === 'win32') return this.translate.instant('misc.show-in-explorer');
    return this.translate.instant('misc.open-folder');
  }

  dismissError(): void {
    this.error.set(null);
  }
}
