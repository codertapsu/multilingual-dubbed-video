import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanPresetInput, PresetStore } from './presetStore.js';

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
