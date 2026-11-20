import { describe, expect, it } from 'vitest';

import { buildSceneArgs, buildThumbnailArgs, mergeSpans, parseSceneTimes, THUMBNAIL_MAX_WIDTH } from './frames.js';

describe('thumbnail', () => {
  it('seeks before the input and takes one scaled frame', () => {
    const args = buildThumbnailArgs('in.mp4', 61_500, 'out.partial.jpg');
    expect(args.slice(0, 5)).toEqual(['-y', '-ss', '61.500', '-i', 'in.mp4']);
    expect(args).toContain(`scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`);
    expect(args.at(-1)).toBe('out.partial.jpg');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
  });
});

describe('scene changes', () => {
  it('decodes only the span, small, and prints a line per change of shot', () => {
    const args = buildSceneArgs('in.mp4', { startMs: 600_000, endMs: 603_500 }, 0.4);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '600.000', '-t', '3.500']);
    expect(args[args.indexOf('-vf') + 1]).toBe("scale=160:-2,select='gt(scene,0.4)',showinfo");
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });

  it("reads showinfo's times back on the whole video's clock", () => {
    const stderr = [
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':',
      '[Parsed_showinfo_2 @ 0000020] n:   0 pts:  14336 pts_time:1.12    duration:    512 fmt:yuv420p',
      '[Parsed_showinfo_2 @ 0000020] n:   1 pts:  30720 pts_time:2.4     duration:    512 fmt:yuv420p',
      'frame=    2 fps=0.0 q=-0.0 Lsize=N/A time=00:00:03.50',
    ].join('\r\n');
    expect(parseSceneTimes(stderr, 600_000)).toEqual([601_120, 602_400]);
    expect(parseSceneTimes('no lines here', 0)).toEqual([]);
  });

  it('merges spans that overlap or touch, and drops empty ones', () => {
    expect(
      mergeSpans([
        { startMs: 5000, endMs: 8000 },
        { startMs: 1000, endMs: 3000 },
        { startMs: 3000, endMs: 4000 },
        { startMs: 7000, endMs: 9000 },
        { startMs: 9500, endMs: 9500 },
        { startMs: -200, endMs: 500 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1000, endMs: 4000 },
      { startMs: 5000, endMs: 9000 },
    ]);
  });
});
