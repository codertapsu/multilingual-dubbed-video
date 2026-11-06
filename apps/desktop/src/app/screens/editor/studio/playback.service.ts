import type { OnDestroy } from '@angular/core';
import { Injectable, NgZone, computed, inject, signal } from '@angular/core';

/** A dub clip as the preview plays it. */
export interface PreviewClip {
  id: string;
  /** Where it starts on the timeline (ms). */
  startMs: number;
  /** How long it plays (ms) — its placed (fitted) duration. */
  durationMs: number;
  /** A 1x-playable WAV: the raw clip, or one tempo-fitted like the final mix. */
  url: string;
}

/** What the speakers carry: the simulated final mix, or one side of it. */
export type MonitorMode = 'mix' | 'original' | 'dub';

/** How the final mix treats the original soundtrack (project settings). */
export type OriginalMode = 'keep' | 'remove' | 'replace-vocals';

const LOOKAHEAD_S = 2;
const TICK_MS = 120;
const RESYNC_MS = 70;
const MAX_BUFFERS = 80;

/**
 * Live dub preview: the video plays the picture (and the original audio), and
 * the dub clips play through WebAudio at their placements, so a timing edit
 * is HEARD the moment it is made — no re-mix, no render.
 *
 * Why WebAudio and not one <audio> per clip: WebAudio schedules on the audio
 * clock (sample-accurate, no per-element seek latency), and once its context
 * is resumed inside the first Play gesture it needs no further user gestures.
 * WKWebView's autoplay policy otherwise blocks a programmatic audio.play().
 * The catch is that WebAudio changes speed by resampling (pitch shift); clips
 * the aligner sped up are therefore fetched pre-fitted from the orchestrator
 * (same atempo chain as the final mix) and played at 1×.
 *
 * Clock model: the VIDEO is the master. Clips are scheduled against an anchor
 * (media time ↔ audio-context time); every tick the anchor is compared with
 * video.currentTime and re-taken if they drift apart by more than 70 ms.
 */
@Injectable()
export class PlaybackService implements OnDestroy {
  private readonly zone = inject(NgZone);

  readonly currentMs = signal(0);
  readonly playing = signal(false);
  readonly rate = signal(1);
  readonly monitor = signal<MonitorMode>('mix');
  readonly originalVolume = signal(readNumber('vd.studio.origVol', 0.9));
  readonly dubVolume = signal(readNumber('vd.studio.dubVol', 1));
  readonly durationMs = signal(0);
  /** A decode/fetch problem with the preview (shown once, non-fatal). */
  readonly audioIssue = signal<string | null>(null);

  /** Project mix settings (the editor keeps these in sync with the project). */
  readonly duckingDb = signal(-15);
  readonly originalMode = signal<OriginalMode>('keep');

  readonly activeClipIds = signal<ReadonlySet<string>>(new Set());
  readonly isDucking = computed(() => this.activeClipIds().size > 0);

  private video: HTMLVideoElement | null = null;
  private ctx: AudioContext | null = null;
  private dubGain: GainNode | null = null;
  private clips: PreviewClip[] = [];
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly sources = new Map<string, AudioBufferSourceNode>();
  private anchor: { mediaMs: number; ctxTime: number; rate: number } | null = null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private raf = 0;
  private stopAtMs: number | null = null;
  private readonly cleanup: (() => void)[] = [];

  attach(video: HTMLVideoElement): void {
    this.detach();
    this.video = video;
    // Picture follows the shuttle speed without the chipmunk effect.
    video.preservesPitch = true;
    const on = (type: string, fn: () => void): void => {
      video.addEventListener(type, fn);
      this.cleanup.push(() => video.removeEventListener(type, fn));
    };
    on('play', () => this.onPlay());
    on('pause', () => this.onPause());
    on('ended', () => this.onPause());
    on('seeking', () => this.stopSources());
    on('seeked', () => {
      this.currentMs.set(video.currentTime * 1000);
      if (!video.paused) this.reanchor();
      this.prefetchAround(video.currentTime * 1000);
    });
    on('ratechange', () => {
      this.rate.set(video.playbackRate);
      if (!video.paused) this.reanchor();
    });
    on('loadedmetadata', () =>
      this.durationMs.set(Number.isFinite(video.duration) ? video.duration * 1000 : 0),
    );
    on('timeupdate', () => {
      if (video.paused) this.currentMs.set(video.currentTime * 1000);
    });
    this.applyVolumes();
  }

  detach(): void {
    this.onPause();
    for (const fn of this.cleanup.splice(0)) fn();
    this.video = null;
  }

  ngOnDestroy(): void {
    this.detach();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  setClips(clips: PreviewClip[]): void {
    this.clips = [...clips].sort((a, b) => a.startMs - b.startMs);
    // Drop decoded buffers no clip refers to any more (a regenerated clip has a new URL).
    const urls = new Set(this.clips.map((c) => c.url));
    for (const url of this.buffers.keys()) if (!urls.has(url)) this.buffers.delete(url);
    if (this.playing()) this.reanchor();
    else this.prefetchAround(this.currentMs());
  }

  // ------------------------------------------------------------- transport

  /** MUST be called from a user gesture the first time (it unlocks audio). */
  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    const v = this.video;
    if (!v) return;
    this.ensureAudio();
    this.stopAtMs = null;
    void v.play().catch(() => undefined);
  }

  pause(): void {
    this.stopAtMs = null;
    this.video?.pause();
  }

  seek(ms: number): void {
    const v = this.video;
    const clamped = Math.max(0, Math.min(ms, this.durationMs() || ms));
    this.currentMs.set(clamped);
    if (v) v.currentTime = clamped / 1000;
  }

  /** Nudge the playhead (frame steps, 1 s jumps). */
  skip(deltaMs: number): void {
    this.seek(this.currentMs() + deltaMs);
  }

  /** Play [startMs, endMs) once and stop (the inspector's "play line"). */
  playRange(startMs: number, endMs: number): void {
    this.seek(Math.max(0, startMs - 150));
    this.play();
    this.stopAtMs = endMs + 250;
  }

  setRate(rate: number): void {
    if (this.video) this.video.playbackRate = rate;
    this.rate.set(rate);
  }

  /** L: play, then step up 1x → 1.5x → 2x. K: pause. J: back 2 s (WebKit cannot play in reverse). */
  shuttle(key: 'j' | 'k' | 'l'): void {
    if (key === 'k') return this.pause();
    if (key === 'j') {
      this.skip(-2000);
      return;
    }
    if (!this.playing()) {
      this.setRate(1);
      this.play();
      return;
    }
    const steps = [1, 1.5, 2];
    this.setRate(steps[Math.min(steps.length - 1, steps.indexOf(this.rate()) + 1)] ?? 1);
  }

  setMonitor(mode: MonitorMode): void {
    this.monitor.set(mode);
    this.applyVolumes();
  }

  setOriginalVolume(v: number): void {
    this.originalVolume.set(v);
    writeNumber('vd.studio.origVol', v);
    this.applyVolumes();
  }

  setDubVolume(v: number): void {
    this.dubVolume.set(v);
    writeNumber('vd.studio.dubVol', v);
    this.applyVolumes();
  }

  // ------------------------------------------------------------- internals

  private ensureAudio(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.dubGain = this.ctx.createGain();
        this.dubGain.connect(this.ctx.destination);
      } catch {
        this.audioIssue.set('studio.preview-no-audio');
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.applyVolumes();
  }

  private onPlay(): void {
    this.playing.set(true);
    this.ensureAudio();
    this.reanchor();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.zone.runOutsideAngular(() => {
      const loop = (): void => {
        const v = this.video;
        if (!v || v.paused) return;
        const ms = v.currentTime * 1000;
        this.zone.run(() => this.currentMs.set(ms));
        if (this.stopAtMs !== null && ms >= this.stopAtMs) {
          this.zone.run(() => this.pause());
          return;
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    });
  }

  private onPause(): void {
    this.playing.set(false);
    clearInterval(this.tickTimer);
    cancelAnimationFrame(this.raf);
    this.stopSources();
    this.anchor = null;
    this.activeClipIds.set(new Set());
    this.applyVolumes();
    if (this.video) this.currentMs.set(this.video.currentTime * 1000);
  }

  private reanchor(): void {
    const v = this.video;
    const ctx = this.ctx;
    if (!v || !ctx) return;
    this.stopSources();
    this.anchor = {
      mediaMs: v.currentTime * 1000,
      ctxTime: ctx.currentTime,
      rate: v.playbackRate || 1,
    };
    this.scheduleWindow();
  }

  private mediaNow(): number {
    const a = this.anchor;
    if (!a || !this.ctx) return this.currentMs();
    return a.mediaMs + (this.ctx.currentTime - a.ctxTime) * 1000 * a.rate;
  }

  private tick(): void {
    const v = this.video;
    if (!v || v.paused || !this.anchor) return;
    const videoMs = v.currentTime * 1000;
    if (Math.abs(videoMs - this.mediaNow()) > RESYNC_MS) {
      this.reanchor();
    } else {
      this.scheduleWindow();
    }
    const active = new Set(
      this.clips
        .filter((c) => c.startMs <= videoMs && videoMs < c.startMs + c.durationMs)
        .map((c) => c.id),
    );
    if (!sameSet(active, this.activeClipIds())) this.activeClipIds.set(active);
    this.applyVolumes();
  }

  private scheduleWindow(): void {
    const ctx = this.ctx;
    const a = this.anchor;
    if (!ctx || !a || !this.dubGain) return;
    const now = this.mediaNow();
    const horizon = now + LOOKAHEAD_S * 1000 * a.rate;
    for (const clip of this.clips) {
      if (clip.startMs > horizon) break;
      if (clip.startMs + clip.durationMs <= now || this.sources.has(clip.id)) continue;
      const pending = this.buffer(clip.url);
      // Mark as scheduled now so the next tick doesn't queue it twice.
      this.sources.set(clip.id, null as unknown as AudioBufferSourceNode);
      void pending.then((buf) => {
        if (!buf || this.anchor !== a || !this.ctx || !this.dubGain) {
          if (this.sources.get(clip.id) === null) this.sources.delete(clip.id);
          return;
        }
        const when = a.ctxTime + (clip.startMs - a.mediaMs) / 1000 / a.rate;
        const startAt = Math.max(when, this.ctx.currentTime);
        const offset = Math.max(0, (startAt - when) * a.rate);
        if (offset >= buf.duration) {
          this.sources.delete(clip.id);
          return;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = a.rate;
        src.connect(this.dubGain);
        src.onended = () => {
          if (this.sources.get(clip.id) === src) this.sources.delete(clip.id);
        };
        src.start(startAt, offset);
        this.sources.set(clip.id, src);
      });
    }
  }

  private stopSources(): void {
    for (const src of this.sources.values()) {
      try {
        src?.stop();
      } catch {
        /* never started */
      }
    }
    this.sources.clear();
  }

  private buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url);
    if (!p) {
      const ctx = this.ctx;
      p = ctx
        ? fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => ctx.decodeAudioData(data))
            .catch(() => {
              this.audioIssue.set('studio.preview-clip-failed');
              this.buffers.delete(url);
              return null;
            })
        : Promise.resolve(null);
      this.buffers.set(url, p);
      while (this.buffers.size > MAX_BUFFERS)
        this.buffers.delete(this.buffers.keys().next().value!);
    }
    return p;
  }

  /** Decode the clips around the playhead so pressing Play is instant. */
  private prefetchAround(ms: number): void {
    if (!this.ctx) return;
    for (const clip of this.clips) {
      if (clip.startMs + clip.durationMs < ms - 1000) continue;
      if (clip.startMs > ms + 6000) break;
      void this.buffer(clip.url);
    }
  }

  private applyVolumes(): void {
    const v = this.video;
    const mode = this.monitor();
    const orig = this.originalVolume();
    const dub = this.dubVolume();
    if (this.dubGain) this.dubGain.gain.value = mode === 'original' ? 0 : dub;
    if (!v) return;
    let videoVol = orig;
    if (mode === 'dub') videoVol = 0;
    else if (mode === 'mix') {
      // Simulate the final mix: the original is dropped entirely, or ducked
      // under the dub while it speaks.
      if (this.originalMode() === 'remove') videoVol = 0;
      else if (this.isDucking()) videoVol = orig * Math.pow(10, Math.min(0, this.duckingDb()) / 20);
    }
    v.volume = Math.max(0, Math.min(1, videoVol));
    v.muted = videoVol <= 0;
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function readNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && localStorage.getItem(key) !== null ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* ignore */
  }
}
