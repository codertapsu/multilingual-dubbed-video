import type { ElementRef } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import { formatTimecode } from '../../../core/util/format';
import { PlaybackService, type MonitorMode } from './playback.service';
import { StudioStore } from './studio.store';

/**
 * The preview monitor: the source video, the translated subtitle that is
 * active at the playhead (the source line optionally beneath it), and the
 * transport. The dub itself plays through PlaybackService — the video element
 * only carries the picture and the original audio.
 */
@Component({
  selector: 'vd-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <div class="stage">
      <div class="frame" [style.--ar]="aspect()">
        @if (store.videoUrl(); as url) {
          <video
            #video
            [src]="url"
            preload="auto"
            playsinline
            (click)="playback.toggle()"
            (error)="videoFailed.set(true)"
          ></video>
        }
        @if (videoFailed()) {
          <div class="fail">{{ 'studio.video-unavailable' | translate }}</div>
        }
        @if (activeLine(); as line) {
          <div class="subtitle" aria-live="off">
            <span class="tr">{{ line.translatedText || '…' }}</span>
            @if (showSource()) {
              <span class="src">{{ line.sourceText }}</span>
            }
          </div>
        }
      </div>
    </div>

    <div class="transport" role="toolbar" [attr.aria-label]="'studio.transport' | translate">
      <div class="group">
        <button
          type="button"
          class="icon-btn"
          (click)="stepLine(-1)"
          [title]="'studio.prev-line' | translate"
        >
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          (click)="playback.skip(-frameMs())"
          [title]="'studio.frame-back' | translate"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M11 6v12l-8-6zM21 6v12l-8-6z" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn play"
          (click)="playback.toggle()"
          [title]="(playback.playing() ? 'studio.pause' : 'studio.play') | translate"
          [attr.aria-label]="(playback.playing() ? 'studio.pause' : 'studio.play') | translate"
        >
          @if (playback.playing()) {
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          } @else {
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg>
          }
        </button>
        <button
          type="button"
          class="icon-btn"
          (click)="playback.skip(frameMs())"
          [title]="'studio.frame-forward' | translate"
        >
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 6v12l8-6zM3 6v12l8-6z" /></svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          (click)="stepLine(1)"
          [title]="'studio.next-line' | translate"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
          </svg>
        </button>
        <span class="tc mono"
          >{{ fmt(playback.currentMs()) }}
          <span class="muted">/ {{ fmt(store.durationMs()) }}</span></span
        >
        @if (playback.rate() !== 1) {
          <span class="badge badge-info">{{ playback.rate() }}×</span>
        }
      </div>
      <div class="group">
        <div class="seg-control" role="radiogroup" [attr.aria-label]="'studio.monitor' | translate">
          @for (m of monitors; track m) {
            <button
              type="button"
              role="radio"
              [class.active]="playback.monitor() === m"
              [attr.aria-checked]="playback.monitor() === m"
              (click)="playback.setMonitor(m)"
              [title]="monitorKeys[m].title | translate"
            >
              {{ monitorKeys[m].label | translate }}
            </button>
          }
        </div>
        <label class="vol" [title]="'studio.original-volume' | translate">
          <span class="visually-hidden">{{ 'studio.original-volume' | translate }}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="6" width="13" height="12" rx="2" />
            <path d="M16 10l5-3v10l-5-3" />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            [value]="playback.originalVolume()"
            (input)="playback.setOriginalVolume(+$any($event.target).value)"
          />
        </label>
        <label class="vol" [title]="'studio.dub-volume' | translate">
          <span class="visually-hidden">{{ 'studio.dub-volume' | translate }}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path
              d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"
            />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            [value]="playback.dubVolume()"
            (input)="playback.setDubVolume(+$any($event.target).value)"
          />
        </label>
        <button
          type="button"
          class="icon-btn"
          [class.active]="showSource()"
          (click)="toggleSource()"
          [title]="'studio.show-source' | translate"
          [attr.aria-pressed]="showSource()"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M4 7h16M4 12h10M4 17h7" />
          </svg>
        </button>
      </div>
    </div>
    @if (playback.audioIssue(); as issue) {
      <p class="hint issue">{{ issue | translate }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        background: #000;
      }
      /* The stage is the space available; the frame is the PICTURE: the
         largest box of the video's aspect ratio that fits (container units),
         so the subtitle overlay sits on the image, not in a letterbox bar. */
      .stage {
        flex: 1;
        min-height: 0;
        container-type: size;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: #000;
      }
      .frame {
        position: relative;
        width: min(100cqw, 100cqh * var(--ar, 1.7778));
        aspect-ratio: var(--ar, 1.7778);
        background: #000;
      }
      video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #000;
        cursor: pointer;
      }
      .fail {
        position: absolute;
        color: #ddd;
        font-size: 0.9rem;
        padding: var(--vd-sp-4);
        text-align: center;
      }
      .subtitle {
        position: absolute;
        left: 6%;
        right: 6%;
        bottom: 7%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        text-align: center;
        pointer-events: none;
      }
      .subtitle .tr {
        display: inline-block;
        max-width: 100%;
        padding: 2px 8px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.45);
        color: #fff;
        font-size: clamp(13px, 2.2vw, 22px);
        font-weight: 600;
        line-height: 1.3;
        text-shadow:
          0 0 3px #000,
          0 0 2px #000;
      }
      .subtitle .src {
        color: #cfd6e0;
        font-size: clamp(11px, 1.5vw, 15px);
        text-shadow: 0 0 3px #000;
      }
      .transport {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--vd-sp-2);
        padding: 6px var(--vd-sp-3);
        background: var(--vd-surface);
        border-top: 1px solid var(--vd-border);
      }
      .group {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .play {
        width: 36px;
        height: 36px;
        color: var(--vd-text);
      }
      .tc {
        margin-left: var(--vd-sp-2);
        font-size: 0.85rem;
      }
      .vol {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 0 0 0 var(--vd-sp-2);
        color: var(--vd-text-muted);
      }
      .vol svg {
        width: 16px;
        height: 16px;
      }
      .vol input {
        width: 72px;
      }
      .issue {
        margin: 0;
        padding: 2px var(--vd-sp-3);
        background: var(--vd-surface);
      }
    `,
  ],
})
export class PreviewComponent {
  protected readonly store = inject(StudioStore);
  protected readonly playback = inject(PlaybackService);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  protected readonly monitors: readonly MonitorMode[] = ['mix', 'original', 'dub'];
  protected readonly monitorKeys: Record<MonitorMode, { label: string; title: string }> = {
    mix: { label: 'studio.monitor-mix', title: 'studio.monitor-mix-title' },
    original: { label: 'studio.monitor-original', title: 'studio.monitor-original-title' },
    dub: { label: 'studio.monitor-dub', title: 'studio.monitor-dub-title' },
  };
  protected readonly videoFailed = signal(false);
  protected readonly showSource = signal(localStorage.getItem('vd.studio.showSource') === '1');

  /** Width/height of the picture (16:9 until probed). */
  protected readonly aspect = computed(() => {
    const m = this.store.media();
    return m?.width && m?.height ? String(m.width / m.height) : String(16 / 9);
  });

  /** One frame at the source frame rate (30 fps when unknown). */
  protected readonly frameMs = computed(() => 1000 / (this.store.media()?.fps || 30));

  /** The line under the playhead (voice-synced cue timing when the line has one). */
  protected readonly activeLine = computed(() => {
    const t = this.playback.currentMs();
    const overrides = this.store.cueOverrides();
    for (const s of this.store.segments()) {
      const o = overrides[s.id];
      const start = o?.startMs ?? s.startMs;
      const end = o?.endMs ?? s.endMs;
      if (start <= t && t < end) return s;
      if (s.startMs > t + 30_000) break;
    }
    return null;
  });

  constructor() {
    // The <video> only exists once the document has loaded (it needs the URL),
    // so attach whenever the element appears rather than once after view init.
    let attached: HTMLVideoElement | null = null;
    effect(() => {
      const el = this.video()?.nativeElement ?? null;
      if (el && el !== attached) {
        attached = el;
        this.videoFailed.set(false);
        this.playback.attach(el);
      }
    });
  }

  protected fmt(ms: number): string {
    return formatTimecode(ms);
  }

  protected stepLine(delta: number): void {
    const seg = this.store.step(delta);
    if (seg) this.playback.seek(seg.startMs);
  }

  toggleSource(): void {
    this.showSource.update((v) => !v);
    localStorage.setItem('vd.studio.showSource', this.showSource() ? '1' : '0');
  }
}
