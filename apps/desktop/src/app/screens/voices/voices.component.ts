import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../core/environment';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import type {
  AppError,
  VoiceEngineId,
  VoiceEngineState,
  VoiceLibraryItem,
  VoiceLicenseCategory,
  VoicePackState,
  VoiceProfile,
} from '../../core/models';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { VoiceCloneDialogComponent } from '../../shared/voice-library/voice-clone-dialog.component';
import {
  baseLanguage,
  EMPTY_FILTER,
  filterVoices,
  languageOptions,
  licenseTone,
  type VoiceFilterState,
} from '../../shared/voice-library/voice-filter';
import { previewSource, sampleSentence } from '../../shared/voice-library/voice-preview';

/** Rows rendered before "Show more" (the library holds a few hundred). */
const PAGE = 60;

interface Progress {
  percent: number | null;
  message: string;
}

/**
 * Giọng đọc (Voices): browse every voice VideoDubber can speak with, play a
 * sample before installing anything, install a voice (and, the first time, the
 * engine that speaks it), and keep favourites for the pickers.
 *
 * The catalog is a reviewed snapshot inside the app; previews and voices
 * download on demand through the orchestrator, which checks every file's
 * sha256 (docs/VOICES.md). Every voice shows its licence as a badge, with the
 * exact licence and credit line one hover away.
 */
@Component({
  selector: 'vd-voices',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorBannerComponent, VoiceCloneDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './voices.component.html',
  styleUrl: './voices.component.scss',
})
export class VoicesComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);

  /**
   * `?from=new-project&language=…`: opened from the New project form. The
   * screen then starts on the voices of that dub's language and offers the way
   * back (the form keeps what was typed in it: NewProjectDraftService).
   */
  readonly from = input<string | undefined>(undefined);
  readonly language = input<string | undefined>(undefined);
  protected readonly fromNewProject = computed(() => this.from() === 'new-project');

  protected readonly library = signal<VoiceLibraryItem[]>([]);
  protected readonly engines = signal<VoiceEngineState[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<AppError | null>(null);
  protected readonly filter = signal<VoiceFilterState>({
    ...EMPTY_FILTER,
    language: this.i18n.locale() === 'vi' ? 'vi' : '',
  });
  protected readonly limit = signal(PAGE);
  protected readonly playing = signal<string | null>(null);
  protected readonly previewError = signal<string | null>(null);
  /** Install progress, by voice id (Piper) or pack id (engines). */
  protected readonly progress = signal<Record<string, Progress>>({});
  protected readonly showLicenseHelp = signal(false);

  // ---- my voices (cloning) ---------------------------------------------------
  protected readonly profiles = signal<VoiceProfile[]>([]);
  protected readonly showClone = signal(false);
  protected readonly cloneMode = signal<'clone' | 'import'>('clone');
  protected readonly notice = signal<string | null>(null);
  protected readonly editingId = signal<string | null>(null);
  protected readonly editName = signal('');
  protected readonly playingProfile = signal<string | null>(null);

  protected readonly visible = computed(() => filterVoices(this.library(), this.filter()));
  protected readonly shown = computed(() => this.visible().slice(0, this.limit()));
  protected readonly languages = computed(() => languageOptions(this.library(), this.i18n.locale()));
  protected readonly engineIds = computed(() => this.engines().map((e) => e.id));
  /** Accent only means something for Vietnamese voices. */
  protected readonly showAccent = computed(() => {
    const f = this.filter();
    return f.language === 'vi' || f.engine === 'vieneu' || f.engine === 'vieneu-classic';
  });
  protected readonly licenses: VoiceLicenseCategory[] = [
    'permissive',
    'attribution',
    'use-restricted',
    'non-commercial',
    'service-terms',
    'unknown',
  ];

  private readonly languageNames = computed(() => {
    try {
      return new Intl.DisplayNames([this.i18n.locale()], { type: 'language' });
    } catch {
      return null;
    }
  });

  private audio: HTMLAudioElement | null = null;
  private engineEvents: EventSource | null = null;
  private setupEvents: EventSource | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async ngOnInit(): Promise<void> {
    this.applyLinkFilters();
    this.followInstalls();
    await this.reload();
  }

  /** Start on the language the link names; the filters still change freely. */
  private applyLinkFilters(): void {
    const language = this.language();
    if (language) this.filter.update((f) => ({ ...f, language: baseLanguage(language) }));
  }

  ngOnDestroy(): void {
    this.stopPreview();
    this.engineEvents?.close();
    this.setupEvents?.close();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  protected async reload(): Promise<void> {
    try {
      const [lib, engines, profiles] = await Promise.all([
        this.ipc.voiceLibrary(),
        this.ipc.voiceEngines(),
        this.ipc.voiceProfiles().catch(() => [] as VoiceProfile[]),
      ]);
      this.library.set(lib.voices);
      this.engines.set(engines);
      this.profiles.set(profiles);
      this.error.set(null);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.loading.set(false);
    }
  }

  // ---- filters ---------------------------------------------------------------

  protected setFilter<K extends keyof VoiceFilterState>(key: K, value: VoiceFilterState[K]): void {
    this.filter.update((f) => ({ ...f, [key]: value }));
    this.limit.set(PAGE);
  }

  protected clearFilters(): void {
    this.filter.set({ ...EMPTY_FILTER });
    this.limit.set(PAGE);
  }

  protected showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  // ---- labels ----------------------------------------------------------------

  protected languageName(code: string): string {
    if (code === '*') return this.i18n.instant('voices.all-languages-voice');
    return this.languageNames()?.of(code) ?? code;
  }

  protected languagesOf(item: VoiceLibraryItem): string {
    const bases = [...new Set(item.languages.map((l) => (l === '*' ? '*' : l)))];
    if (bases.length > 4) {
      return this.i18n.instant('voices.n-languages', { count: bases.length });
    }
    return bases.map((l) => (l === '*' ? this.languageName('*') : this.regionalName(l))).join(', ');
  }

  private regionalName(tag: string): string {
    try {
      return new Intl.DisplayNames([this.i18n.locale()], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return this.languageName(baseLanguage(tag));
    }
  }

  protected engineName(id: VoiceEngineId): string {
    return this.i18n.instant(`voices.engine.${id}`);
  }

  protected licenseTone = licenseTone;

  protected licenseTitle(item: VoiceLibraryItem): string {
    const parts = [item.license.label, item.license.attribution].filter(Boolean);
    return parts.join(' — ');
  }

  protected tagLabel(tag: string): string {
    if (tag.startsWith('grade:')) return this.i18n.instant('voices.grade', { grade: tag.slice(6) });
    const key = `voices.tag.${tag}`;
    const t = this.i18n.instant(key);
    return t === key ? tag : t;
  }

  protected engineOf(item: VoiceLibraryItem): VoiceEngineState | undefined {
    return this.engines().find((e) => e.id === item.engine);
  }

  // ---- previews --------------------------------------------------------------

  /** The sentence installed voices say when played (the user's own, or a default). */
  protected readonly sentence = signal('');
  protected readonly speaking = signal<string | null>(null);
  private objectUrl: string | null = null;

  protected async togglePreview(item: VoiceLibraryItem): Promise<void> {
    if (this.playing() === item.id) {
      this.stopPreview();
      return;
    }
    this.stopPreview();
    this.previewError.set(null);
    // An installed voice says the user's sentence (or, without a sample, a
    // default one); a voice not installed plays the catalog's sample.
    const own = this.sentence().trim();
    let url = this.ipc.voicePreviewUrl(item.id);
    if (previewSource(item, own) === 'speak') {
      this.speaking.set(item.id);
      try {
        url = await this.ipc.speakVoice(item.id, own || this.defaultSentence(item));
        this.objectUrl = url;
      } catch (err) {
        this.error.set(err as AppError);
        return;
      } finally {
        this.speaking.set(null);
      }
    }
    const audio = new Audio(url);
    this.audio = audio;
    this.playing.set(item.id);
    audio.onended = () => this.playing.set(null);
    audio.onerror = () => {
      this.playing.set(null);
      this.previewError.set(item.id);
    };
    void audio.play().catch(() => {
      this.playing.set(null);
      this.previewError.set(item.id);
    });
  }

  private stopPreview(): void {
    this.audio?.pause();
    this.audio = null;
    this.playing.set(null);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** A sentence in the voice's own language, for voices with no sample. */
  private defaultSentence(item: VoiceLibraryItem): string {
    return sampleSentence(baseLanguage(item.languages.find((l) => l !== '*') ?? this.filter().language ?? 'vi') || 'vi');
  }

  // ---- favourites ------------------------------------------------------------

  protected async toggleFavorite(item: VoiceLibraryItem): Promise<void> {
    const next = !item.favorite;
    this.library.update((all) => all.map((v) => (v.id === item.id ? { ...v, favorite: next } : v)));
    try {
      await this.ipc.setVoiceFavorite(item.id, next);
    } catch (err) {
      this.library.update((all) => all.map((v) => (v.id === item.id ? { ...v, favorite: !next } : v)));
      this.error.set(err as AppError);
    }
  }

  // ---- installing ------------------------------------------------------------

  /** The pack an engine install would use: the one that runs well here, else any offered. */
  protected recommendedPack(engine: VoiceEngineState | undefined): VoicePackState | undefined {
    const packs = engine?.packs ?? [];
    return packs.find((p) => p.available && p.fits) ?? packs.find((p) => p.available);
  }

  protected installing(item: VoiceLibraryItem): Progress | null {
    const p = this.progress();
    if (p[item.id]) return p[item.id]!;
    const engine = this.engineOf(item);
    for (const pack of engine?.packs ?? []) if (p[pack.id] || pack.installing) return p[pack.id] ?? { percent: null, message: '' };
    return null;
  }

  protected async install(item: VoiceLibraryItem): Promise<void> {
    const engine = this.engineOf(item);
    let packId: string | undefined;
    if (item.engine !== 'piper' && !item.engineInstalled) {
      const pack = this.recommendedPack(engine);
      if (!pack) return;
      const ok = await this.confirm.confirm({
        title: this.i18n.instant('voices.install-engine-title', { engine: this.engineName(item.engine) }),
        message: this.i18n.instant('voices.install-engine-body', {
          engine: this.engineName(item.engine),
          pack: pack.displayName,
          size: this.sizeLabel(pack.approxSizeMb),
          voices: this.library().filter((v) => v.engine === item.engine && v.kind === 'preset').length,
        }),
        confirmLabel: this.i18n.instant('voices.install-engine-confirm'),
        danger: false,
      });
      if (!ok) return;
      packId = pack.id;
    }
    await this.start(item.id, packId);
  }

  protected async installPack(engine: VoiceEngineState, pack: VoicePackState): Promise<void> {
    const voice = this.library().find((v) => v.engine === engine.id && v.kind === 'preset');
    if (!voice) return;
    await this.start(voice.id, pack.id);
  }

  private async start(voiceId: string, packId?: string): Promise<void> {
    const key = packId ?? voiceId;
    this.progress.update((p) => ({ ...p, [key]: { percent: null, message: this.i18n.instant('voices.starting') } }));
    try {
      await this.ipc.installLibraryVoice(voiceId, packId);
      this.scheduleRefresh(1500);
    } catch (err) {
      this.clearProgress(key);
      this.error.set(err as AppError);
    }
  }

  private clearProgress(key: string): void {
    this.progress.update((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  }

  private scheduleRefresh(ms = 400): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.reload(), ms);
  }

  /** Follow both install streams: engine packs (/engines/events), Piper voices (/setup/events). */
  private followInstalls(): void {
    const engines = new EventSource(`${environment.orchestratorUrl}/engines/events`);
    engines.onmessage = (msg) => {
      const e = safeParse(msg.data) as
        | { type: 'progress'; packId: string; percent: number | null; message: string }
        | { type: 'done'; packId: string }
        | { type: 'error'; packId: string; error: AppError }
        | undefined;
      if (!e || !('packId' in e)) return;
      if (e.type === 'progress') {
        this.progress.update((p) => ({ ...p, [e.packId]: { percent: e.percent, message: e.message } }));
      } else if (e.type === 'done') {
        this.clearProgress(e.packId);
        this.scheduleRefresh();
      } else if (e.type === 'error') {
        this.clearProgress(e.packId);
        this.error.set(e.error);
        this.scheduleRefresh();
      }
    };
    this.engineEvents = engines;

    const setup = new EventSource(`${environment.orchestratorUrl}/setup/events`);
    setup.onmessage = (msg) => {
      const e = safeParse(msg.data) as
        | { type: 'progress'; item: string; percent: number | null; message: string }
        | { type: 'item-done'; item: string }
        | { type: 'done' }
        | { type: 'error'; error: AppError }
        | undefined;
      if (!e) return;
      const voiceOf = (item: string) => (item.startsWith('piper:') ? item.slice('piper:'.length) : null);
      if (e.type === 'progress') {
        const id = voiceOf(e.item);
        if (id) this.progress.update((p) => ({ ...p, [id]: { percent: e.percent, message: e.message } }));
      } else if (e.type === 'item-done') {
        const id = voiceOf(e.item);
        if (id) this.clearProgress(id);
        this.scheduleRefresh();
      } else if (e.type === 'error') {
        // A Piper download failed: clear every pending Piper row and say why.
        this.progress.update((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !this.isPiperModel(k))));
        this.error.set(e.error);
        this.scheduleRefresh();
      } else if (e.type === 'done') {
        this.scheduleRefresh();
      }
    };
    this.setupEvents = setup;
  }

  private isPiperModel(id: string): boolean {
    return this.library().some((v) => v.id === id && v.engine === 'piper');
  }

  /** "Runs on the NVIDIA GPU" / "Runs on the CPU" (the full pack name is its tooltip). */
  protected packLabel(pack: VoicePackState): string {
    const key = `voices.pack-accel.${pack.accel ?? 'cpu'}`;
    const label = this.i18n.instant(key);
    return label === key ? pack.displayName : label;
  }

  // ---- my voices -------------------------------------------------------------

  protected onCloned(): void {
    void this.reload();
  }

  protected toggleProfilePreview(p: VoiceProfile): void {
    if (this.playingProfile() === p.id) {
      this.stopPreview();
      this.playingProfile.set(null);
      return;
    }
    this.stopPreview();
    const audio = new Audio(this.ipc.voiceProfileAudioUrl(p.id, 'preview', p.updatedAt));
    this.audio = audio;
    this.playingProfile.set(p.id);
    audio.onended = () => this.playingProfile.set(null);
    audio.onerror = () => this.playingProfile.set(null);
    void audio.play().catch(() => this.playingProfile.set(null));
  }

  protected startRename(p: VoiceProfile): void {
    this.editingId.set(p.id);
    this.editName.set(p.name);
  }

  protected async saveRename(p: VoiceProfile): Promise<void> {
    const name = this.editName().trim();
    this.editingId.set(null);
    if (!name || name === p.name) return;
    try {
      await this.ipc.renameVoiceProfile(p.id, { name });
      await this.reload();
    } catch (err) {
      this.error.set(err as AppError);
    }
  }

  /** The profile a gender suggestion is being measured for. */
  protected readonly suggesting = signal<string | null>(null);

  /** A suggestion from voice prints (saved unconfirmed: the user still confirms it). */
  protected async suggestGender(p: VoiceProfile): Promise<void> {
    this.suggesting.set(p.id);
    try {
      const res = await this.ipc.suggestVoiceGender(p.id);
      if (!res.suggested && !res.confirmed) {
        this.error.set({ code: 'UNKNOWN', message: this.i18n.instant('voices.my-gender-no-suggestion') } as AppError);
      }
      await this.reload();
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.suggesting.set(null);
    }
  }

  /** The user says whose voice it is (confirmed: casting uses it). */
  protected async setGender(p: VoiceProfile, value: string): Promise<void> {
    if (value !== 'male' && value !== 'female') return;
    try {
      await this.ipc.renameVoiceProfile(p.id, { gender: value });
      await this.reload();
    } catch (err) {
      this.error.set(err as AppError);
    }
  }

  protected async deleteProfile(p: VoiceProfile): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.i18n.instant('voices.my-delete-title', { name: p.name }),
      message: this.i18n.instant('voices.my-delete-body'),
      confirmLabel: this.i18n.instant('voices.my-delete-confirm'),
    });
    if (!ok) return;
    try {
      await this.ipc.deleteVoiceProfile(p.id);
      await this.reload();
    } catch (err) {
      this.error.set(err as AppError);
    }
  }

  /** Save a .vdvoice file: into a folder the user picks (app), or as a download (browser). */
  protected async exportProfile(p: VoiceProfile): Promise<void> {
    this.notice.set(null);
    const includeRecording =
      Boolean(p.reference) &&
      (await this.confirm.confirm({
        title: this.i18n.instant('voices.my-export-title', { name: p.name }),
        message: this.i18n.instant('voices.my-export-recording'),
        confirmLabel: this.i18n.instant('voices.my-export-with'),
        cancelLabel: this.i18n.instant('voices.my-export-without'),
        danger: false,
      }));
    try {
      const dir = await this.ipc.pickFolder(this.i18n.instant('voices.my-export-folder'));
      if (dir === null && this.ipc.inTauri) return; // cancelled the folder dialog
      const res = await this.ipc.exportVoiceProfile(p.id, includeRecording, dir);
      if (res.path) this.notice.set(this.i18n.instant('voices.my-exported', { path: res.path }));
      else if (res.url) window.open(res.url, '_blank');
    } catch (err) {
      this.error.set(err as AppError);
    }
  }

  protected relationLabel(p: VoiceProfile): string {
    return this.i18n.instant(`voices.my-relation.${p.consent.relation}`);
  }

  protected dateLabel(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(this.i18n.locale());
    } catch {
      return iso.slice(0, 10);
    }
  }

  protected sizeLabel(mb: number): string {
    if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.max(1, Math.round(mb))} MB`;
  }

  protected trackById(_: number, item: VoiceLibraryItem): string {
    return item.id;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
