/**
 * Project workspace layout.
 *
 * Given the projects root and a project id, compute every path defined by the
 * VideoDubber workspace contract:
 *
 *   <projectsDir>/<project-id>/
 *     project.json
 *     pipeline.json
 *     input/original.<ext>
 *     audio/original.wav, original_16k_mono.wav, tts_segments/segment_XXXX.wav,
 *           tts_full.wav, final_mix.wav
 *     subtitles/source.json, source.srt, translated.json, translated.srt,
 *               translated.vtt, translated.aligned.json
 *     render/output.mp4
 *     logs/pipeline.log
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** All resolved paths for a single project workspace. */
export interface WorkspacePaths {
  readonly root: string;
  readonly projectJson: string;
  readonly pipelineJson: string;

  readonly inputDir: string;
  /** Resolve the input video path for a given extension (without the dot). */
  inputVideo(ext: string): string;

  readonly audioDir: string;
  readonly originalWav: string;
  readonly original16kMonoWav: string;
  readonly ttsSegmentsDir: string;
  readonly ttsFullWav: string;
  readonly finalMixWav: string;

  readonly subtitlesDir: string;
  readonly sourceJson: string;
  readonly sourceSrt: string;
  readonly translatedJson: string;
  readonly translatedSrt: string;
  readonly translatedVtt: string;
  readonly translatedAlignedJson: string;

  readonly renderDir: string;
  readonly outputMp4: string;

  readonly logsDir: string;
  readonly pipelineLog: string;

  /** Resolve a single TTS segment WAV path from a numeric index (1-based). */
  ttsSegment(index: number): string;
}

/** Zero-pad a 1-based segment index to the canonical `0001` width-4 form. */
export function padSegmentIndex(index: number): string {
  return String(index).padStart(4, '0');
}

/**
 * Extract the numeric index from a canonical segment id (`seg_0001` -> 1).
 * Falls back to parsing any trailing digits; returns 0 if none are found.
 */
export function segmentIdToIndex(segmentId: string): number {
  const match = segmentId.match(/(\d+)\s*$/);
  if (!match) return 0;
  return Number.parseInt(match[1]!, 10);
}

/** Compute every workspace path for a project. Pure / no I/O. */
export function workspacePaths(projectsDir: string, projectId: string): WorkspacePaths {
  const root = path.join(projectsDir, projectId);
  const inputDir = path.join(root, 'input');
  const audioDir = path.join(root, 'audio');
  const ttsSegmentsDir = path.join(audioDir, 'tts_segments');
  const subtitlesDir = path.join(root, 'subtitles');
  const renderDir = path.join(root, 'render');
  const logsDir = path.join(root, 'logs');

  return {
    root,
    projectJson: path.join(root, 'project.json'),
    pipelineJson: path.join(root, 'pipeline.json'),

    inputDir,
    inputVideo: (ext: string) => path.join(inputDir, `original.${ext.replace(/^\./, '')}`),

    audioDir,
    originalWav: path.join(audioDir, 'original.wav'),
    original16kMonoWav: path.join(audioDir, 'original_16k_mono.wav'),
    ttsSegmentsDir,
    ttsFullWav: path.join(audioDir, 'tts_full.wav'),
    finalMixWav: path.join(audioDir, 'final_mix.wav'),

    subtitlesDir,
    sourceJson: path.join(subtitlesDir, 'source.json'),
    sourceSrt: path.join(subtitlesDir, 'source.srt'),
    translatedJson: path.join(subtitlesDir, 'translated.json'),
    translatedSrt: path.join(subtitlesDir, 'translated.srt'),
    translatedVtt: path.join(subtitlesDir, 'translated.vtt'),
    translatedAlignedJson: path.join(subtitlesDir, 'translated.aligned.json'),

    renderDir,
    outputMp4: path.join(renderDir, 'output.mp4'),

    logsDir,
    pipelineLog: path.join(logsDir, 'pipeline.log'),

    ttsSegment: (index: number) => path.join(ttsSegmentsDir, `segment_${padSegmentIndex(index)}.wav`),
  };
}

/** Ensure all standard sub-directories of a project workspace exist. */
export async function ensureWorkspaceDirs(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.root, { recursive: true }),
    fs.mkdir(paths.inputDir, { recursive: true }),
    fs.mkdir(paths.audioDir, { recursive: true }),
    fs.mkdir(paths.ttsSegmentsDir, { recursive: true }),
    fs.mkdir(paths.subtitlesDir, { recursive: true }),
    fs.mkdir(paths.renderDir, { recursive: true }),
    fs.mkdir(paths.logsDir, { recursive: true }),
  ]);
}

/** True if a file exists and is readable. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size >= 0;
  } catch {
    return false;
  }
}

/** True if a file exists and is non-empty (used for resumability checks). */
export async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
