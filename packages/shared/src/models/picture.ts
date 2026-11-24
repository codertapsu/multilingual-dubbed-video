/**
 * A region of the picture hidden in the render: a watermark ("玄荒漫剧
 * bilibili" in every frame of the 27.8-hour series, top right) or anything the
 * user wants gone. Coordinates are 0–1 of the frame, so a region works at any
 * resolution; the optional time range covers marks that appear only for a
 * while, and each file of a joined source (Project.inputFiles).
 *
 * Times are in the INPUT video's time: for a whole project its own time, for a
 * series part its parent's (the whole video's). So the parent's regions apply
 * to every part exactly as they are (update_settings applyToParts copies
 * them), and a part's render shifts them to its window.
 */
export interface BlurRegion {
  /** Left edge, 0–1 of the width. */
  x: number;
  /** Top edge, 0–1 of the height. */
  y: number;
  /** Width, 0–1 of the width. */
  w: number;
  /** Height, 0–1 of the height. */
  h: number;
  /** From when (ms, the input video's time); absent = from the start. */
  startMs?: number;
  /** Until when (ms, the input video's time); absent = to the end. */
  endMs?: number;
  /** `blur` (soft), `pixelate` (blocks) or `delogo` (ffmpeg's interpolation, for small marks). */
  mode: 'blur' | 'pixelate' | 'delogo';
  /** 1–10; how strong the blur or how big the blocks. Default 5. */
  strength?: number;
}

/** Which corner of the picture a detected mark sits in. */
export type PictureCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * A watermark found without AI (POST /projects/:id/picture/detect, MCP
 * `detect_watermark`): a {@link BlurRegion} ready for `settings.blurRegions`,
 * plus how sure the detection is. Proposed, never applied by itself.
 */
export interface WatermarkProposal extends BlurRegion {
  corner: PictureCorner;
  /** 0–1: how clearly a still mark stood out over the frames (0.5 and up: clear). */
  confidence: number;
  /** The file of a joined source it was found in (Project.inputFiles), when there are several. */
  fileName?: string;
}

/**
 * Where the source's own burned-in subtitles sit (a full-width band), found
 * from frames while someone speaks against frames in silence. Ready for
 * `burnSubtitleStyle.coverBand`.
 */
export interface SubtitleBandProposal {
  /** Top edge, 0–1 of the height. */
  y: number;
  /** Height, 0–1 of the height: the 95th percentile of the text's height, so two-line subtitles fit. */
  h: number;
  /** 0–1: how clearly text came and went with the speech in those rows. */
  confidence: number;
  /**
   * `speech`: frames during lines against frames in silence (the transcript's
   * times); `appearance`: without a transcript, rows where bright outlined
   * text comes and goes (less sure: check it).
   */
  method: 'speech' | 'appearance';
  /** Share of the frames with text whose text took two lines (or more). */
  twoLineShare?: number;
}

/** What a picture detection found (`<workspace>/picture/detection.json`). */
export interface PictureDetection {
  /** When it ran (ISO-8601). */
  at: string;
  /** The picture's size as it is rendered (display orientation). */
  videoWidth: number;
  videoHeight: number;
  /** Watermarks, best first; empty when none stood out. */
  regions: WatermarkProposal[];
  /** The source's own subtitles, when found. */
  band?: SubtitleBandProposal;
  /** A frame with the boxes (red) and the band (yellow) drawn on it, to check by eye. */
  previewPath?: string;
  /** The same frame without anything drawn (the editor draws the boxes itself). */
  framePath?: string;
  /** Where that frame is, ms of the input video. */
  frameAtMs: number;
  /** How many frames were looked at. */
  frames: number;
  /** What to know about the result ("no transcript yet: the band was found from the picture alone"). */
  notes: string[];
}

/**
 * A picture detection as the routes report it (POST/GET
 * /projects/:id/picture/detect, POST /picture/detect): running with its
 * progress, or its last result.
 */
export interface PictureDetectionJob {
  state: 'idle' | 'running' | 'done' | 'failed';
  /** 0–100 while running. */
  percent?: number;
  message?: string;
  startedAt?: string;
  result?: PictureDetection;
  error?: { code: string; message: string; remediation?: string };
  /** Its entry in the activity list (GET /activity). */
  activityId?: string;
}

/** One frame of a video for the picture editor (POST /projects/:id/picture/frame, POST /picture/frame). */
export interface PictureFrame {
  /** A JPEG as a data: URL. */
  image: string;
  width: number;
  height: number;
  /** Where it is, ms of the input video. */
  atMs: number;
  /** The stretch of the input video the project covers (a part's window), ms. */
  windowStartMs: number;
  windowEndMs: number;
}
