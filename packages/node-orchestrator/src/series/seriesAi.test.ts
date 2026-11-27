import { describe, expect, it } from 'vitest';

import { aiTitlePart, clipText, type SeriesChat } from './seriesAi.js';

describe('part titles and summaries (claude-dubber, Phong Thủy Thiên Sư, 2026-11-27)', () => {
  it('cuts a long summary where a sentence ends, else where a word does, never inside a word', () => {
    expect(clipText('Ngắn gọn.', 400)).toBe('Ngắn gọn.');
    const sentences = `Tổ Sư Gia đưa Lâm Phàm xuống núi. ${'Hai người gặp ma quỷ khắp nơi '.repeat(4)}`;
    expect(clipText(sentences, 60)).toBe('Tổ Sư Gia đưa Lâm Phàm xuống núi.');
    const words = 'một hai ba bốn năm sáu bảy tám chín mười mười một mười hai';
    const cut = clipText(words, 30);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(kept.length).toBeLessThanOrEqual(30);
    // A whole word before the cut: the original goes on with a space.
    expect(words.startsWith(kept)).toBe(true);
    expect(words.charAt(kept.length)).toBe(' ');
  });

  it('asks for a summary of a set length, and Vietnamese names as viewers know them for a Chinese series', async () => {
    const asked: string[] = [];
    const long = `Lâm Phàm theo Tổ Sư Gia sang Nhật Bản. ${'Họ gặp chuyện kỳ lạ trên đường và trừ yêu diệt ma. '.repeat(12)}`;
    const chat: SeriesChat = {
      chatComplete: async (_system, user) => {
        asked.push(user);
        return JSON.stringify({ title: 'Sang Nhật Bản', summary: long });
      },
    };
    const lines = [{ startMs: 0, endMs: 2000, sourceText: '东洋人来了' }];
    const part = { index: 3, startMs: 0, endMs: 60_000 };
    const named = await aiTitlePart(chat, part, 29, lines, {
      seriesName: '风水天师',
      sourceLanguageName: 'Chinese',
      targetLanguageName: 'Vietnamese',
      sourceLanguage: 'zh',
      targetLanguage: 'vi-VN',
    });
    expect(asked[0]).toContain('at most 250 characters');
    expect(asked[0]).toContain('东洋 → Nhật Bản (or Đông Doanh), never "Đông Dương"');
    // The reply's summary was over 600 characters: cut after its last whole sentence within 400.
    expect(named?.title).toBe('Sang Nhật Bản');
    expect(named!.summary.length).toBeLessThanOrEqual(400);
    expect(named!.summary.endsWith('diệt ma.')).toBe(true);
    expect(long.startsWith(named!.summary)).toBe(true);

    // Into English, no Vietnamese naming rule.
    await aiTitlePart(chat, part, 29, lines, { seriesName: '风水天师', sourceLanguageName: 'Chinese', targetLanguageName: 'English', sourceLanguage: 'zh', targetLanguage: 'en' });
    expect(asked[1]).not.toContain('Đông Dương');
  });
});
