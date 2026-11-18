/**
 * Recording a voice for cloning, in the webview.
 *
 * Raw samples through an AudioWorklet, encoded to 16-bit WAV here: lossless,
 * which a voice reference should be. MediaRecorder is the fallback where the
 * worklet cannot load; it gives Opus (WebView2) or AAC (WKWebView), which the
 * orchestrator decodes like any import. The browser's echo cancellation, noise
 * suppression and gain control are off: they colour the voice, and the
 * cloning engine denoises the reference itself.
 */
import { signal } from '@angular/core';

export type RecorderError = 'mic-denied' | 'mic-none' | 'mic-busy' | 'mic-unsupported' | 'mic-failed';

/** 16-bit PCM WAV from float samples (-1..1). Pure. */
export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let at = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, at += 2) {
      const s = Math.max(-1, Math.min(1, chunk[i]!));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return buffer;
}

/** RMS of a block, 0..1, for the level meter. Pure. */
export function blockLevel(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  return Math.sqrt(sum / Math.max(1, block.length));
}

export function recorderErrorOf(err: unknown): RecorderError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic-none';
  if (name === 'NotReadableError' || name === 'AbortError') return 'mic-busy';
  return 'mic-failed';
}

/** Longest recording kept (a reference needs seconds; this bounds memory). */
const MAX_SECONDS = 120;

export class VoiceRecorder {
  readonly state = signal<'idle' | 'starting' | 'recording' | 'stopped'>('idle');
  readonly level = signal(0);
  readonly seconds = signal(0);
  readonly error = signal<RecorderError | null>(null);

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48_000;
  private media: MediaRecorder | null = null;
  private mediaParts: Blob[] = [];
  private mediaStopped: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = 0;

  static supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  /** Microphones (names appear once the user has allowed the microphone). */
  async microphones(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  }

  async start(deviceId?: string): Promise<void> {
    this.dispose();
    this.error.set(null);
    if (!VoiceRecorder.supported()) {
      this.error.set('mic-unsupported');
      return;
    }
    this.state.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      this.state.set('idle');
      this.error.set(recorderErrorOf(err));
      return;
    }
    this.chunks = [];
    this.mediaParts = [];
    try {
      this.ctx = new AudioContext();
      this.sampleRate = this.ctx.sampleRate;
      await this.ctx.audioWorklet.addModule('assets/audio/recorder-worklet.js');
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'vd-recorder');
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.seconds() >= MAX_SECONDS) return;
        this.chunks.push(e.data);
        this.level.set(Math.min(1, blockLevel(e.data) * 4));
      };
      source.connect(this.node);
      // Not connected to the speakers: the user must not hear themselves.
    } catch {
      // No worklet here: record compressed audio instead.
      this.ctx?.close().catch(() => undefined);
      this.ctx = null;
      this.node = null;
      this.media = new MediaRecorder(this.stream);
      this.mediaStopped = new Promise((resolve) => {
        this.media!.onstop = () => resolve();
      });
      this.media.ondataavailable = (e) => {
        if (e.data.size > 0) this.mediaParts.push(e.data);
      };
      this.media.start(250);
    }
    this.started = Date.now();
    this.seconds.set(0);
    this.timer = setInterval(() => {
      const s = (Date.now() - this.started) / 1000;
      this.seconds.set(Math.floor(s * 10) / 10);
      if (s >= MAX_SECONDS) void this.stop();
    }, 100);
    this.state.set('recording');
  }

  /** Stop and return the recording (WAV, or the compressed fallback). */
  async stop(): Promise<Blob | null> {
    if (this.state() !== 'recording') return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let blob: Blob;
    if (this.media) {
      this.media.stop();
      await this.mediaStopped;
      blob = new Blob(this.mediaParts, { type: this.media.mimeType || 'audio/webm' });
    } else {
      blob = new Blob([encodeWav(this.chunks, this.sampleRate)], { type: 'audio/wav' });
    }
    this.releaseDevices();
    this.level.set(0);
    this.state.set('stopped');
    return blob;
  }

  private releaseDevices(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.media = null;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseDevices();
    this.chunks = [];
    this.mediaParts = [];
    this.state.set('idle');
    this.level.set(0);
  }
}
