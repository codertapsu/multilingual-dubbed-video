import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, type OnDestroy, type OnInit } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TranslatePipe } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import { ActivityService } from '../../../core/activity/activity.service';
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
  private readonly activity = inject(ActivityService);

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

  /**
   * The model downloading now, and how far: from the app-wide activity service,
   * so it is still shown after Settings was left and opened again, and a click
   * is answered at once ("Starting…"). Before, a stream of this page's own
   * followed it and died with the page.
   */
  protected readonly downloading = computed<string | null>(() => {
    const t = this.activity.running().find((x) => x.id.startsWith('setup:whisper:'));
    return t ? t.id.slice('setup:whisper:'.length) : null;
  });
  protected readonly downloadProgress = computed(() => {
    const id = this.downloading();
    return id ? (this.activity.setupItem(`whisper:${id}`) ?? null) : null;
  });

  constructor() {
    // A download run ended (here or anywhere): what is on disk changed.
    let seen = this.activity.setupChanges();
    effect(() => {
      const n = this.activity.setupChanges();
      if (n === seen) return;
      seen = n;
      untracked(() => void this.loadModels());
    });
  }

  ngOnDestroy(): void {
    /* the activity service keeps following the download */
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
    this.activity.markStarting('model', `whisper:${id}`);
    try {
      await this.ipc.setupInstallModels({ whisperModel: id });
    } catch (err) {
      this.activity.markFailed('model', `whisper:${id}`, toAppError(err));
      this.store.error.set(toAppError(err));
    }
  }

  protected useModel(id: string): void {
    void this.store.setDefault('sttModel', id);
  }
}
