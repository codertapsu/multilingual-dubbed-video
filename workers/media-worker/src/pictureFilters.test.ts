import { describe, expect, it } from 'vitest';

import { buildFrameSampleArgs, parseFirstFrameTime, spreadTimes, analysisSize } from './frameSample.js';
import { buildFilteredRenderArgs, type FilteredRenderContext } from './overlay.js';
import { buildPictureFrameArgs, mergeAcrossSegments } from './pictureDetect.js';
import {
  blurBandRegion,
  blurRadii,
  buildRegionFilters,
  hidesPicture,
  pictureRegionsFor,
  pixelBlock,
  pixelRect,
  regionWindow,
  requiredPictureFilters,
  resolveRegions,
} from './pictureFilters.js';
import { buildRenderArgs, type RenderArgsContext } from './render.js';
import { parseVideoLengthMs } from './videoLength.js';

describe('pixelRect', () => {
  it('a 0–1 box in even pixels, outward, inside the picture', () => {
    // The series' mark on a 1080×1920 frame.
    // 712.8–1050.3 × 27.1–102.1 px, rounded outward to even pixels.
    expect(pixelRect({ x: 0.66, y: 0.0141, w: 0.3125, h: 0.0391 }, 1080, 1920)).toEqual({ x: 712, y: 26, w: 340, h: 78 });
    expect(pixelRect({ x: 0.9, y: 0.95, w: 0.5, h: 0.5 }, 1280, 720)).toEqual({ x: 1152, y: 684, w: 128, h: 36 });
  });

  it('never smaller than 8 px; nothing for a broken box', () => {
    expect(pixelRect({ x: 0.999, y: 0, w: 0.0001, h: 0.0001 }, 1280, 720)).toEqual({ x: 1272, y: 0, w: 8, h: 8 });
    expect(pixelRect({ x: 0.1, y: 0.1, w: 0, h: 0.2 }, 1280, 720)).toBeUndefined();
    expect(pixelRect({ x: Number.NaN, y: 0.1, w: 0.1, h: 0.2 }, 1280, 720)).toBeUndefined();
  });
});

describe('regionWindow', () => {
  it('a whole render: the region as it is, open ends dropped at the edges', () => {
    expect(regionWindow({}, undefined, 60_000)).toEqual({});
    expect(regionWindow({ startMs: 0, endMs: 60_000 }, undefined, 60_000)).toEqual({});
    expect(regionWindow({ startMs: 5000, endMs: 9000 }, undefined, 60_000)).toEqual({ fromMs: 5000, toMs: 9000 });
    expect(regionWindow({ startMs: 70_000 }, undefined, 60_000)).toBeNull();
  });

  it("a part's window: moved by its start, clipped to it, gone when outside", () => {
    const part = { startMs: 3_600_000, endMs: 5_400_000 };
    // A mark over the whole video, and one over the file the part starts in.
    expect(regionWindow({}, part)).toEqual({});
    expect(regionWindow({ startMs: 0, endMs: 4_000_000 }, part)).toEqual({ toMs: 400_000 });
    expect(regionWindow({ startMs: 5_000_000, endMs: 9_000_000 }, part)).toEqual({ fromMs: 1_400_000 });
    expect(regionWindow({ startMs: 0, endMs: 3_600_000 }, part)).toBeNull();
    expect(regionWindow({ startMs: 5_400_000 }, part)).toBeNull();
  });
});

describe('blurRadii / pixelBlock', () => {
  it('grow with the strength, never past what boxblur accepts for the chroma planes', () => {
    expect(blurRadii(5, 338, 76)).toEqual({ luma: 17, chroma: 9, power: 2 });
    expect(blurRadii(10, 338, 76)).toEqual({ luma: 31, chroma: 16, power: 3 });
    expect(blurRadii(1, 8, 8)).toEqual({ luma: 1, chroma: 1, power: 2 });
    for (let s = 1; s <= 10; s++) {
      const r = blurRadii(s, 1080, 12);
      expect(2 * r.luma).toBeLessThanOrEqual(12);
      expect(2 * r.chroma).toBeLessThanOrEqual(6);
    }
  });

  it('pixel blocks from 6 % to 33 % of the shorter side', () => {
    expect(pixelBlock(1, 338, 76)).toBe(5);
    expect(pixelBlock(5, 338, 76)).toBe(14);
    expect(pixelBlock(10, 338, 76)).toBe(25);
  });
});

describe('buildRegionFilters', () => {
  const box = { x: 712, y: 26, w: 338, h: 76, strength: 5 };

  it('blur: crop, boxblur, overlay back in place', () => {
    expect(buildRegionFilters([{ mode: 'blur', ...box }], 1080, 1920, { input: '0:v', output: 'vh' })).toBe(
      '[0:v]split=2[pr0m][pr0c];[pr0c]crop=338:76:712:26,boxblur=luma_radius=17:luma_power=2:chroma_radius=9:chroma_power=2[pr0e];[pr0m][pr0e]overlay=x=712:y=26[vh]',
    );
  });

  it('pixelate: scaled down by area and back up by nearest neighbour', () => {
    expect(buildRegionFilters([{ mode: 'pixelate', ...box }], 1080, 1920, { input: '0:v', output: 'vh' })).toBe(
      '[0:v]split=2[pr0m][pr0c];[pr0c]crop=338:76:712:26,scale=25:6:flags=area,scale=338:76:flags=neighbor[pr0e];[pr0m][pr0e]overlay=x=712:y=26[vh]',
    );
  });

  it('delogo: kept a pixel inside the frame, switched by time with enable=', () => {
    expect(
      buildRegionFilters([{ mode: 'delogo', x: 0, y: 0, w: 200, h: 60, strength: 5, fromMs: 10_000 }], 1280, 720, { input: '0:v', output: 'vh' }),
    ).toBe("[0:v]delogo=x=1:y=1:w=199:h=59:enable='gte(t,10.000)'[vh]");
    expect(
      buildRegionFilters([{ mode: 'delogo', x: 1180, y: 660, w: 100, h: 60, strength: 5 }], 1280, 720, { input: '0:v', output: 'vh' }),
    ).toBe('[0:v]delogo=x=1180:y=660:w=98:h=58[vh]');
  });

  it('a region for a while moves its patch off-screen outside that time; regions chain in order', () => {
    const f = buildRegionFilters(
      [
        { mode: 'blur', ...box, fromMs: 0, toMs: 4_000 },
        { mode: 'delogo', x: 100, y: 100, w: 50, h: 20, strength: 5 },
      ],
      1080,
      1920,
      { input: '0:v', output: 'vh' },
    );
    expect(f).toBe(
      "[0:v]split=2[pr0m][pr0c];[pr0c]crop=338:76:712:26,boxblur=luma_radius=17:luma_power=2:chroma_radius=9:chroma_power=2[pr0e];[pr0m][pr0e]overlay=x='if(between(t,0.000,4.000),712,-overlay_w-10)':y=26:eval=frame[pr0];" +
        '[pr0]delogo=x=100:y=100:w=50:h=20[vh]',
    );
    expect(buildRegionFilters([], 1080, 1920, { input: '0:v', output: 'vh' })).toBeUndefined();
  });
});

describe('the blurred band and what a render hides', () => {
  const style = { coverOriginal: 'blur' as const, coverBand: { y: 0.755, h: 0.06 }, coverStrength: 7 };

  it('the band is a full-width blur over its rows, at its strength', () => {
    // 75.5 % of 1920 = row 1449.6 → 1450, 6 % = 115 rows, even-sized.
    expect(blurBandRegion(style, 1080, 1920)).toEqual({ mode: 'blur', x: 0, y: 1450, w: 1080, h: 116, strength: 7 });
    // Without a band of its own: the bottom strip the solid band covers.
    expect(blurBandRegion({ coverOriginal: 'blur' }, 1280, 720)).toEqual({ mode: 'blur', x: 0, y: 576, w: 1280, h: 144, strength: 5 });
    expect(blurBandRegion({ coverOriginal: true, coverBand: { y: 0.7, h: 0.1 } }, 1280, 720)).toBeUndefined();
  });

  it('regions first, the band last; only a render that hides something re-encodes for it', () => {
    const regions = pictureRegionsFor(
      { blurRegions: [{ x: 0.66, y: 0.0141, w: 0.3125, h: 0.0391, mode: 'pixelate' }], burnSubtitleStyle: style },
      1080,
      1920,
      60_000,
    );
    expect(regions.map((r) => r.mode)).toEqual(['pixelate', 'blur']);
    expect(requiredPictureFilters(regions)).toEqual(['boxblur']);
    expect(hidesPicture({ blurRegions: [] })).toBe(false);
    expect(hidesPicture({ burnSubtitleStyle: { coverOriginal: true } })).toBe(false);
    expect(hidesPicture({ burnSubtitleStyle: { coverOriginal: 'blur' } })).toBe(true);
    expect(hidesPicture({ blurRegions: [{ x: 0, y: 0, w: 0.1, h: 0.1, mode: 'delogo' }] })).toBe(true);
  });

  it('broken regions are dropped, not rendered', () => {
    expect(
      resolveRegions([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, mode: 'smudge' as never }, { x: 0.1, y: 0.1, w: -1, h: 0.1, mode: 'blur' }], 1280, 720),
    ).toEqual([]);
  });
});

describe('buildFilteredRenderArgs with hidden regions and the cap', () => {
  const base: FilteredRenderContext = {
    inputVideoPath: 'in.mp4',
    audioPath: 'mix.wav',
    outputPath: 'out.mp4',
    mode: 'burned-in',
    burnScriptPath: '/t/burn.ass',
    width: 1080,
    height: 1920,
    durationMs: 60_000,
    videoCodec: 'libx264',
    videoCodecArgs: [],
    audioArgs: [],
    metadataArgs: [],
    platform: 'linux',
  };

  it('hides the regions FIRST, then burns the subtitles and lays the logo on top', () => {
    const args = buildFilteredRenderArgs({
      ...base,
      regions: [{ mode: 'blur', x: 0, y: 1448, w: 1080, h: 118, strength: 5 }],
      logo: { imagePath: 'logo.png', corner: 'top-left', widthPct: 10, marginPct: 4, opacity: 1 },
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph.startsWith('[0:v]split=2[pr0m][pr0c];[pr0c]crop=1080:118:0:1448,boxblur=')).toBe(true);
    expect(graph).toContain('[pr0m][pr0e]overlay=x=0:y=1448[vh];[vh]subtitles=/t/burn.ass[v0];[2:v]scale=');
    expect(graph.indexOf('boxblur')).toBeLessThan(graph.indexOf('subtitles='));
    expect(graph.indexOf('subtitles=')).toBeLessThan(graph.indexOf('[v0][lgs]overlay'));
  });

  it('without regions the graph is exactly what it was', () => {
    const graph = (a: string[]) => a[a.indexOf('-filter_complex') + 1];
    expect(graph(buildFilteredRenderArgs({ ...base, regions: [] }))).toBe('[0:v]subtitles=/t/burn.ass[v0]');
    expect(graph(buildFilteredRenderArgs(base))).toBe('[0:v]subtitles=/t/burn.ass[v0]');
  });

  it('a whole video stops at its picture; a part at its window', () => {
    const whole = buildFilteredRenderArgs({ ...base, maxDurationMs: 9_826_357 });
    expect(whole.slice(whole.indexOf('-t'), whole.indexOf('-t') + 2)).toEqual(['-t', '9826.357']);
    expect(whole.indexOf('-t')).toBeGreaterThan(whole.indexOf('-filter_complex'));
    const part = buildFilteredRenderArgs({ ...base, maxDurationMs: 9_826_357, range: { startMs: 60_000, endMs: 120_000 } });
    expect(part.filter((a) => a === '-t')).toHaveLength(2); // the input window and the output cap, both the window
    expect(part).not.toContain('9826.357');
  });
});

describe('buildRenderArgs: the cap at the picture', () => {
  const base: RenderArgsContext = {
    inputVideoPath: '/in.mp4',
    audioPath: '/dub.wav',
    outputPath: '/out/output.mp4',
    subtitleExportMode: 'none',
    platform: 'linux',
  };
  const capOf = (args: string[]) => (args.includes('-t') ? args[args.indexOf('-t') + 1] : undefined);

  it('every mode stops at the picture when its length is known, as an output option', () => {
    for (const mode of ['none', 'srt-file', 'vtt-file', 'embedded-soft', 'burned-in'] as const) {
      const args = buildRenderArgs({ ...base, subtitleExportMode: mode, subtitlePath: '/subs.srt', maxDurationMs: 9_821_548 });
      expect(capOf(args), mode).toBe('9821.548');
      expect(args.indexOf('-t'), mode).toBeGreaterThan(args.lastIndexOf('-i'));
    }
  });

  it('without a length, no cap (as before)', () => {
    expect(buildRenderArgs(base)).not.toContain('-t');
    expect(buildRenderArgs({ ...base, maxDurationMs: 0 })).not.toContain('-t');
  });
});

describe('parseVideoLengthMs', () => {
  it("the video stream's own length, not the container's (a long audio stretches that)", () => {
    expect(parseVideoLengthMs({ streams: [{ duration: '9821.548000' }], format: { duration: '9826.357000' } })).toBe(9_821_548);
  });

  it("Matroska's DURATION tag, then the container's", () => {
    expect(parseVideoLengthMs({ streams: [{ tags: { DURATION: '02:43:41.548000000' } }], format: { duration: '9826.357' } })).toBe(9_821_548);
    expect(parseVideoLengthMs({ streams: [{}], format: { duration: '61.5' } })).toBe(61_500);
    expect(parseVideoLengthMs({ streams: [] })).toBe(0);
    expect(parseVideoLengthMs({ streams: [{ duration: 'N/A' }] })).toBe(0);
  });
});

describe('frame sampling', () => {
  it('a fast keyframe seek, grey bytes out', () => {
    expect(buildFrameSampleArgs('in.mp4', 5300, { width: 360, height: 640 }, 'f.gray')).toEqual([
      '-hide_banner', '-nostdin', '-nostats', '-ss', '5.300', '-noaccurate_seek', '-skip_frame', 'nokey', '-i', 'in.mp4',
      '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'showinfo,scale=360:640:flags=area,format=gray', '-f', 'rawvideo', '-y', 'f.gray',
    ]);
  });

  it("the frame's time is the first one showinfo reports", () => {
    const stderr = [
      '[Parsed_showinfo_0 @ 000001] n:   0 pts:  -17664 pts_time:-1.38   duration:    512 fmt:yuv420p',
      '[Parsed_showinfo_0 @ 000001] n:   1 pts:    7424 pts_time:0.58    duration:    512',
    ].join('\n');
    expect(parseFirstFrameTime(stderr)).toBe(-1.38);
    expect(parseFirstFrameTime('no frames')).toBeUndefined();
  });

  it('times spread over the window; the analysis size keeps the aspect at 640 px', () => {
    expect(spreadTimes(0, 10_000, 4)).toEqual([1250, 3750, 6250, 8750]);
    expect(analysisSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(analysisSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(analysisSize(320, 180)).toEqual({ width: 320, height: 180 });
  });
});

describe('the preview frame', () => {
  it('boxes red, the band yellow, drawn with drawbox (no font)', () => {
    const args = buildPictureFrameArgs('in.mp4', 61_000, { width: 540, height: 960 }, 'preview.jpg', {
      boxes: [{ x: 356, y: 13, w: 169, h: 38 }],
      band: { y: 725, h: 58 },
    });
    expect(args.slice(4, 8)).toEqual(['-ss', '61.000', '-i', 'in.mp4']);
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'scale=540:960:flags=bicubic,setsar=1,drawbox=x=356:y=13:w=169:h=38:color=red@0.95:t=2,drawbox=x=0:y=725:w=iw:h=58:color=yellow@0.95:t=2',
    );
  });
});

describe('mergeAcrossSegments', () => {
  const mark = { x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur' as const, corner: 'top-right' as const, confidence: 0.8 };
  const seg = (startMs: number, endMs: number, fileName: string) => ({ startMs, endMs, fileName });

  it('the same mark in every file is one region for the whole video', () => {
    expect(
      mergeAcrossSegments([
        { segment: seg(0, 100, 'P1.mp4'), marks: [mark] },
        { segment: seg(100, 200, 'P2.mp4'), marks: [{ ...mark, x: 0.662, confidence: 0.9 }] },
      ]),
    ).toEqual([{ ...mark, w: 0.312, confidence: 0.9 }]);
  });

  it('a mark in some files only keeps their time and names them', () => {
    const other = { ...mark, corner: 'top-left' as const, x: 0.02 };
    expect(
      mergeAcrossSegments([
        { segment: seg(0, 100, 'P1.mp4'), marks: [mark] },
        { segment: seg(100, 200, 'P2.mp4'), marks: [mark] },
        { segment: seg(200, 300, 'P3.mp4'), marks: [other] },
      ]),
    ).toEqual([
      { ...mark, startMs: 0, endMs: 200, fileName: 'P1.mp4, P2.mp4' },
      { ...other, startMs: 200, endMs: 300, fileName: 'P3.mp4' },
    ]);
  });

  it('one window: the marks as found, no time', () => {
    expect(mergeAcrossSegments([{ segment: seg(0, 100, 'a'), marks: [mark] }])).toEqual([mark]);
    expect(mergeAcrossSegments([])).toEqual([]);
  });
});
