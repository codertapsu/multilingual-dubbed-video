import { describe, expect, it } from 'vitest';

import { buildCardsAss, buildFilteredRenderArgs, buildLogoFilter, logoPlacement, type FilteredRenderContext } from './overlay.js';

const logo = { imagePath: 'logo.png', corner: 'top-right' as const, widthPct: 10, marginPct: 4, opacity: 0.85 };

describe('logoPlacement', () => {
  it('sizes the logo from the picture and puts it in its corner', () => {
    expect(logoPlacement(logo, 1920, 1080)).toEqual({ widthPx: 192, x: 'main_w-overlay_w-43', y: '43' });
    expect(logoPlacement({ ...logo, corner: 'bottom-left' }, 1280, 720)).toEqual({ widthPx: 128, x: '29', y: 'main_h-overlay_h-29' });
  });
});

describe('buildLogoFilter', () => {
  it('fades the image to its opacity and lays it on the picture', () => {
    expect(buildLogoFilter(logo, 1920, 1080, { logo: '2:v', base: 'v0', out: 'v1' })).toBe(
      "[2:v]scale=192:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=0.85[lgs];[v0][lgs]overlay=x='main_w-overlay_w-43':y='43':eval=frame[v1]",
    );
  });

  it('moves it off-screen outside its periods instead of switching it off', () => {
    const f = buildLogoFilter({ ...logo, periods: [{ startMs: 0, endMs: 10_000 }, { startMs: 300_000, endMs: 310_000 }] }, 1920, 1080, {
      logo: '2:v',
      base: 'v0',
      out: 'v1',
    });
    expect(f).toContain("x='if(gt(between(t,0.000,10.000)+between(t,300.000,310.000),0),main_w-overlay_w-43,-overlay_w-10)'");
    expect(f).not.toContain('enable=');
  });
});

describe('buildCardsAss', () => {
  it('writes each card in its style, on the picture grid, with literal text', () => {
    const ass = buildCardsAss(
      [
        { kind: 'title', text: 'Tên video · Phần 2/7', startMs: 0, endMs: 3500 },
        { kind: 'label', text: 'Phần trước', startMs: 0, endMs: 4000 },
        { kind: 'end', text: 'Còn tiếp {x}\nPhần 3', startMs: 10_000, endMs: 13_000 },
      ],
      1920,
      1080,
      'Be Vietnam Pro',
    );
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('Style: Title,Be Vietnam Pro,67,');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:03.50,Title,,0,0,0,,{\\fad(250,250)}Tên video · Phần 2/7');
    expect(ass).toContain('{\\fad(250,250)}Còn tiếp x\\NPhần 3');
  });
});

describe('buildFilteredRenderArgs', () => {
  const base: FilteredRenderContext = {
    inputVideoPath: 'in.mp4',
    audioPath: 'mix.wav',
    outputPath: 'out.mp4',
    mode: 'srt-file',
    width: 1280,
    height: 720,
    durationMs: 60_000,
    videoCodec: 'libx264',
    videoCodecArgs: ['-preset', 'veryfast', '-crf', '20'],
    audioArgs: ['-c:a', 'aac'],
    metadataArgs: [],
    platform: 'linux',
  };

  it('cuts a part with an accurate seek and fades it in and out', () => {
    const args = buildFilteredRenderArgs({
      ...base,
      range: { startMs: 900_000, endMs: 960_000 },
      effects: { fadeInMs: 500, fadeOutMs: 1000, darkenUntilMs: 4000 },
    });
    expect(args.slice(0, 7)).toEqual(['-y', '-ss', '900.000', '-t', '60.000', '-i', 'in.mp4']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toBe(
      "[0:v]eq=brightness=-0.07:saturation=0.8:enable='lt(t,4.000)'[v0];[v0]fade=t=in:st=0:d=0.500,fade=t=out:st=59.000:d=1.000[vf];[1:a]afade=t=in:st=0:d=0.500,afade=t=out:st=59.000:d=1.000[af]",
    );
    expect(args).toContain('[af]');
  });

  it('burns subtitles, then cards, then the logo, and keeps a soft track in its own mode', () => {
    const burned = buildFilteredRenderArgs({ ...base, mode: 'burned-in', burnScriptPath: '/t/burn.ass', cardsScriptPath: '/t/cards.ass', logo });
    expect(burned).toContain('logo.png');
    const graph = burned[burned.indexOf('-filter_complex') + 1]!;
    expect(graph.indexOf('burn.ass')).toBeLessThan(graph.indexOf('cards.ass'));
    expect(graph).toContain('[v0][lgs]overlay');
    expect(burned[burned.indexOf('-map') + 1]).toBe('[v1]');

    const soft = buildFilteredRenderArgs({ ...base, mode: 'embedded-soft', softSubtitlePath: 'sub.srt', logo });
    expect(soft).toEqual(expect.arrayContaining(['-map', '3:0', '-c:s', 'mov_text']));
  });
});
