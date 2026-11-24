import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';

import { IpcService } from '../../../core/ipc/ipc.service';
import type { SongReason, SongsView } from '../../../core/ipc/cast-songs.types';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { toAppError } from '../../../core/state/project.store';
import { formatTimecode } from '../../../core/util/format';
import { PlaybackService } from './playback.service';
import { markSongLines, SONG_REASON_KEYS } from './songs';
import { StudioStore } from './studio.store';

/**
 * The editor's Songs block (plan 6.2): the lines the app thinks are sung,
 * each with "Keep the original song" or "Not a song" (never applied by the
 * app itself), how many lines are kept as the original song, and whether
 * their subtitles show. A sung OST would otherwise have been dubbed as
 * speech (claude-dubber report F7). Lines are marked one by one, or all the
 * suggested ones at once; the inspector marks the selected lines.
 */
@Component({
  selector: 'vd-songs-panel',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel-block stack songs">
      <h2>{{ 'songs.heading' | translate }}</h2>
      <p class="hint">{{ 'songs.intro' | translate }}</p>

      <div class="row row-between">
        <span class="small">{{ 'songs.count' | translate: { n: songLines().length } }}</span>
        @if (songLines().length > 0) {
          <button type="button" class="btn btn-ghost btn-sm" (click)="selectSongs()">{{ 'songs.select' | translate }}</button>
        }
      </div>

      <label class="check-row">
        <input type="checkbox" [checked]="songSubtitles()" (change)="setSongSubtitles($any($event.target).checked)" [disabled]="busy() || store.dubRunning()" />
        <span>{{ 'songs.subtitles' | translate }}</span>
      </label>
      <p class="hint">{{ 'songs.subtitles-hint' | translate }}</p>

      @if (view()?.seriesParentId) {
        <p class="hint">{{ 'songs.series-hint' | translate }}</p>
      }
      @if (store.project()?.series?.role === 'parent') {
        <p class="hint">{{ 'songs.series-parent-hint' | translate }}</p>
      }
      @if (open().length > 0) {
        <h3>{{ 'songs.suggestions' | translate: { n: open().length } }}</h3>
        <p class="hint">{{ 'songs.suggestions-hint' | translate }}</p>
        <ul class="suggestions">
          @for (s of open(); track s.lineId) {
            <li class="stack-sm">
              <div class="row line">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm mono"
                  (click)="listen(s.lineId, s.startMs, s.endMs)"
                  [title]="'songs.listen' | translate"
                  [attr.aria-label]="'songs.listen-at' | translate: { time: clock(s.startMs) }"
                >
                  ▶ {{ clock(s.startMs) }}
                </button>
                <span class="text">{{ s.text }}</span>
              </div>
              <div class="row reasons">
                @for (r of s.reasons; track r) {
                  <span class="badge badge-info" [title]="reasonKeys[r].title | translate">{{ reasonKeys[r].label | translate }}</span>
                }
              </div>
              <div class="row">
                <button type="button" class="btn btn-sm" (click)="decide([s.lineId], true)" [disabled]="busy() || store.dubRunning()">
                  {{ 'songs.keep' | translate }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" (click)="decide([s.lineId], false)" [disabled]="busy() || store.dubRunning()">
                  {{ 'songs.not-song' | translate }}
                </button>
              </div>
            </li>
          }
        </ul>
        @if (open().length > 1) {
          <button type="button" class="btn btn-sm" (click)="keepAll()" [disabled]="busy() || store.dubRunning()">
            {{ 'songs.keep-all' | translate: { n: open().length } }}
          </button>
        }
      } @else if (view() && !view()!.seriesParentId) {
        <p class="hint muted">{{ 'songs.none' | translate }}</p>
      }
      @if (notice(); as n) {
        <p class="hint" role="status">{{ n }}</p>
      }
    </section>
  `,
  styles: [
    `
      h3 {
        margin: 0;
        font-size: 0.9rem;
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
      .small {
        font-size: 0.82rem;
      }
      .suggestions {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-2);
      }
      .suggestions li {
        padding: var(--vd-sp-2);
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius-sm);
      }
      .line {
        align-items: center;
        gap: var(--vd-sp-2);
      }
      .text {
        font-size: 0.85rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .reasons {
        gap: 4px;
        flex-wrap: wrap;
      }
    `,
  ],
})
export class SongsPanelComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly playback = inject(PlaybackService);
  protected readonly store = inject(StudioStore);

  protected readonly view = signal<SongsView | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly reasonKeys: Record<SongReason, { label: string; title: string }> = SONG_REASON_KEYS;

  /** The lines kept as the original song, as the timeline has them now. */
  protected readonly songLines = computed(() => this.store.segments().filter((s) => s.song === true));
  /** Suggestions still open: a line the inspector kept as a song leaves the list at once. */
  protected readonly open = computed(() => {
    const songs = new Set(this.songLines().map((s) => s.id));
    return (this.view()?.suggestions ?? []).filter((s) => !songs.has(s.lineId));
  });
  protected readonly songSubtitles = computed(() => this.store.settings()?.songSubtitles === true);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.view.set(await this.ipc.getSongs(this.store.projectId()));
    } catch {
      /* an older background service: no suggestions to show */
    }
  }

  protected clock(ms: number): string {
    return formatTimecode(ms);
  }

  /** Select the line and play it: a suggestion is checked by ear. */
  protected listen(id: string, startMs: number, endMs: number): void {
    this.store.select(id);
    this.playback.playRange(startMs, endMs);
  }

  protected selectSongs(): void {
    const ids = this.songLines().map((s) => s.id);
    this.store.selection.set(new Set(ids));
    this.store.primaryId.set(ids[0] ?? null);
  }

  protected async keepAll(): Promise<void> {
    await this.decide(
      this.open().map((s) => s.lineId),
      true,
    );
  }

  /** Keep the lines as the original song, or say they are not one (both settle their suggestions). */
  protected async decide(ids: readonly string[], song: boolean): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      const res = await markSongLines(this.store, this.ipc, ids, song);
      if (res) {
        this.notice.set(
          res.revoice.length > 0
            ? this.translate.instant('songs.revoice', { n: res.revoice.length })
            : song
              ? this.translate.instant('songs.kept', { n: res.changed.length })
              : this.translate.instant('songs.dismissed', { n: ids.length }),
        );
      }
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  /** Subtitles for the song lines: applied at once (the subtitle files follow); the next render shows it. */
  protected async setSongSubtitles(on: boolean): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      const updated = await this.ipc.updateProjectSettings(this.store.projectId(), { songSubtitles: on });
      this.store.project.set(updated.project);
      this.notice.set(this.translate.instant('songs.subtitles-saved'));
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
