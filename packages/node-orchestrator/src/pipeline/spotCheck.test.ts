import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';
import {
  bestWindow,
  bigramOverlap,
  cjkChars,
  comparableTranscript,
  mismatchSpans,
  planSpotWindows,
  runSpotCheck,
  SCRIPT_PAIRS,
  scoreSpot,
  SPOT_MIN_OVERLAP,
  spotCheckOn,
  spotText,
  type SpotResult,
} from './spotCheck.js';

const HOUR = 3_600_000;
const MIN = 60_000;

/**
 * Varied dialogue, different for every `i`. Pool 1 is what a garbled stretch
 * holds instead: words of its own, as real garbled windows shared almost
 * nothing with their audio (0.01-0.05).
 */
function sentence(i: number, pool = 0): string {
  const words = [
    [
      ['你说', '他们', '我们', '这个', '那边', '大人', '将军', '兄弟', '姑娘', '师父'],
      ['今天', '明天', '昨晚', '刚才', '马上', '一直', '终于', '已经', '还是', '真的'],
      ['回来了', '走不了', '想见你', '不知道', '要出发', '吃饭了', '杀过来', '睡着了', '在等我', '赢了啊'],
      ['快点', '别怕', '小心', '放心', '听着', '记住', '跟上', '等等', '住手', '是吗'],
    ],
    [
      ['风雨', '山河', '岁月', '星辰', '烟花', '江湖', '红尘', '落叶', '孤城', '长亭'],
      ['飘摇', '无声', '如梦', '似水', '依旧', '渐远', '难寻', '已逝', '未央', '成空'],
      ['映斜阳', '寄相思', '锁清秋', '叹浮生', '醉春风', '望天涯', '照归途', '落花间', '绕青山', '入画屏'],
      ['兮兮', '悠悠', '漫漫', '萧萧', '茫茫', '寂寂', '潺潺', '冉冉', '皎皎', '迢迢'],
    ],
  ][pool]!;
  return `${words[0]![i % 10]}${words[1]![Math.floor(i / 10) % 10]}${words[2]![Math.floor(i / 100) % 10]}${words[3]![Math.floor(i / 1000) % 10]}`;
}

/** A line every 5 s over `totalMs`; inside `garbled` the transcript is something else. */
function transcript(totalMs: number, garbled?: { fromMs: number; toMs: number }): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (let t = 0, i = 0; t + 4000 <= totalMs; t += 5000, i++) {
    const bad = garbled && t >= garbled.fromMs && t < garbled.toMs;
    out.push({ id: `seg_${i + 1}`, index: i, startMs: t, endMs: t + 4000, sourceText: sentence(i, bad ? 1 : 0) });
  }
  return out;
}

/** What the audio really says: the clean transcript, in its window. */
function audio(totalMs: number) {
  const truth = transcript(totalMs);
  const calls: [number, number][] = [];
  return {
    calls,
    decode: async (fromMs: number, toMs: number) => {
      calls.push([fromMs, toMs]);
      return truth.filter((l) => (l.startMs + l.endMs) / 2 >= fromMs && (l.startMs + l.endMs) / 2 < toMs);
    },
  };
}

const never = new AbortController().signal;

describe('when the spot check runs', () => {
  it('on by default above 2 hours; the setting turns it off, or on for a shorter video', () => {
    expect(spotCheckOn(undefined, 3 * HOUR)).toBe(true);
    expect(spotCheckOn(undefined, 2 * HOUR)).toBe(false);
    expect(spotCheckOn(false, 28 * HOUR)).toBe(false);
    expect(spotCheckOn(true, 10 * MIN)).toBe(true);
  });

  it('only where CJK characters can be compared', () => {
    expect(comparableTranscript('zh-CN', [])).toBe(true);
    expect(comparableTranscript('ja', [])).toBe(true);
    expect(comparableTranscript('en-US', [{ sourceText: 'Hello there' }])).toBe(false);
    expect(comparableTranscript(undefined, [{ sourceText: '你好 OK' }])).toBe(true);
    expect(comparableTranscript(undefined, [])).toBe(false);
  });
});

describe('comparing a minute with its second decode', () => {
  it('the script does not matter: traditional is compared as simplified', () => {
    for (const [t, s] of SCRIPT_PAIRS) {
      expect([...t]).toHaveLength(1);
      expect([...s]).toHaveLength(1);
      expect(t).not.toBe(s);
    }
    expect(spotText('這是我們的東西！ OK?')).toBe('这是我们的东西ok');
    expect(scoreSpot('你們這些人說什麼呢，快點回來吧，別讓大家等太久了', '你们这些人说什么呢快点回来吧别让大家等太久了').overlap).toBe(1);
  });

  it('agreement: identical 1, unrelated 0, a word or two apart stays high', () => {
    expect(bigramOverlap('我们今天回家', '我们今天回家')).toBe(1);
    expect(bigramOverlap('我们今天回家', '风雨交加之夜')).toBe(0);
    expect(bigramOverlap('', '')).toBe(0);
    const aligned = scoreSpot(
      '将军说今天一定要拿下这座城不然大家都回不去了你们听明白了吗',
      '将军说今天一定要拿下这座城要不然大家都回不去了你们听明白没有',
    );
    expect(aligned.overlap!).toBeGreaterThan(0.8);
  });

  it('a garbled transcript fails, an empty one against heard speech too', () => {
    const garbled = scoreSpot('优优独播剧场请不吝点赞订阅转发打赏支持明镜与点点栏目', '将军说今天一定要拿下这座城不然大家都回不去了');
    expect(garbled.overlap!).toBeLessThan(SPOT_MIN_OVERLAP);
    expect(scoreSpot('', '将军说今天一定要拿下这座城不然大家都回不去了').overlap).toBe(0);
  });

  it('music or a battle (under 20 CJK characters on both sides) is skipped', () => {
    expect(scoreSpot('杀！', '啊啊啊')).toEqual({ skipped: 'little-text' });
    expect(cjkChars('杀 kill 殺!')).toBe(2);
  });
});

describe('where the windows go', () => {
  it('one per half hour, in its middle without a speech map', () => {
    expect(planSpotWindows(2 * HOUR)).toEqual([
      { fromMs: 14.5 * MIN, toMs: 15.5 * MIN },
      { fromMs: 44.5 * MIN, toMs: 45.5 * MIN },
      { fromMs: 74.5 * MIN, toMs: 75.5 * MIN },
      { fromMs: 104.5 * MIN, toMs: 105.5 * MIN },
    ]);
    // A last slot shorter than a minute has no window.
    expect(planSpotWindows(30 * MIN + 30_000)).toHaveLength(1);
  });

  it('with a speech map, the minute with the most speech in the slot', () => {
    const speech = [{ startMs: 20 * MIN, endMs: 21 * MIN + 30_000 }];
    expect(bestWindow(0, 30 * MIN, speech)).toEqual({ fromMs: 20 * MIN, toMs: 21 * MIN });
    expect(bestWindow(0, 30_000, speech)).toBeUndefined();
  });
});

describe('mismatch spans', () => {
  const r = (fromMin: number, overlap: number | undefined): SpotResult => ({
    fromMs: fromMin * MIN,
    toMs: (fromMin + 1) * MIN,
    ...(overlap !== undefined ? { overlap } : { skipped: 'little-text' as const }),
    failed: overlap !== undefined && overlap < SPOT_MIN_OVERLAP,
  });

  it('consecutive failures are one span; a pass ends it, a skipped window does not', () => {
    expect(mismatchSpans([r(0, 0.9), r(30, 0.02), r(60, undefined), r(90, 0.05), r(120, 0.93), r(150, 0.1)])).toEqual([
      { fromMs: 30 * MIN, toMs: 91 * MIN, failed: 2, best: 0.05 },
      { fromMs: 150 * MIN, toMs: 151 * MIN, failed: 1, best: 0.1 },
    ]);
    expect(mismatchSpans([r(0, 0.9)])).toEqual([]);
  });
});

describe('the spot check of a long transcript', () => {
  it('finds the garbled hours of a 12-hour transcript, and where they start and end', async () => {
    const total = 12 * HOUR;
    const lines = transcript(total, { fromMs: 5 * HOUR, toMs: 10 * HOUR });
    const heard = audio(total);
    const progress: [number, number][] = [];
    const out = await runSpotCheck(lines, total, undefined, { decode: heard.decode, progress: (d, t) => void progress.push([d, t]) }, never);

    // 24 regular windows, then 3 halvings on each side of the one span.
    expect(heard.calls).toHaveLength(30);
    expect(out.spans).toHaveLength(1);
    const [span] = out.spans;
    expect(span!.fromMs).toBeGreaterThanOrEqual(5 * HOUR);
    expect(span!.fromMs).toBeLessThan(5 * HOUR + 5 * MIN);
    expect(span!.toMs).toBeGreaterThan(10 * HOUR - 5 * MIN);
    expect(span!.toMs).toBeLessThanOrEqual(10 * HOUR + MIN);
    expect(span!.best).toBeLessThan(SPOT_MIN_OVERLAP);
    // Windows clear of the garbled hours agree, as the field run's did (0.83-0.97);
    // one straddling its edge is half garbled and passes at about 0.5.
    const clear = out.results.filter((x) => x.toMs <= 5 * HOUR || x.fromMs >= 10 * HOUR);
    expect(clear.every((x) => !x.failed && x.overlap! > 0.8)).toBe(true);
    expect(progress.at(-1)).toEqual([heard.calls.length, heard.calls.length]);
  });

  it('a clean transcript: no span, only the regular windows', async () => {
    const total = 3 * HOUR;
    const heard = audio(total);
    const out = await runSpotCheck(transcript(total), total, undefined, { decode: heard.decode }, never);
    expect(out.spans).toEqual([]);
    expect(heard.calls).toHaveLength(6);
  });

  it('a window whose decode fails is skipped; a pause stops the check', async () => {
    const total = 3 * HOUR;
    let n = 0;
    const out = await runSpotCheck(transcript(total), total, undefined, {
      decode: async (fromMs, toMs) => {
        n += 1;
        if (n === 2) throw new Error('engine restarted');
        return audio(total).decode(fromMs, toMs);
      },
    }, never);
    expect(out.results.map((r) => r.skipped ?? 'ok')).toEqual(['ok', 'decode-failed', 'ok', 'ok', 'ok', 'ok']);

    const stop = new AbortController();
    const paused = runSpotCheck(transcript(total), total, undefined, {
      decode: async (fromMs, toMs) => {
        stop.abort();
        return audio(total).decode(fromMs, toMs);
      },
    }, stop.signal);
    await expect(paused).rejects.toThrow(/cancelled/);
  });
});
