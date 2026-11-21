import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { speakerNumber } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import type {
  AppError,
  TimeRange,
  VoiceConsentStatements,
  VoiceEngineState,
  VoiceProfile,
  VoiceReferenceAnalysis,
  VoiceReferenceChecks,
} from '../../core/models';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';
import { VoiceRecorder } from './recorder';

type Step = 'engine' | 'rights' | 'source' | 'check' | 'save' | 'done';

/** The policy of the cloning engine (VieNeu 3.8): it uses up to 8 s of speech. */
const MIN_MS = 3000;
const MAX_MS = 8000;

/**
 * "Tạo giọng nhân bản": make a voice from a recording or a file.
 *
 * 1. Rights: the user says whose voice it is and agrees to a statement shown
 *    in full; nothing else is enabled before that, and the statement is stored
 *    with the voice. The dialog says plainly that this is the user's
 *    commitment, not identity verification.
 * 2. Source: record in the app (raw samples, no browser processing) or import
 *    any audio or video file.
 * 3. Check: the waveform with the speech marked and the proposed window, which
 *    the user can move; what the app measured, in plain words, each with a fix.
 * 4. Save: a name, whether to keep the recording (needed to remake the voice
 *    for another engine later), whether the engine cleans the recording.
 * Then the new voice speaks a sentence.
 *
 * Mode 'project' takes the speech from the project's own video instead (the
 * whole track, or `segmentIds`: one speaker's lines chosen in the editor).
 * There is no source step, the only declaration is the source-video one, and
 * the voice stays in that project; the server enforces all three.
 */
@Component({
  selector: 'vd-voice-clone-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './voice-clone-dialog.component.html',
  styleUrl: './voice-clone-dialog.component.scss',
})
export class VoiceCloneDialogComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);

  /** Make the voice private to this project (its speakers' voices). */
  readonly projectId = input<string | undefined>(undefined);
  /**
   * 'import': bring in a .vdvoice file instead of recording (same declaration first).
   * 'project': the voice in `projectId`'s video (needs `projectId`).
   */
  readonly mode = input<'clone' | 'import' | 'project'>('clone');
  /** Mode 'project': the lines to take the voice from (none: the whole track). */
  readonly segmentIds = input<readonly string[] | undefined>(undefined);
  /** Mode 'project': a detected speaker; the server picks their best lines. */
  readonly speakerId = input<string | undefined>(undefined);
  protected readonly speakerN = computed(() => {
    const id = this.speakerId();
    return id ? speakerNumber(id) : 0;
  });
  readonly created = output<VoiceProfile>();
  readonly closed = output<void>();

  protected readonly step = signal<Step>('rights');
  protected readonly titleKey = computed(() =>
    this.mode() === 'import' ? 'voice-clone.import-title' : this.mode() === 'project' ? 'voice-clone.video-title' : 'voice-clone.title',
  );
  protected readonly steps = computed<readonly Step[]>(() =>
    this.mode() === 'import' ? ['rights', 'source'] : this.mode() === 'project' ? ['rights', 'check', 'save'] : ['rights', 'source', 'check', 'save'],
  );
  protected readonly error = signal<AppError | null>(null);
  protected readonly busy = signal<'' | 'upload' | 'analyze' | 'check' | 'create' | 'install'>('');

  // engine
  protected readonly engine = signal<VoiceEngineState | null>(null);
  protected readonly enginePack = computed(() => {
    const packs = this.engine()?.packs ?? [];
    return packs.find((p) => p.available && p.fits) ?? packs.find((p) => p.available);
  });

  // rights
  protected readonly consent = signal<VoiceConsentStatements | null>(null);
  protected readonly relation = signal<'self' | 'authorized' | 'source-video'>('self');
  protected readonly accepted = signal(false);

  // source
  protected readonly tab = signal<'record' | 'import'>('record');
  protected readonly recorder = new VoiceRecorder();
  protected readonly mics = signal<MediaDeviceInfo[]>([]);
  protected readonly mic = signal<string>('');
  protected readonly recordingUrl = signal<string | null>(null);
  private recordingBlob: Blob | null = null;
  protected readonly fileName = signal<string | null>(null);
  private sourceKind: 'recording' | 'file' = 'recording';

  // check
  protected readonly analysis = signal<VoiceReferenceAnalysis | null>(null);
  protected readonly window = signal<TimeRange>({ startMs: 0, endMs: 0 });
  protected readonly checks = signal<VoiceReferenceChecks | null>(null);
  protected readonly denoise = signal(true);
  protected readonly playingWindow = signal(false);
  private audio: HTMLAudioElement | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;

  // save
  protected readonly name = signal('');
  /** Whose voice it is, as the user says (casting by gender uses it). */
  protected readonly gender = signal<'' | 'male' | 'female'>('');
  protected readonly note = signal('');
  protected readonly keepRecording = signal(true);
  protected readonly profile = signal<VoiceProfile | null>(null);
  protected readonly playingPreview = signal(false);

  protected readonly windowLength = computed(() => this.window().endMs - this.window().startMs);
  protected readonly maxStart = computed(() => Math.max(0, (this.analysis()?.durationMs ?? 0) - this.windowLength()));
  protected readonly maxLength = computed(() => Math.min(MAX_MS, this.analysis()?.durationMs ?? MAX_MS));
  protected readonly minLength = MIN_MS;
  protected readonly refused = computed(() => this.checks()?.warnings.includes('too-short') ?? true);
  protected readonly bars = computed(() => {
    const peaks = this.analysis()?.peaks ?? [];
    return peaks.map((p, i) => ({ x: i, h: Math.max(0.5, p * 100) }));
  });
  protected readonly regionRects = computed(() => {
    const a = this.analysis();
    if (!a || a.durationMs <= 0) return [];
    const scale = (a.peaks.length || 1) / a.durationMs;
    return a.regions.map((r) => ({ x: r.startMs * scale, w: Math.max(0.5, (r.endMs - r.startMs) * scale) }));
  });
  protected readonly windowRect = computed(() => {
    const a = this.analysis();
    if (!a || a.durationMs <= 0) return null;
    const scale = (a.peaks.length || 1) / a.durationMs;
    return { x: this.window().startMs * scale, w: Math.max(1, this.windowLength() * scale) };
  });

  async ngOnInit(): Promise<void> {
    if (this.mode() === 'project') this.relation.set('source-video');
    try {
      const [engines, consent] = await Promise.all([
        this.ipc.voiceEngines(),
        this.ipc.voiceConsent(this.i18n.locale()),
      ]);
      this.engine.set(engines.find((e) => e.id === 'vieneu') ?? null);
      this.consent.set(consent);
      // Importing needs no engine yet (the voice data comes made); cloning does.
      if (!this.engine()?.installed && this.mode() !== 'import') this.step.set('engine');
    } catch (err) {
      this.error.set(err as AppError);
    }
  }

  ngOnDestroy(): void {
    this.recorder.dispose();
    this.audio?.pause();
    if (this.checkTimer) clearTimeout(this.checkTimer);
    const url = this.recordingUrl();
    if (url) URL.revokeObjectURL(url);
  }

  protected close(): void {
    this.recorder.dispose();
    this.closed.emit();
  }

  // ---- engine ----------------------------------------------------------------

  protected async installEngine(): Promise<void> {
    const pack = this.enginePack();
    if (!pack) return;
    this.busy.set('install');
    this.error.set(null);
    try {
      await this.ipc.installLibraryVoice('vieneu38-hai-dang', pack.id);
      // Follow the install until the engine reports installed (or fails).
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const engine = (await this.ipc.voiceEngines()).find((e) => e.id === 'vieneu') ?? null;
        this.engine.set(engine);
        if (engine?.installed) {
          this.step.set('rights');
          return;
        }
        if (engine && !engine.packs.some((p) => p.installing)) break;
      }
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  // ---- rights ----------------------------------------------------------------

  protected statement(): string {
    return this.consent()?.statements[this.relation()] ?? '';
  }

  protected toSource(): void {
    if (!this.accepted()) return;
    if (this.mode() === 'project') {
      void this.analyzeProject();
      return;
    }
    this.step.set('source');
    if (this.mode() === 'clone') void this.loadMics();
  }

  /** Mode 'project': the video's speech goes straight to the check. */
  private async analyzeProject(): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    this.error.set(null);
    this.busy.set('analyze');
    try {
      const speakerId = this.speakerId();
      const segmentIds = this.segmentIds();
      const analysis = await this.ipc.analyzeProjectVoice(projectId, speakerId ? { speakerId } : segmentIds ? { segmentIds } : {});
      this.showAnalysis(analysis);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  /** Back from the check: to the source, or (project mode) to the declaration. */
  protected back(): void {
    this.step.set(this.mode() === 'project' ? 'rights' : 'source');
  }

  /** Import mode: read a .vdvoice file and make a new voice from it. */
  protected async onVoiceFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    const consent = this.consent();
    if (!file || !consent) return;
    this.error.set(null);
    this.busy.set('create');
    try {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await file.text());
      } catch {
        throw { code: 'VOICE_REFERENCE_REJECTED', message: this.i18n.instant('voice-clone.import-not-voice') };
      }
      const profile = await this.ipc.importVoiceProfile(bundle, {
        relation: this.relation(),
        statementVersion: consent.version,
        locale: this.i18n.locale(),
        accepted: true,
      });
      this.profile.set(profile);
      this.step.set('done');
      this.created.emit(profile);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  // ---- source ----------------------------------------------------------------

  private async loadMics(): Promise<void> {
    try {
      const mics = await this.recorder.microphones();
      this.mics.set(mics);
    } catch {
      this.mics.set([]);
    }
  }

  protected async startRecording(): Promise<void> {
    this.discardRecording();
    await this.recorder.start(this.mic() || undefined);
    // Device names are only readable once the microphone was allowed.
    if (this.recorder.state() === 'recording') void this.loadMics();
  }

  protected async stopRecording(): Promise<void> {
    const blob = await this.recorder.stop();
    if (!blob) return;
    this.recordingBlob = blob;
    this.recordingUrl.set(URL.createObjectURL(blob));
  }

  private discardRecording(): void {
    const url = this.recordingUrl();
    if (url) URL.revokeObjectURL(url);
    this.recordingUrl.set(null);
    this.recordingBlob = null;
  }

  protected async useRecording(): Promise<void> {
    if (!this.recordingBlob) return;
    this.sourceKind = 'recording';
    this.fileName.set(null);
    await this.analyze(this.recordingBlob);
  }

  protected async onFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    this.sourceKind = 'file';
    this.fileName.set(file.name);
    await this.analyze(file, file.name);
  }

  private async analyze(blob: Blob, sourceName?: string): Promise<void> {
    this.error.set(null);
    this.busy.set('upload');
    try {
      const { uploadId } = await this.ipc.uploadVoiceRecording(blob);
      this.busy.set('analyze');
      const analysis = await this.ipc.analyzeVoiceReference({ uploadId, ...(sourceName ? { sourceName } : {}) });
      this.showAnalysis(analysis, sourceName);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  private showAnalysis(analysis: VoiceReferenceAnalysis, sourceName?: string): void {
    this.analysis.set(analysis);
    this.window.set(analysis.window);
    this.checks.set(analysis.checks);
    if (!this.name()) this.name.set(this.defaultName(sourceName));
    this.step.set('check');
  }

  private defaultName(sourceName?: string): string {
    if (this.mode() === 'project') {
      if (this.speakerId()) return this.i18n.instant('studio.speaker-n', { n: this.speakerN() });
      const n = this.segmentIds()?.length ?? 0;
      return n > 0 ? this.i18n.instant('voice-clone.default-name-lines', { n }) : this.i18n.instant('voice-clone.default-name-video');
    }
    if (sourceName) return sourceName.replace(/\.[^.]+$/, '').slice(0, 60);
    return this.i18n.instant(this.relation() === 'self' ? 'voice-clone.default-name-self' : 'voice-clone.default-name-other');
  }

  // ---- check -----------------------------------------------------------------

  protected setStart(ms: number): void {
    const len = this.windowLength();
    const start = Math.max(0, Math.min(Number(ms), this.maxStart()));
    this.window.set({ startMs: start, endMs: start + len });
    this.scheduleCheck();
  }

  protected setLength(ms: number): void {
    const total = this.analysis()?.durationMs ?? 0;
    const len = Math.max(Math.min(MIN_MS, total), Math.min(Number(ms), this.maxLength()));
    const start = Math.min(this.window().startMs, Math.max(0, total - len));
    this.window.set({ startMs: start, endMs: start + len });
    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => void this.recheck(), 250);
  }

  private async recheck(): Promise<void> {
    const a = this.analysis();
    if (!a) return;
    this.busy.set('check');
    try {
      const res = await this.ipc.checkVoiceWindow(a.analysisId, this.window());
      this.checks.set(res.checks);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  protected toggleWindowPlayback(): void {
    const a = this.analysis();
    if (!a) return;
    if (this.playingWindow()) {
      this.audio?.pause();
      this.playingWindow.set(false);
      return;
    }
    this.audio?.pause();
    const audio = new Audio(this.ipc.voiceAnalysisAudioUrl(a.analysisId));
    this.audio = audio;
    const { startMs, endMs } = this.window();
    audio.onloadedmetadata = () => {
      audio.currentTime = startMs / 1000;
      void audio.play().catch(() => this.playingWindow.set(false));
    };
    audio.ontimeupdate = () => {
      if (audio.currentTime * 1000 >= endMs) {
        audio.pause();
        this.playingWindow.set(false);
      }
    };
    audio.onended = () => this.playingWindow.set(false);
    this.playingWindow.set(true);
  }

  protected seconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }

  // ---- save ------------------------------------------------------------------

  protected async save(): Promise<void> {
    const a = this.analysis();
    const consent = this.consent();
    if (!a || !consent || !this.name().trim() || this.refused()) return;
    this.error.set(null);
    this.busy.set('create');
    try {
      const profile = await this.ipc.createVoiceProfile({
        analysisId: a.analysisId,
        window: this.window(),
        name: this.name().trim(),
        ...(this.note().trim() ? { note: this.note().trim() } : {}),
        ...(this.gender() ? { gender: this.gender() as 'male' | 'female' } : {}),
        consent: { relation: this.relation(), statementVersion: consent.version, locale: this.i18n.locale(), accepted: true },
        keepRecording: this.keepRecording(),
        denoise: this.denoise(),
        ...(this.projectId() ? { projectId: this.projectId() } : {}),
        // A project-video voice: the server takes the source from the analysis.
        ...(this.mode() === 'project'
          ? {}
          : {
              source:
                this.sourceKind === 'file'
                  ? { kind: 'file' as const, ...(this.fileName() ? { fileName: this.fileName()! } : {}) }
                  : { kind: 'recording' as const },
            }),
      });
      this.profile.set(profile);
      this.step.set('done');
      this.created.emit(profile);
    } catch (err) {
      this.error.set(err as AppError);
    } finally {
      this.busy.set('');
    }
  }

  protected togglePreview(): void {
    const p = this.profile();
    if (!p) return;
    if (this.playingPreview()) {
      this.audio?.pause();
      this.playingPreview.set(false);
      return;
    }
    this.audio?.pause();
    const audio = new Audio(this.ipc.voiceProfileAudioUrl(p.id, 'preview', p.updatedAt));
    this.audio = audio;
    audio.onended = () => this.playingPreview.set(false);
    audio.onerror = () => this.playingPreview.set(false);
    this.playingPreview.set(true);
    void audio.play().catch(() => this.playingPreview.set(false));
  }
}
