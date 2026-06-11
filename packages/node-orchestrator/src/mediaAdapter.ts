/**
 * Composition root adapter for the real ffmpeg-backed media service.
 *
 * `@videodubber/media-worker` exports `FfmpegMediaService` (implements the
 * shared `MediaService`) plus helper functions for the extra operations the
 * pipeline needs (`extract16kMono`, `buildTtsTimeline`, `duckAndMix`). The exact
 * surface of that package is owned by the media-worker agent; to stay decoupled
 * (and to keep this package compiling even while media-worker is being built in
 * parallel), we load it dynamically and adapt whatever it provides to our
 * {@link PipelineMediaService} interface.
 *
 * If the media-worker package or a required helper is missing, the adapter
 * throws a clear {@link AppErrorException} at call time (not import time), so
 * the orchestrator still starts and reports the problem via the normal error
 * channel.
 */
import { AppErrorException } from '@videodubber/shared';
import type {
  BuildTtsTimelineInput,
  DuckAndMixInput,
  PipelineMediaService,
} from './media.js';
import type {
  AudioExtractResult,
  MediaInfo,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
} from '@videodubber/shared';

/**
 * Loosely-typed view of the media-worker module. We only assert the members we
 * use; missing ones are detected at runtime and surfaced as errors.
 */
interface MediaWorkerModule {
  FfmpegMediaService?: new () => {
    probe(inputPath: string): Promise<MediaInfo>;
    extractAudio(inputPath: string, outputPath: string): Promise<AudioExtractResult>;
    renderFinalVideo(input: RenderFinalVideoInput): Promise<RenderFinalVideoResult>;
    extract16kMono?(inputPath: string, outputPath: string): Promise<AudioExtractResult>;
    clip16kMono?(inputPath: string, outputPath: string, startMs: number, endMs: number): Promise<AudioExtractResult>;
    buildTtsTimeline?(input: BuildTtsTimelineInput): Promise<{ outputPath: string; durationMs: number }>;
    duckAndMix?(input: DuckAndMixInput): Promise<{ output: string; durationMs: number }>;
  };
  extract16kMono?(inputPath: string, outputPath: string): Promise<AudioExtractResult>;
  clip16kMono?(inputPath: string, outputPath: string, startMs: number, endMs: number): Promise<AudioExtractResult>;
  buildTtsTimeline?(input: BuildTtsTimelineInput): Promise<{ outputPath: string; durationMs: number }>;
  duckAndMix?(input: DuckAndMixInput): Promise<{ output: string; durationMs: number }>;
}

function missing(op: string): never {
  throw new AppErrorException('UNKNOWN', `media-worker does not provide "${op}".`, {
    remediation:
      'Ensure @videodubber/media-worker is built and exports FfmpegMediaService plus extract16kMono/buildTtsTimeline/duckAndMix.',
    docsRef: 'docs/ARCHITECTURE.md#media-worker',
  });
}

/**
 * Build the real {@link PipelineMediaService} backed by ffmpeg via the
 * media-worker package. The import is dynamic so this module compiles even if
 * the media-worker types are not yet available during a parallel build.
 */
export async function createFfmpegMediaService(): Promise<PipelineMediaService> {
  let mod: MediaWorkerModule;
  try {
    // Dynamic import keeps the dependency soft at build time.
    mod = (await import('@videodubber/media-worker')) as unknown as MediaWorkerModule;
  } catch (err) {
    throw new AppErrorException('FFMPEG_NOT_FOUND', 'Failed to load @videodubber/media-worker.', {
      cause: err instanceof Error ? err.message : String(err),
      remediation: 'Build the media-worker package (pnpm --filter @videodubber/media-worker build).',
    });
  }

  if (!mod.FfmpegMediaService) {
    throw new AppErrorException('UNKNOWN', '@videodubber/media-worker does not export FfmpegMediaService.', {
      remediation: 'Verify the media-worker build output and its exports.',
    });
  }

  const svc = new mod.FfmpegMediaService();

  // Prefer instance methods; fall back to module-level helper functions for the
  // pipeline-only operations (the media-worker may expose them either way).
  const extract16kMono =
    typeof svc.extract16kMono === 'function'
      ? svc.extract16kMono.bind(svc)
      : typeof mod.extract16kMono === 'function'
        ? mod.extract16kMono
        : undefined;

  const clip16kMono =
    typeof svc.clip16kMono === 'function'
      ? svc.clip16kMono.bind(svc)
      : typeof mod.clip16kMono === 'function'
        ? mod.clip16kMono
        : undefined;

  const buildTtsTimeline =
    typeof svc.buildTtsTimeline === 'function'
      ? svc.buildTtsTimeline.bind(svc)
      : typeof mod.buildTtsTimeline === 'function'
        ? mod.buildTtsTimeline
        : undefined;

  const duckAndMix =
    typeof svc.duckAndMix === 'function'
      ? svc.duckAndMix.bind(svc)
      : typeof mod.duckAndMix === 'function'
        ? mod.duckAndMix
        : undefined;

  const adapter: PipelineMediaService = {
    probe: (inputPath) => svc.probe(inputPath),
    extractAudio: (inputPath, outputPath) => svc.extractAudio(inputPath, outputPath),
    renderFinalVideo: (input) => svc.renderFinalVideo(input),
    extract16kMono: (inputPath, outputPath) =>
      extract16kMono ? extract16kMono(inputPath, outputPath) : missing('extract16kMono'),
    buildTtsTimeline: (input) => (buildTtsTimeline ? buildTtsTimeline(input) : missing('buildTtsTimeline')),
    duckAndMix: (input) => (duckAndMix ? duckAndMix(input) : missing('duckAndMix')),
    // clip16kMono is optional on the interface: only expose it when the loaded
    // media-worker provides it, so the runner can detect support and otherwise
    // fall back to single-shot transcription.
    ...(clip16kMono ? { clip16kMono: (i: string, o: string, s: number, e: number) => clip16kMono(i, o, s, e) } : {}),
  };

  return adapter;
}
