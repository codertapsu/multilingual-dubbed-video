/**
 * A region of the picture hidden in the render: a watermark ("玄荒漫剧
 * bilibili" in every frame of the 27.8-hour series, top right) or anything the
 * user wants gone. Coordinates are 0–1 of the frame, so a region works at any
 * resolution; the optional time range covers marks that appear only for a
 * while, and each file of a joined source (Project.inputFiles).
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
  /** From when (ms, project time); absent = from the start. */
  startMs?: number;
  /** Until when (ms, project time); absent = to the end. */
  endMs?: number;
  /** `blur` (soft), `pixelate` (blocks) or `delogo` (ffmpeg's interpolation, for small marks). */
  mode: 'blur' | 'pixelate' | 'delogo';
  /** 1–10; how strong the blur or how big the blocks. Default 5. */
  strength?: number;
}
