import { describe, expect, it } from 'vitest';

import { normalizeForSearch, queryTokens, searchSettings, type SettingsSearchEntry } from './settings-search';

const entries: SettingsSearchEntry[] = [
  { anchor: 'opt-language', section: 'general', title: 'Ngôn ngữ hiển thị', hint: 'Áp dụng ngay cho toàn bộ ứng dụng.' },
  { anchor: 'opt-tts-default', section: 'tts', title: 'Engine giọng đọc cho dự án mới', hint: 'Đọc bản lồng tiếng bằng giọng nói nhân tạo.' },
  {
    anchor: 'pack-tts-vieneu-cuda',
    section: 'tts',
    title: 'VieNeu-TTS 3.8 — card đồ hoạ NVIDIA',
    hint: '25 giọng đọc tiếng Việt và nhân bản giọng.',
    keywords: 'gpu vram',
  },
  { anchor: 'opt-concurrency', section: 'performance', title: 'Lồng tiếng đồng thời', hint: 'Số bản lồng tiếng chạy cùng lúc.', keywords: 'gpu' },
  { anchor: 'downloads', section: 'downloads', title: 'Khi đang lồng tiếng', hint: 'Tải video dùng mạng, ổ đĩa và bộ xử lý.' },
];

describe('settings search', () => {
  it('ignores case and Vietnamese accents, đ included', () => {
    expect(normalizeForSearch('  Giọng   ĐỌC ')).toBe('giong doc');
    expect(queryTokens('giong, doc')).toEqual(['giong', 'doc']);
    expect(searchSettings(entries, 'giong doc').map((e) => e.anchor)).toEqual(['opt-tts-default', 'pack-tts-vieneu-cuda']);
    // Typed with the accents, it finds the same.
    expect(searchSettings(entries, 'giọng đọc').map((e) => e.anchor)).toEqual(['opt-tts-default', 'pack-tts-vieneu-cuda']);
  });

  it('needs every word, anywhere in the title, explanation or keywords', () => {
    expect(searchSettings(entries, 'gpu').map((e) => e.anchor)).toEqual(['pack-tts-vieneu-cuda', 'opt-concurrency']);
    expect(searchSettings(entries, 'gpu nhân bản').map((e) => e.anchor)).toEqual(['pack-tts-vieneu-cuda']);
    expect(searchSettings(entries, 'gpu nothing-like-this')).toEqual([]);
  });

  it('lists title matches before explanation matches, then page order', () => {
    // "lồng tiếng" is in two titles and one explanation.
    expect(searchSettings(entries, 'long tieng').map((e) => e.anchor)).toEqual(['opt-concurrency', 'downloads', 'opt-tts-default']);
  });

  it('shows nothing for an empty query, and at most `limit` results', () => {
    expect(searchSettings(entries, '   ')).toEqual([]);
    expect(searchSettings(entries, 'a', 2)).toHaveLength(2);
  });
});
