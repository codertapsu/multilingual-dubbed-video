import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, type OnDestroy, type OnInit } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TranslatePipe } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import { SetupEventsService } from '../../../core/ipc/setup-events.service';
import type { WhisperModelInfo } from '../../../core/models/setup';
import { toAppError } from '../../../core/state/project.store';
import { DefaultEngineComponent } from '../components/default-engine.component';
import { EngineFamilyCardComponent } from '../components/engine-family-card.component';
import { ProviderRowComponent } from '../components/provider-row.component';
import { SPEECH_MODELS, familiesForPage, familyOfProvider } from '../engine-families';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Engines & models → Speech-to-text: the default engine and speech
 * model for new projects, and the Whisper family — the built-in faster-whisper
 * with its downloadable models (PhoWhisper among them), whisper.cpp on an
 * NVIDIA card with its model packs — then the cloud option.
 *
 * The built-in models could only be downloaded in the first-run wizard: Home's
 * "Download in Settings" led to a page with no way to do it. They download
 * here now, through the same setup installer the wizard uses.
 */
@Component({
  selector: 'vd-settings-stt',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, TranslatePipe, DefaultEngineComponent, EngineFamilyCardComponent, ProviderRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stt-section.component.html',
  styleUrls: ['../settings-shared.scss', './engine-page.scss'],
})
export class SttSectionComponent implements OnInit, OnDestroy {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly setupEvents = inject(SetupEventsService);

  protected readonly speechModels = SPEECH_MODELS;
  protected readonly builtInModels = SPEECH_MODELS.filter((m) => !m.phoWhisper);
  protected readonly phoWhisperModels = SPEECH_MODELS.filter((m) => m.phoWhisper);

  /** The Whisper family's packs on this machine (whisper.cpp and its models), if any. */
  protected readonly whisper = computed(() => this.store.families().find((f) => f.id === 'whisper') ?? null);
  /** Any other speech-to-text family a newer catalog adds. */
  protected readonly otherFamilies = computed(() => familiesForPage(this.store.families(), 'stt').filter((f) => f.id !== 'whisper'));

  /** Engines with nothing to download here: faster-whisper is on the Whisper card, the rest are cloud. */
  protected readonly otherProviders = computed(() =>
    this.store
      .providersFor('stt')
      .filter((p) => p.id !== 'faster-whisper' && !familyOfProvider(p, this.store.families())),
  );

  // ---- built-in (faster-whisper) models: the setup catalog and what is on disk
  protected readonly catalog = signal<WhisperModelInfo[]>([]);
  protected readonly downloaded = signal<Set<string> | null>(null);
  /** The model being downloaded now (from the click on). */
  protected readonly downloading = signal<string | null>(null);
  /** The model whose install run is being followed (from the moment the stream is connected). */
  private readonly following = signal<string | null>(null);
  protected readonly downloadProgress = computed(() => {
    const id = this.following();
    return id ? (this.setupEvents.items().find((i) => i.item === `whisper:${id}`) ?? null) : null;
  });

  constructor() {
    // The download ends on its item's completion, the run's end, or an error.
    // Followed only once connected: until then the stream still holds the
    // previous run's `done`, which would end this one before it began.
    effect(() => {
      if (!this.following()) return;
      const finished = this.downloadProgress()?.done || this.setupEvents.done();
      const failed = this.setupEvents.error();
      if (!finished && !failed) return;
      untracked(() => {
        if (failed) this.store.error.set(failed);
        this.following.set(null);
        this.downloading.set(null);
        void this.loadModels();
      });
    });
  }

  ngOnDestroy(): void {
    // The download goes on in the background; only the progress stream stops.
    if (this.following()) this.setupEvents.disconnect();
  }

  ngOnInit(): void {
    void this.loadModels();
  }

  private async loadModels(): Promise<void> {
    const [catalog, status] = await Promise.all([
      this.ipc.setupGetCatalog().catch(() => null),
      this.ipc.setupGetStatus().catch(() => null),
    ]);
    if (catalog) this.catalog.set(catalog.whisperModels);
    this.downloaded.set(status ? new Set(status.installed.whisperModels) : null);
  }

  protected isDownloaded(id: string): boolean {
    return this.downloaded()?.has(id) === true;
  }

  protected sizeOf(id: string): number | null {
    return this.catalog().find((m) => m.id === id)?.approxSizeMb ?? null;
  }

  /** The speech model new projects use: the saved one, else the recommendation. */
  protected readonly defaultModel = computed(() => this.store.defaults().sttModel ?? this.store.effective()?.sttModel ?? null);

  protected isRecommended(id: string): boolean {
    return this.store.system()?.recommendation.whisperModel === id;
  }

  protected async download(id: string): Promise<void> {
    if (this.downloading()) return;
    this.store.error.set(null);
    this.downloading.set(id);
    try {
      // Start the install first, then follow it: the POST resets the setup
      // bus, so connecting afterwards can't replay a finished earlier run
      // (the wizard's reasoning, new-project-wizard.component.ts).
      await this.ipc.setupInstallModels({ whisperModel: id });
      this.setupEvents.connect();
      this.following.set(id);
    } catch (err) {
      this.downloading.set(null);
      this.store.error.set(toAppError(err));
    }
  }

  protected useModel(id: string): void {
    void this.store.setDefault('sttModel', id);
  }
}
