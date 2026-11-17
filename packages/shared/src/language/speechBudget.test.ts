import { describe, expect, it } from 'vitest';
import { budgetUnitLabel, speechBudget } from './speechBudget.js';

describe('speechBudget', () => {
  it('counts Vietnamese in syllables, Chinese in characters, the rest in words', () => {
    expect(speechBudget('vi-VN', 0, 3000)).toEqual({ amount: 14, unit: 'syllables' });
    expect(speechBudget('zh', 0, 3000)).toEqual({ amount: 13, unit: 'characters' });
    expect(speechBudget('en-US', 0, 3000)).toEqual({ amount: 8, unit: 'words' });
  });

  it('has no budget without a usable window', () => {
    expect(speechBudget('vi')).toBeUndefined();
    expect(speechBudget('vi', 2000, 2000)).toBeUndefined();
    expect(speechBudget('vi', 3000, 2000)).toBeUndefined();
  });

  it('uses the voice rate when the caller knows it (VieNeu speaks ~3.5 syllables/s, not 4.6)', () => {
    expect(speechBudget('vi', 0, 3000, { perSecond: 3.5 })).toEqual({ amount: 11, unit: 'syllables' });
    // The unit stays the language's: a rate changes the amount, never the counting.
    expect(speechBudget('zh', 0, 3000, { perSecond: 3 })).toEqual({ amount: 9, unit: 'characters' });
  });

  it('ignores an unusable rate instead of producing a zero or NaN budget', () => {
    for (const perSecond of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(speechBudget('vi', 0, 3000, { perSecond })).toEqual({ amount: 14, unit: 'syllables' });
    }
    expect(speechBudget('vi', 0, 3000, {})).toEqual({ amount: 14, unit: 'syllables' });
  });

  it('never budgets less than one unit', () => {
    expect(speechBudget('vi', 0, 50, { perSecond: 3.5 })).toEqual({ amount: 1, unit: 'syllables' });
  });
});

describe('budgetUnitLabel', () => {
  it('names Vietnamese syllables in both languages, everything else plainly', () => {
    expect(budgetUnitLabel('syllables', 'vi-VN')).toBe('syllables (âm tiết)');
    expect(budgetUnitLabel('words', 'en')).toBe('words');
  });
});
