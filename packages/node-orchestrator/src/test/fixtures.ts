/**
 * Shared test fixtures and fakes.
 *
 * Everything here is in-memory or temp-dir based: no ffmpeg, no live workers.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AudioExtractResult,
  CreateProjectInput,
  MediaInfo,
  ProjectSettings,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  SttInput,
  SttProvider,
  SttResult,
  TranscriptSegment,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from '@videodubber/shared';
import type {
  BuildTtsTimelineInput,
  DuckAndMixInput,
  PipelineMediaService,
} from '../media.js';
import { ProviderRegistry } from '../providers/registry.js';

/** Sensible default project settings for tests. */
export function defaultSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    sourceLanguage: 'en-US',
    targetLanguage: 'vi-VN',
    subtitleExportMode: 'srt-file',
    processingMode: 'local',
    sttProviderId: 'faster-whisper',
    translationProviderId: 'argos',
    ttsProviderId: 'piper-local',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    ttsGainDb: 0,
    maxSpeedRatio: 1.15,
    allowedOverflowMs: 300,
    ...overrides,
  };
}

/** Build a CreateProjectInput pointing at a real temp "video" file. */
export function createProjectInput(inputVideoPath: string, overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    name: 'Test Project',
    inputVideoPath,
    settings: defaultSettings(),
    ...overrides,
  };
}

/** Create a unique temp directory for a test. */
export async function makeTempDir(prefix = 'vd-orch-test-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Write a small dummy "video" file (content is irrelevant for tests). */
export async function writeDummyVideo(dir: string, name = 'sample.mp4'): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, 'dummy-video-bytes', 'utf8');
  return p;
}

/** Default media info used by the fake media service. */
export function fakeMediaInfo(durationMs = 10_000): MediaInfo {
  return {
    durationMs,
    container: 'mp4',
    sizeBytes: 1024,
    hasAudio: true,
    videoStreams: [{ index: 0, codec: 'h264', width: 1280, height: 720, fps: 30 }],
    audioStreams: [{ index: 1, codec: 'aac', channels: 2, sampleRate: 48000 }],
  };
}

/**
 * A fully in-memory fake {@link PipelineMediaService}. It writes small marker
 * files for any output path so the runner's resumability checks see artifacts.
 * Per-segment durations can be configured to drive alignment tests.
 */
export class FakeMediaService implements PipelineMediaService {
  public calls: string[] = [];

  constructor(
    private readonly opts: {
      mediaInfo?: MediaInfo;
      /** Map of audioPath -> durationMs returned by probe(). */
      segmentDurations?: Map<string, number>;
      hasAudio?: boolean;
      /** Silence measureSpeech() reports around each clip's speech (default 80 / 220 ms). */
      clipEdges?: { leadMs: number; tailMs: number };
    } = {},
  ) {}

  private async touch(filePath: string, content = 'x'): Promise<void> {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf8');
  }

  async probe(inputPath: string): Promise<MediaInfo> {
    this.calls.push(`probe:${inputPath}`);
    // If this is a per-segment WAV with a configured duration, report it.
    const dur = this.opts.segmentDurations?.get(inputPath);
    if (dur !== undefined) {
      return { ...fakeMediaInfo(dur), durationMs: dur };
    }
    // Otherwise, a TTS-segment WAV may encode its duration as its file content
    // (used by re-synthesis tests where the duration changes when text shortens).
    if (inputPath.includes('tts_segments')) {
      try {
        const n = Number.parseInt(await fsp.readFile(inputPath, 'utf8'), 10);
        if (Number.isFinite(n)) return { ...fakeMediaInfo(n), durationMs: n };
      } catch {
        /* fall through to the default */
      }
    }
    const info = this.opts.mediaInfo ?? fakeMediaInfo();
    return this.opts.hasAudio === false ? { ...info, hasAudio: false, audioStreams: [] } : info;
  }

  async extractAudio(inputPath: string, outputPath: string): Promise<AudioExtractResult> {
    this.calls.push(`extractAudio:${outputPath}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: 48000, channels: 2, durationMs: 10_000 };
  }

  async extract16kMono(inputPath: string, outputPath: string): Promise<AudioExtractResult> {
    this.calls.push(`extract16kMono:${outputPath}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: 16000, channels: 1, durationMs: 10_000 };
  }

  async clip16kMono(
    inputPath: string,
    outputPath: string,
    startMs: number,
    endMs: number,
  ): Promise<AudioExtractResult> {
    this.calls.push(`clip16kMono:${outputPath}:${startMs}-${endMs}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: 16000, channels: 1, durationMs: Math.max(0, endMs - startMs) };
  }

  async referenceClip(
    _inputPath: string,
    outputPath: string,
    opts: { startMs?: number; endMs?: number; maxMs?: number; sampleRate?: number },
  ): Promise<AudioExtractResult> {
    const durationMs = Math.max(0, (opts.endMs ?? opts.maxMs ?? 0) - (opts.startMs ?? 0));
    this.calls.push(`referenceClip:${outputPath}:${opts.startMs ?? 0}-${opts.endMs ?? ''}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: opts.sampleRate ?? 48_000, channels: 1, durationMs };
  }

  async prepareStemInput(inputPath: string, outputPath: string): Promise<AudioExtractResult> {
    this.calls.push(`prepareStemInput:${inputPath}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: 44_100, channels: 2, durationMs: 0 };
  }

  async mixStems(inputPaths: readonly string[], outputPath: string): Promise<AudioExtractResult> {
    this.calls.push(`mixStems:${inputPaths.length}`);
    await this.touch(outputPath);
    return { audioPath: outputPath, sampleRate: 48_000, channels: 2, durationMs: 0 };
  }

  /** Every timeline build's input, so tests can see what the mix was asked to play. */
  public timelineInputs: BuildTtsTimelineInput[] = [];

  async buildTtsTimeline(input: BuildTtsTimelineInput): Promise<{ outputPath: string; durationMs: number }> {
    this.calls.push(`buildTtsTimeline:${input.outputPath}`);
    this.timelineInputs.push(input);
    await this.touch(input.outputPath);
    return { outputPath: input.outputPath, durationMs: input.totalDurationMs };
  }

  async duckAndMix(input: DuckAndMixInput): Promise<{ output: string; durationMs: number }> {
    this.calls.push(`duckAndMix:${input.output}`);
    await this.touch(input.output);
    return { output: input.output, durationMs: 10_000 };
  }

  /** Counts calls so tests can assert the editor's caches are reused. */
  public waveformCalls = 0;
  public filmstripCalls = 0;

  async computeWaveformPeaks(
    _inputPath: string,
    opts?: { peaksPerSecond?: number },
  ): Promise<{ peaksPerSecond: number; durationMs: number; peaks: Int8Array }> {
    this.waveformCalls += 1;
    const pps = opts?.peaksPerSecond ?? 100;
    // 1 s of a rising envelope: deterministic, and non-trivial to encode.
    return { peaksPerSecond: pps, durationMs: 1000, peaks: Int8Array.from({ length: pps * 2 }, (_, i) => (i % 2 ? i % 127 : -(i % 127))) };
  }

  async renderFilmstrip(
    _inputPath: string,
    outputPath: string,
    durationMs: number,
  ): Promise<{ path: string; count: number; columns: number; rows: number; tileWidth: number; tileHeight: number; intervalMs: number }> {
    this.filmstripCalls += 1;
    await this.touch(outputPath, 'jpeg');
    return { path: outputPath, count: 8, columns: 8, rows: 1, tileWidth: 160, tileHeight: 90, intervalMs: Math.round(durationMs / 8) };
  }

  public fittedCalls = 0;

  public fittedTrims: Array<{ startMs: number; endMs: number } | undefined> = [];

  async renderFittedClip(
    _inputPath: string,
    outputPath: string,
    ratio: number,
    trim?: { startMs: number; endMs: number },
  ): Promise<string> {
    this.fittedCalls += 1;
    this.fittedTrims.push(trim);
    await this.touch(outputPath, `fitted@${ratio}${trim ? `[${trim.startMs}-${trim.endMs}]` : ''}`);
    return outputPath;
  }

  /** Every render's input (logo, range, effects…). */
  public renderInputs: RenderFinalVideoInput[] = [];

  async renderFinalVideo(input: RenderFinalVideoInput): Promise<RenderFinalVideoResult> {
    this.calls.push(`renderFinalVideo:${input.outputPath}`);
    this.renderInputs.push(input);
    await this.touch(input.outputPath);
    return { outputPath: input.outputPath, durationMs: 10_000, sidecarSubtitlePaths: [] };
  }

  /** Per-path speech measurements a test wants (e.g. a broken, mostly silent clip). */
  public speech = new Map<string, Awaited<ReturnType<NonNullable<PipelineMediaService['measureSpeech']>>>>();
  public speechCalls = 0;

  /** Thumbnails asked for (`<path>@<ms>`). */
  public thumbnails: string[] = [];

  async renderThumbnail(inputPath: string, atMs: number, outputPath: string): Promise<{ path: string }> {
    this.calls.push(`renderThumbnail:${outputPath}`);
    this.thumbnails.push(`${outputPath}@${atMs}`);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, 'fake-jpeg');
    return { path: outputPath };
  }

  /** Changes of shot a test wants found (ms of the whole video), and the spans asked about. */
  public sceneTimes: number[] = [];
  public sceneSpans: { startMs: number; endMs: number }[] = [];

  async detectSceneChanges(_inputPath: string, spans: readonly { startMs: number; endMs: number }[]): Promise<number[]> {
    this.sceneSpans.push(...spans);
    return this.sceneTimes.filter((t) => spans.some((s) => t >= s.startMs && t <= s.endMs));
  }

  /** Brand kit: the picture kept as it is, with a logo's proportions. */
  async prepareLogo(inputPath: string, outputPath: string): Promise<{ width: number; height: number }> {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.copyFile(inputPath, outputPath);
    return { width: 400, height: 160 };
  }

  /** Brand kit: the sound kept as it is, two seconds long. */
  async prepareGreeting(inputPath: string, outputPath: string): Promise<{ durationMs: number }> {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.copyFile(inputPath, outputPath);
    return { durationMs: 2000 };
  }

  /**
   * A clean clip by default, shaped like a real VieNeu one: ~80 ms of silence
   * before the speech and ~220 ms after it (the media worker's measurements).
   */
  async measureSpeech(wavPath: string): ReturnType<NonNullable<PipelineMediaService['measureSpeech']>> {
    this.speechCalls += 1;
    const custom = this.speech.get(wavPath);
    if (custom) return custom;
    const { durationMs } = await this.probe(wavPath);
    const edges = this.opts.clipEdges ?? { leadMs: 80, tailMs: 220 };
    const speechStartMs = Math.min(edges.leadMs, durationMs);
    const speechEndMs = Math.max(speechStartMs, durationMs - edges.tailMs);
    return {
      durationMs,
      silences: [
        ...(speechStartMs > 0 ? [{ startMs: 0, endMs: speechStartMs }] : []),
        ...(speechEndMs < durationMs ? [{ startMs: speechEndMs, endMs: durationMs }] : []),
      ],
      speechStartMs,
      speechEndMs,
      speechMs: speechEndMs - speechStartMs,
      noiseDb: -40,
      minSilenceMs: 50,
    };
  }

  /** The audio against the picture a test wants measured (default: nothing measured), and the windows asked. */
  public audioDrift: Awaited<ReturnType<NonNullable<PipelineMediaService['measureAudioDrift']>>> = undefined;
  public driftRanges: Array<{ startMs: number; endMs: number } | undefined> = [];

  async measureAudioDrift(
    _inputPath: string,
    _signal?: AbortSignal,
    range?: { startMs: number; endMs: number },
  ): ReturnType<NonNullable<PipelineMediaService['measureAudioDrift']>> {
    this.driftRanges.push(range);
    return this.audioDrift;
  }

  /** Long silent stretches a test wants found in a track (default: none). */
  public trackSilences: Array<{ startMs: number; endMs: number }> = [];

  async detectSilences(
    wavPath: string,
    opts: { noiseDb: number; minSilenceMs: number },
  ): ReturnType<NonNullable<PipelineMediaService['detectSilences']>> {
    this.calls.push(`detectSilences:${wavPath}`);
    const { durationMs } = await this.probe(wavPath);
    return { durationMs, silences: this.trackSilences.filter((s) => s.endMs - s.startMs >= opts.minSilenceMs) };
  }
}

/** A fake STT provider that returns a fixed set of segments. */
export class FakeSttProvider implements SttProvider {
  readonly id = 'faster-whisper';
  readonly displayName = 'Fake STT';
  readonly isLocal = true;
  public calls = 0;

  constructor(private readonly segments: TranscriptSegment[]) {}

  async transcribe(_input: SttInput): Promise<SttResult> {
    this.calls += 1;
    return { segments: this.segments, detectedLanguage: 'en', durationMs: 10_000 };
  }
}

/** A fake translation provider that uppercases as a stand-in translation. */
export class FakeTranslationProvider implements TranslationProvider {
  readonly id = 'argos';
  readonly displayName = 'Fake Translation';
  readonly isLocal = true;
  public calls = 0;

  async translateSegments(input: TranslationInput): Promise<TranslationResult> {
    this.calls += 1;
    return {
      segments: input.segments.map((s) => ({ id: s.id, translatedText: `[vi] ${s.sourceText}` })),
    };
  }
}

/**
 * A fake TTS provider that "writes" a WAV marker per segment and returns
 * configurable durations (so alignment behavior can be exercised).
 */
export class FakeTtsProvider implements TtsProvider {
  readonly id = 'piper-local';
  readonly displayName = 'Fake TTS';
  readonly isLocal = true;
  public calls = 0;
  /** Every request, in order — lets tests assert the voice/speed of each batch. */
  public inputs: TtsInput[] = [];

  constructor(private readonly durationForSegment: (segmentId: string) => number = () => 1000) {}

  async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
    this.calls += 1;
    this.inputs.push(input);
    const segments = await Promise.all(
      input.segments.map(async (s, i) => {
        const numeric = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
        const audioPath = path.join(input.outputDir, `segment_${String(numeric).padStart(4, '0')}.wav`);
        await fsp.mkdir(input.outputDir, { recursive: true });
        const durationMs = this.durationForSegment(s.id);
        // The "WAV" holds its duration, so FakeMediaService measures what was reported.
        await fsp.writeFile(audioPath, String(durationMs), 'utf8');
        return {
          segmentId: s.id,
          text: s.text,
          audioPath,
          durationMs,
          startMs: s.startMs,
          endMs: s.endMs,
          speedRatio: 1,
        };
      }),
    );
    return { segments };
  }
}

/** Build a registry pre-loaded with the provided fakes. */
export function fakeRegistry(
  stt: SttProvider,
  translation: TranslationProvider,
  tts: TtsProvider,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerStt(stt);
  registry.registerTranslation(translation);
  registry.registerTts(tts);
  return registry;
}

/** Build a few transcript segments with given windows (ms). */
export function makeSegments(windows: [start: number, end: number, text: string][]): TranscriptSegment[] {
  return windows.map(([startMs, endMs, sourceText], i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    index: i,
    startMs,
    endMs,
    sourceText,
  }));
}
