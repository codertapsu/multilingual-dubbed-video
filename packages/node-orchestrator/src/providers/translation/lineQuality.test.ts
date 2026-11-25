import { describe, expect, it } from 'vitest';
import {
  checkDubLine,
  describeFlags,
  isPinyinToken,
  isPlausibleVietnameseSyllable,
  pickBestCandidate,
  qualityScore,
  segmentPinyin,
  wordsAtFault,
  wrongScripts,
} from './lineQuality.js';

const zhVi = (sourceText: string) => ({ sourceText, sourceLanguage: 'zh', targetLanguage: 'vi-VN' });

describe('checkDubLine — the lines a zh→vi audit found shipping (2026-11)', () => {
  it('flags Han characters left inside Vietnamese', () => {
    expect(checkDubLine('Khu vực bán hàng của鸿蒙', zhVi('鸿蒙铺'))).toEqual(['wrong-script']);
    expect(checkDubLine('Nguồn năng lượng sau khi Nữ Th娲 vá bầu trời.', zhVi('女娲补天'))).toEqual(['wrong-script']);
    expect(checkDubLine('Ngoài ra, còn có bản "盘古大神".', zhVi('又存有盘古大神的'))).toEqual(['wrong-script']);
  });

  it('flags a Thai combining mark on a Latin letter (Script=Thai, not a Vietnamese tone)', () => {
    expect(checkDubLine('Mุ่ง thẳng đến trời cao', zhVi('直指天庭'))).toEqual(['wrong-script']);
  });

  it('flags pinyin names a Vietnamese voice cannot read as Hán-Việt', () => {
    expect(checkDubLine('Kunlun Xu ngày nào cũng suýt chết.', zhVi('昆仑旭每天都有快死'))).toEqual(['pinyin']);
    expect(checkDubLine('Ông Zhang San thứ', zhVi('张三世'))).toEqual(['pinyin']);
    expect(checkDubLine('Nguồn gốc của Wu Zhi Qi', zhVi('吴之奇本源'))).toEqual(['pinyin']);
    expect(checkDubLine('Na-er-gơ', zhVi('娜尔哥'))).toEqual(['pinyin']);
  });

  it('flags "/" alternatives the voice would read aloud', () => {
    expect(checkDubLine('Cảm ơn thầy/cô', zhVi('谢谢师尊'))).toEqual(['alternatives']);
    expect(checkDubLine('Anh / Em gọi tôi', zhVi('伤我叫'))).toEqual(['alternatives']);
  });

  it('reads a unit rate as a unit, not a hedge', () => {
    for (const line of ['Xe chạy 60 km/h trên đường.', 'Tốc độ 100 km/giờ rồi.', 'Gió thổi 3 m/s.']) {
      expect(checkDubLine(line, zhVi('x')), line).toEqual([]);
    }
  });

  it('flags 4+ words without a single Vietnamese diacritic', () => {
    expect(checkDubLine('Let me go now please', zhVi('让我走'))).toEqual(['no-diacritics']);
    expect(checkDubLine('Anh ta la ai vay', zhVi('他是谁'))).toEqual(['no-diacritics']);
    // Three bare words are fine ("Anh ta đâu" style lines are common).
    expect(checkDubLine('Anh ta cho', zhVi('他给'))).toEqual([]);
  });

  it('flags untranslated lines: empty, or the source echoed back', () => {
    expect(checkDubLine('', zhVi('你好'))).toEqual(['untranslated']);
    expect(checkDubLine(undefined, zhVi('你好'))).toEqual(['untranslated']);
    expect(checkDubLine('你干什么', zhVi('你干什么'))).toEqual(['untranslated']);
  });

  it('passes clean Vietnamese, including Hán-Việt names and short bare words', () => {
    for (const line of [
      'Côn Lôn Khư ngày nào cũng suýt chết.',
      'Có mặt!',
      'Ở đâu?',
      'Thanh Long, Chu Tước, Huyền Vũ, Bạch Hổ.',
      'Ta là thần.',
      'Hahaha!',
      'CEO của Long Ma',
      'Tỷ số 1/2 rồi.',
    ]) {
      expect(checkDubLine(line, zhVi('x')), line).toEqual([]);
    }
  });

  it('does not pinyin-check lines translated from other languages (English loanwords are fine)', () => {
    expect(checkDubLine('Chơi game trên Facebook', { sourceText: 'Play games', sourceLanguage: 'en', targetLanguage: 'vi' })).toEqual([]);
  });

  it('leaves the loanwords and brands of a Vietnamese line alone', () => {
    for (const line of [
      'Tối nay chơi game không?',
      'Game này khó quá.',
      'Đi taxi về nhà đi.',
      'Gọi món theo menu nhé.',
      'Hát karaoke với camera mới.',
      'Đôi giày Nike này đẹp đấy.',
      'Xem trên YouTube rồi.',
    ]) {
      expect(checkDubLine(line, zhVi('x')), line).toEqual([]);
    }
    // A Chinese word with a Hán-Việt form is still pinyin.
    expect(checkDubLine('Hắn luyện Taichi mỗi sáng.', zhVi('他每天早上练太极'))).toEqual(['pinyin']);
  });

  it('only checks pinyin in Vietnamese: other languages write Chinese names in it', () => {
    const zhEn = (sourceText: string) => ({ sourceText, sourceLanguage: 'zh', targetLanguage: 'en' });
    expect(checkDubLine('You cannot talk to her like that.', zhEn('你不能这样跟她说话'))).toEqual([]);
    expect(checkDubLine('She is my sister. We win, it is fun.', zhEn('她是我妹妹'))).toEqual([]);
    expect(checkDubLine('Zhang San went to Kunlun.', zhEn('张三去了昆仑'))).toEqual([]);
  });

  it('checks the script for other targets too', () => {
    const enCtx = { sourceText: 'Привет', sourceLanguage: 'ru', targetLanguage: 'en' };
    expect(checkDubLine('Hello, Привет friend', enCtx)).toEqual(['wrong-script']);
    expect(checkDubLine('你好，Anna', { sourceText: 'Hello Anna', sourceLanguage: 'en', targetLanguage: 'zh' })).toEqual([]);
    // Unknown target: only the SOURCE's own script counts as a leak.
    const sw = { sourceText: '你好世界', sourceLanguage: 'zh', targetLanguage: 'sw' };
    expect(wrongScripts('Habari 世界', sw)).toEqual(['Han']);
    expect(wrongScripts('Habari dunia', sw)).toEqual([]);
  });
});

describe('pinyin detection', () => {
  it('segments romanized Chinese, not English loanwords', () => {
    expect(segmentPinyin('kunlun')).toEqual(['kun', 'lun']);
    expect(segmentPinyin('hongmeng')).toEqual(['hong', 'meng']);
    expect(segmentPinyin('video')).toBeUndefined();
    expect(segmentPinyin('internet')).toBeUndefined();
  });

  it('never flags a token that is one written Vietnamese syllable', () => {
    for (const t of ['anh', 'con', 'ta', 'sao', 'long', 'hong', 'chu', 'xu', 'thanh', 'nghe', 'giao', 'quay', 'khuya']) {
      expect(isPlausibleVietnameseSyllable(t), t).toBe(true);
      expect(isPinyinToken(t), t).toBe(false);
    }
  });

  it('flags tokens that break Vietnamese spelling or span several syllables', () => {
    for (const t of ['Kong', 'Zhang', 'Feng', 'Wang', 'Jin', 'Xie', 'Tian', 'Pangu', 'Nuwa', 'Kunlun', 'Wukong', 'Kūnlún']) {
      expect(isPinyinToken(t), t).toBe(true);
    }
  });

  it('leaves acronyms, laughter and diacritic words alone', () => {
    for (const t of ['CEO', 'TV', 'haha', 'hehehe', 'Bắc', 'Ngộ']) expect(isPinyinToken(t), t).toBe(false);
  });
});

describe('scoring and picking candidates', () => {
  it('ranks untranslated worst and alternatives mildest', () => {
    expect(qualityScore(['untranslated'])).toBeGreaterThan(qualityScore(['wrong-script', 'pinyin', 'no-diacritics', 'alternatives']));
    expect(qualityScore([])).toBe(0);
  });

  it('picks the cleanest candidate and keeps the earlier one on a tie', () => {
    const best = pickBestCandidate([
      { text: 'Nữ Th娲', flags: ['wrong-script'] },
      { text: 'Nuwa', flags: ['pinyin'] },
      { text: 'Nữ Oa', flags: [] },
    ]);
    expect(best?.text).toBe('Nữ Oa');
    expect(pickBestCandidate([{ text: 'a/b', flags: ['alternatives'] }, { text: 'c/d', flags: ['alternatives'] }])?.text).toBe('a/b');
  });

  it('describes problems in words a repair prompt can act on', () => {
    expect(describeFlags(['pinyin'], 'vi')).toContain('Hán-Việt');
    expect(describeFlags(['alternatives'], 'vi')).toContain('exactly ONE');
  });
});

describe('the words at fault (the second repair names them)', () => {
  const ctx = { sourceText: '昆仑墟的鸿蒙', sourceLanguage: 'zh', targetLanguage: 'vi-VN' };
  it('the word with Chinese letters, the pinyin name, the hedge, each as written', () => {
    expect(wordsAtFault('Khu vực của鸿蒙, Kunlun Xu và thầy/cô.', ctx, ['wrong-script', 'pinyin', 'alternatives'])).toEqual([
      'của鸿蒙',
      'Kunlun',
      'thầy/cô',
    ]);
  });
  it('only for the checks that failed; a unit rate is no hedge', () => {
    expect(wordsAtFault('Chạy 60 km/h với Kunlun', ctx, ['alternatives'])).toEqual([]);
    expect(wordsAtFault('Toi khong biet', ctx, ['no-diacritics'])).toEqual([]);
  });
});
