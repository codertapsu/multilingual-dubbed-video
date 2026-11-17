import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';
import {
  applyReviewOutcome,
  checkAndRepairLines,
  planUnitShortening,
  shortenOverflowingLines,
  tightenOneLine,
  type PassChat,
} from './dubPasses.js';
import { MAX_CUT_SHARE } from './contextEngine.js';

const zhVi = { sourceLanguage: 'zh', targetLanguage: 'vi-VN' };

function line(id: string, sourceText: string, translatedText: string, startMs = 0, endMs = 2000): TranscriptSegment {
  return { id, index: Number(id.replace(/\D/g, '')), startMs, endMs, sourceText, translatedText };
}

/** A chat answering each request with `reply(id, prompt)` for the ids in it. */
function chat(reply: (id: string, prompt: string) => string): PassChat & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async chatComplete(_system, user) {
      prompts.push(user);
      const ids = [...user.matchAll(/^(seg_\d{4})/gm)].map((m) => m[1]!);
      return JSON.stringify({ segments: ids.map((id) => ({ id, text: reply(id, user) })) });
    },
  };
}

describe('checkAndRepairLines (translation step)', () => {
  const segments = [
    line('seg_0001', '昆仑旭每天都有快死', 'Kunlun Xu ngày nào cũng suýt chết.', 0, 2500),
    line('seg_0002', '你干什么', 'Ngươi làm gì vậy?', 2500, 3500),
    line('seg_0003', '谢谢师尊', 'Cảm ơn thầy/cô', 3500, 5000),
    line('seg_0004', '鸿蒙', '', 5000, 6000),
  ];

  it('repairs failing lines with their neighbours and flags what is still bad', async () => {
    const engine = chat((id) =>
      id === 'seg_0001' ? 'Côn Lôn Khư ngày nào cũng suýt chết.' : id === 'seg_0003' ? 'Cảm ơn thầy/cô ạ' : '',
    );
    const out = await checkAndRepairLines({ ...zhVi, segments }, engine);
    // Only the failing lines went to the model — one request per line (a 4B
    // model mixed lines up in batches) — each with its problem.
    // (seg_0004's empty answer is asked again once.)
    expect(engine.prompts.map((p) => p.match(/^seg_\d{4}/m)?.[0])).toEqual(['seg_0001', 'seg_0003', 'seg_0004', 'seg_0004']);
    expect(engine.prompts[0]).toContain('problem: it contains a pinyin');

    const text = out.segments.map((s) => s.translatedText);
    expect(text[0]).toBe('Côn Lôn Khư ngày nào cũng suýt chết.');
    expect(out.segments[0]!.qualityFlags).toBeUndefined();
    // Not better → kept, flagged.
    expect(text[2]).toBe('Cảm ơn thầy/cô');
    expect(out.segments[2]!.qualityFlags).toEqual(['alternatives']);
    // Empty and unrepaired → the source, FLAGGED (never silently).
    expect(text[3]).toBe('鸿蒙');
    expect(out.segments[3]!.qualityFlags).toEqual(['untranslated']);
    expect(out.repaired).toEqual([
      { id: 'seg_0001', before: 'Kunlun Xu ngày nào cũng suýt chết.', after: 'Côn Lôn Khư ngày nào cũng suýt chết.' },
    ]);
    expect(out.flagged.map((f) => f.id)).toEqual(['seg_0003', 'seg_0004']);
  });

  it('without an engine flags failures and clears stale flags on clean lines', async () => {
    const stale = [{ ...segments[1]!, qualityFlags: ['pinyin' as const] }, segments[2]!];
    const out = await checkAndRepairLines({ ...zhVi, segments: stale }, undefined);
    expect(out.segments[0]!.qualityFlags).toBeUndefined();
    expect(out.segments[1]!.qualityFlags).toEqual(['alternatives']);
  });
});

describe('applyReviewOutcome (refine step)', () => {
  it('keeps locked lines verbatim and refreshes every line’s flags', () => {
    const segments = [
      { ...line('seg_0001', '你好', 'Câu do tôi viết'), locked: true },
      { ...line('seg_0002', '谢谢', 'Cảm ơn thầy/cô'), qualityFlags: ['alternatives' as const] },
    ];
    const out = applyReviewOutcome(
      segments,
      {
        segments: [
          { id: 'seg_0001', translatedText: 'máy sửa 1' },
          { id: 'seg_0002', translatedText: 'Cảm ơn sư phụ' },
        ],
        changes: [
          { id: 'seg_0001', source: '你好', before: 'Câu do tôi viết', after: 'máy sửa 1' },
          { id: 'seg_0002', source: '谢谢', before: 'Cảm ơn thầy/cô', after: 'Cảm ơn sư phụ' },
        ],
      },
      zhVi,
    );
    expect(out.segments.map((s) => s.translatedText)).toEqual(['Câu do tôi viết', 'Cảm ơn sư phụ']);
    expect(out.segments[1]!.qualityFlags).toBeUndefined();
    expect(out.applied.map((c) => c.id)).toEqual(['seg_0002']);
    expect(out.lockedSkipped).toEqual(['seg_0001']);
  });

  it('leaves a locked line exactly as the user left it, flags included', () => {
    // The editor clears a line's flags when the user rewrites it; the review
    // re-checking it put "alternatives" back on the user's own wording.
    const mine = { ...line('seg_0001', '谢谢', 'Cảm ơn thầy/cô'), locked: true };
    const out = applyReviewOutcome([mine], { segments: [], changes: [] }, zhVi);
    expect(out.segments[0]).toEqual(mine);
  });
});

describe('planUnitShortening', () => {
  const nine = 'một hai ba bốn năm sáu bảy tám chín';

  it('assumes the target language pace, not Vietnamese, when no rate is known', () => {
    // 12 English words in 6 s (2 words/s) and a 4 s slot. At the Vietnamese
    // 4.6/s this ordinary clip looked like an engine failure: no cut planned.
    const plan = planUnitShortening(
      { generatedMs: 6000, availableMs: 4000 },
      [{ id: 'a', text: 'I told you we would never make it back before the storm' }],
      'en',
      undefined,
    );
    expect(plan).toEqual([{ id: 'a', units: 12, target: 8, max: 9 }]);
  });

  it('sizes each member from the clip itself so the unit fits at the comfortable speed-up', () => {
    // 18 syllables read in 5400 ms = 300 ms each; 2900 ms × 1.15 fits 11.
    const plan = planUnitShortening(
      { generatedMs: 5400, availableMs: 2900 },
      [
        { id: 'a', text: nine },
        { id: 'b', text: nine },
      ],
      'vi',
      3.5,
    );
    expect(plan).toEqual([
      { id: 'a', units: 9, target: 5, max: 5 },
      { id: 'b', units: 9, target: 5, max: 5 },
    ]);
  });

  it('leaves locked and very short members alone and never asks for more than the cut cap', () => {
    const plan = planUnitShortening(
      { generatedMs: 9000, availableMs: 1000 },
      [
        { id: 'locked', text: nine, locked: true },
        { id: 'short', text: 'Có mặt!' },
        { id: 'long', text: nine },
      ],
      'vi',
      3.5,
    );
    expect(plan.map((p) => p.id)).toEqual(['long']);
    expect(plan[0]!.max).toBe(Math.ceil(9 * (1 - MAX_CUT_SHARE)));
  });

  it('treats an absurdly slow clip as an engine failure and plans from the voice rate', () => {
    // VieNeu once read a 6-syllable line for 24 s: 4 s per syllable is not pace.
    const plan = planUnitShortening({ generatedMs: 24_000, availableMs: 1500 }, [{ id: 'a', text: 'Sức mạnh gần như vô hạn' }], 'vi', 3.5);
    expect(plan).toEqual([]); // at 3.5/s the six syllables fit 1.5 s × 1.15 — nothing to cut
  });

  it('does nothing when the unit already fits', () => {
    expect(planUnitShortening({ generatedMs: 2000, availableMs: 2000 }, [{ id: 'a', text: nine }], 'vi', 3.5)).toEqual([]);
  });
});

describe('shortenOverflowingLines (auto-fit)', () => {
  const nine = 'một hai ba bốn năm sáu bảy tám chín';
  const segments = [
    line('seg_0001', '我只要掉一根毫毛', nine, 0, 1000),
    line('seg_0002', '你们都得死', nine, 1000, 2000),
    line('seg_0003', '在', 'Có mặt!', 2900, 3500),
  ];
  const units = [{ id: 'seg_0001', memberIds: ['seg_0001', 'seg_0002'], generatedMs: 5400, availableMs: 2900 }];

  it('runs a strict second pass only for units still estimated too long — all before any synthesis', async () => {
    let pass = 0;
    const engine = chat((id, prompt) => {
      if (prompt.includes('HARD limit')) return 'một hai ba bốn năm';
      pass = 1;
      return id === 'seg_0001' ? 'một hai ba bốn năm sáu bảy' : 'một hai ba bốn năm sáu bảy tám';
    });
    const out = await shortenOverflowingLines({ ...zhVi, units, segments, perSecond: 3.5 }, engine);
    expect(pass).toBe(1);
    expect(engine.prompts).toHaveLength(4); // 2 lines × 2 passes, one line per request
    expect(engine.prompts.filter((p) => p.includes('HARD limit'))).toHaveLength(2);
    expect(out.accepted.get('seg_0001')).toBe('một hai ba bốn năm');
    expect(out.accepted.get('seg_0002')).toBe('một hai ba bốn năm');
    expect(out.changes.map((c) => [c.id, c.unitsBefore, c.unitsAfter])).toEqual([
      ['seg_0001', 9, 5],
      ['seg_0002', 9, 5],
    ]);
    expect(out.stillLong).toEqual([]);
  });

  it('never lets two passes compound past the cut cap of the ORIGINAL line', async () => {
    // Pass 1 accepts 9 → 5; pass 2 offers 2 syllables: 5 → 2 would be a 78% cut of the original 9.
    const engine = chat((_id, prompt) => (prompt.includes('HARD limit') ? 'một hai' : 'một hai ba bốn năm'));
    const tight = [{ id: 'seg_0001', memberIds: ['seg_0001', 'seg_0002'], generatedMs: 5400, availableMs: 1200 }];
    const out = await shortenOverflowingLines({ ...zhVi, units: tight, segments, perSecond: 3.5 }, engine);
    expect(out.accepted.get('seg_0001')).toBe('một hai ba bốn năm');
    expect(out.rejected.some((r) => r.reason.includes('cut too far'))).toBe(true);
  });

  it('refuses re-translations that are not shorter or not clean, and records why', async () => {
    const engine = chat((id) => (id === 'seg_0001' ? 'Tôi chỉ cần một sợi lông 毫毛' : `${nine} mười`));
    const out = await shortenOverflowingLines({ ...zhVi, units, segments, perSecond: 3.5 }, engine);
    expect(out.accepted.size).toBe(0);
    expect(out.rejected.map((r) => r.reason)).toEqual(
      expect.arrayContaining([expect.stringContaining('fails line checks'), expect.stringContaining('not shorter')]),
    );
    expect(out.stillLong).toEqual(['seg_0001']);
  });
});

describe('tightenOneLine (editor)', () => {
  const segments = [
    line('seg_0001', '你们敢动我', 'Các ngươi dám động vào ta?', 0, 1500),
    line('seg_0002', '此乃上古至高道术', 'Đây chính là đạo thuật tối cao từ thời thượng cổ đấy', 1500, 3500),
    line('seg_0003', '师父会来', 'Sư phụ sẽ đến.', 3600, 5000),
  ];

  it('shortens the current line within its window and neighbours', async () => {
    const engine = chat(() => 'Đây là đạo thuật tối cao thượng cổ');
    const out = await tightenOneLine({ ...zhVi, segments, segmentId: 'seg_0002', windowMs: 2000, perSecond: 3.5 }, engine);
    expect(out).toEqual({ text: 'Đây là đạo thuật tối cao thượng cổ', shortened: true });
    expect(engine.prompts[0]).toContain('context before (do not copy): 你们敢动我 => Các ngươi dám động vào ta?');
    expect(engine.prompts[0]).toContain('context after (do not copy): 师父会来 => Sư phụ sẽ đến.');
  });

  it('keeps the line and says why when the proposal is refused', async () => {
    const out = await tightenOneLine(
      { ...zhVi, segments, segmentId: 'seg_0002', windowMs: 2000, perSecond: 3.5 },
      chat(() => 'Tránh làm vỡ.'),
    );
    expect(out.shortened).toBe(false);
    expect(out.text).toBe('Đây chính là đạo thuật tối cao từ thời thượng cổ đấy');
    expect(out.reason).toContain('cut too far');
  });
});
