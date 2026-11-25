import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanPresetInput, cleanPresetSeries, PresetStore } from './presetStore.js';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-presets-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('cleanPresetInput', () => {
  it('keeps the languages out of settings and refuses a nameless preset', () => {
    const clean = cleanPresetInput({
      name: '  Kênh A ',
      targetLanguage: 'vi-VN',
      settings: { targetLanguage: 'en', ttsVoiceId: 'v1', subtitleExportMode: 'burned-in' },
      start: true,
      junk: 1,
    });
    expect(clean).toEqual({ name: 'Kênh A', targetLanguage: 'vi-VN', settings: { ttsVoiceId: 'v1', subtitleExportMode: 'burned-in' }, start: true });
    expect(() => cleanPresetInput({ targetLanguage: 'vi-VN' })).toThrow(/name/);
    expect(() => cleanPresetInput({ name: 'x', targetLanguage: 'vi', outputDir: 'Dubs' })).toThrow(/full path/);
  });

  it('keeps a save folder named after each job, and a series block', () => {
    const dir = path.join(os.tmpdir(), 'Dubs', '{series}');
    const clean = cleanPresetInput({
      name: 'Tiệm phim',
      targetLanguage: 'vi-VN',
      sourceLanguage: 'zh',
      outputDir: dir,
      series: { minMinutes: 30, maxMinutes: 40, ai: 'anthropic', recapSec: 4, autoStart: false, nameTemplate: '{series} - Phần {n} - {title}' },
    });
    expect(clean.outputDir).toBe(dir);
    // The AI's short name is kept as the app's id.
    expect(clean.series).toEqual({
      minMinutes: 30,
      maxMinutes: 40,
      aiProviderId: 'anthropic-translate',
      recapSec: 4,
      autoStart: false,
      nameTemplate: '{series} - Phần {n} - {title}',
    });
    expect(() => cleanPresetInput({ name: 'x', targetLanguage: 'vi', outputDir: '{series}' })).toThrow(/full path/);
  });
});

describe('cleanPresetSeries', () => {
  it('keeps well-formed values, clamped, and says nothing for an empty block', () => {
    expect(cleanPresetSeries({ minMinutes: 2, maxMinutes: 1, recapSec: 30, longerThanMinutes: 90, aiProviderId: ' openai ', junk: true })).toEqual({
      minMinutes: 5,
      maxMinutes: 5,
      recapSec: 8,
      longerThanMinutes: 90,
      aiProviderId: 'openai-translate',
    });
    expect(cleanPresetSeries({ minMinutes: 'x', autoStart: 'yes' })).toBeUndefined();
    expect(cleanPresetSeries(undefined)).toBeUndefined();
    expect(cleanPresetSeries([1])).toBeUndefined();
  });

  it('refuses part names that cannot tell the parts apart', () => {
    expect(() => cleanPresetSeries({ nameTemplate: '{series} - {title}' })).toThrow(/cannot name the parts/);
  });
});

describe('PresetStore', () => {
  it('saves, replaces and deletes presets, keeping two quick saves', async () => {
    const store = new PresetStore(dir);
    const [a, b] = await Promise.all([
      store.save({ name: 'A', targetLanguage: 'vi-VN', settings: {} }),
      store.save({ name: 'B', targetLanguage: 'en-US', settings: {} }),
    ]);
    expect((await store.list()).map((p) => p.name)).toEqual(['A', 'B']);

    const a2 = await store.save({ name: 'A2', targetLanguage: 'vi-VN', settings: { ttsGainDb: 2 } }, a.id);
    expect(a2.id).toBe(a.id);
    expect(a2.createdAt).toBe(a.createdAt);
    expect((await store.get(a.id)).settings).toEqual({ ttsGainDb: 2 });

    await store.delete(b.id);
    expect((await store.list()).map((p) => p.id)).toEqual([a.id]);
    await expect(store.get(b.id)).rejects.toThrow(/no preset/);
    await expect(store.save({ name: 'x', targetLanguage: 'vi', settings: {} }, 'preset_missing')).rejects.toThrow(/no preset/);
  });
});
