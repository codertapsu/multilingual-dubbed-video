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

  async buildTtsTimeline(input: BuildTtsTimelineInput): Promise<{ outputPath: string; durationMs: number }> {
    this.calls.push(`buildTtsTimeline:${input.outputPath}`);
    await this.touch(input.outputPath);
    return { outputPath: input.outputPath, durationMs: input.totalDurationMs };
  }

  async duckAndMix(input: DuckAndMixInput): Promise<{ output: string; durationMs: number }> {
    this.calls.push(`duckAndMix:${input.output}`);
    await this.touch(input.output);
    return { output: input.output, durationMs: 10_000 };
  }

  async renderFinalVideo(input: RenderFinalVideoInput): Promise<RenderFinalVideoResult> {
    this.calls.push(`renderFinalVideo:${input.outputPath}`);
    await this.touch(input.outputPath);
    return { outputPath: input.outputPath, durationMs: 10_000, sidecarSubtitlePaths: [] };
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

  constructor(private readonly durationForSegment: (segmentId: string) => number = () => 1000) {}

  async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
    this.calls += 1;
    const segments = await Promise.all(
      input.segments.map(async (s, i) => {
        const numeric = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
        const audioPath = path.join(input.outputDir, `segment_${String(numeric).padStart(4, '0')}.wav`);
        await fsp.mkdir(input.outputDir, { recursive: true });
        await fsp.writeFile(audioPath, 'wav', 'utf8');
        const durationMs = this.durationForSegment(s.id);
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
