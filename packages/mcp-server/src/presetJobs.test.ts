import { describe, expect, it } from 'vitest';

import { describeBuiltinPreset, describePresetSeries, missingLanguage, seriesRequest } from './presetJobs.js';

describe('seriesRequest', () => {
  it('fills the documented defaults without a preset, and the AI the caller would get', () => {
    expect(seriesRequest({ maxMinutes: 10, minMinutes: 30 }, { preset: false, defaultAi: 'anthropic-translate' })).toEqual({
      minMinutes: 30,
      maxMinutes: 30,
      aiProviderId: 'anthropic-translate',
      recapSec: 4,
      autoStart: true,
    });
    expect(seriesRequest(undefined, { preset: false })).toBeUndefined();
  });

  it('sends only what the call gives with a preset: the app lays it over the preset\'s block', () => {
    expect(seriesRequest({ autoStart: true, nameTemplate: '  {series} {nn} ' }, { preset: true, defaultAi: 'ignored' })).toEqual({
      autoStart: true,
      nameTemplate: '{series} {nn}',
    });
    expect(seriesRequest({}, { preset: true })).toEqual({});
  });
});

describe('missingLanguage', () => {
  it('asks for a dub language only when there is neither one nor a preset', () => {
    expect(missingLanguage(undefined, undefined)).toContain('targetLanguage');
    expect(missingLanguage(' ', '')).toContain('presetId');
    expect(missingLanguage('vi-VN', undefined)).toBeUndefined();
    expect(missingLanguage(undefined, 'preset_1')).toBeUndefined();
  });

  it('asks for it with a built-in preset, which works for any language', () => {
    expect(missingLanguage(undefined, 'builtin:quality')).toContain('the built-in preset "builtin:quality" works for any language');
    expect(missingLanguage('vi-VN', 'builtin:quality')).toBeUndefined();
  });
});

describe('describeBuiltinPreset', () => {
  it('lists what it gains and costs in one line', () => {
    expect(
      describeBuiltinPreset({
        id: 'builtin:economy',
        name: 'Lowest cost',
        targetLanguage: 'vi-VN',
        settings: {},
        builtin: { kind: 'economy', tradeoffs: [{ key: 'a', text: 'No speaker detection.' }, { key: 'b', text: 'Everything runs on this computer.' }] },
        createdAt: '',
        updatedAt: '',
      }),
    ).toBe('- builtin:economy "Lowest cost": No speaker detection; Everything runs on this computer.');
  });
});

describe('describePresetSeries', () => {
  it('says when a video becomes a series and how its parts are made', () => {
    expect(
      describePresetSeries({ minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic', recapSec: 4, autoStart: false, nameTemplate: '{series} - Phần {n} - {title}' }),
    ).toBe('series of 30-40 min parts for videos over 60 min, AI anthropic, parts named "{series} - Phần {n} - {title}", 4 s recap, stops at review of the cuts');
    expect(describePresetSeries({ longerThanMinutes: 45 })).toBe('series of 15-20 min parts for videos over 45 min, parts start by themselves when the analysis is clean');
  });
});
