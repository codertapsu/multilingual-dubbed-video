import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readTranslationCheckpoint,
  translationCheckpointKey,
  TranslationCheckpointWriter,
  type TranslationCheckpointKeyParts,
} from './translationCheckpoint.js';

let tmp: string;
let file: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-tr-checkpoint-'));
  file = path.join(tmp, 'translation.partial.json');
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const parts: TranslationCheckpointKeyParts = {
  providerId: 'llama-cpp-chat',
  model: 'Gemma chat',
  sourceLanguage: 'zh',
  targetLanguage: 'vi-VN',
  segments: [
    { id: 'seg_0001', sourceText: '你好', startMs: 0, endMs: 900 },
    { id: 'seg_0002', sourceText: '再见', startMs: 1000, endMs: 1900 },
  ],
  speechRate: 4.2,
};

describe('translationCheckpointKey', () => {
  it('is the same for the same translation, and changes with anything the lines depend on', () => {
    const key = translationCheckpointKey(parts);
    expect(translationCheckpointKey({ ...parts })).toBe(key);
    for (const changed of [
      { providerId: 'claude' },
      { model: 'Gemma 4' },
      { targetLanguage: 'en' },
      { segments: [{ ...parts.segments[0]!, sourceText: '您好' }, parts.segments[1]!] },
      { segments: [{ ...parts.segments[0]!, endMs: 950 }, parts.segments[1]!] },
      { documentContext: { synopsis: 'A trip.' } },
      { speechRate: 3.9 },
    ] satisfies Partial<TranslationCheckpointKeyParts>[]) {
      expect(translationCheckpointKey({ ...parts, ...changed })).not.toBe(key);
    }
  });
});

describe('the checkpoint file', () => {
  it('keeps the lines saved for this translation, and nothing for another', async () => {
    const key = translationCheckpointKey(parts);
    const writer = new TranslationCheckpointWriter(file, key);
    writer.add([
      { id: 'seg_0001', translatedText: 'Xin chào' },
      // An empty line is no translation: not saved.
      { id: 'seg_0002', translatedText: '  ' },
    ]);
    await writer.flush();

    expect([...(await readTranslationCheckpoint(file, key))]).toEqual([['seg_0001', 'Xin chào']]);
    expect((await readTranslationCheckpoint(file, translationCheckpointKey({ ...parts, speechRate: 1 }))).size).toBe(0);
  });

  it('adds to what an earlier run saved, and is gone once the step finished', async () => {
    const key = translationCheckpointKey(parts);
    const first = new TranslationCheckpointWriter(file, key);
    first.add([{ id: 'seg_0001', translatedText: 'Xin chào' }]);
    await first.flush();

    const saved = await readTranslationCheckpoint(file, key);
    const second = new TranslationCheckpointWriter(file, key, saved);
    second.add([{ id: 'seg_0002', translatedText: 'Tạm biệt' }]);
    await second.flush();
    expect((await readTranslationCheckpoint(file, key)).size).toBe(2);

    await second.discard();
    await expect(fsp.stat(file)).rejects.toThrow();
  });

  it('reads an unreadable file as no progress', async () => {
    await fsp.writeFile(file, '{"key": "x", "lines": ', 'utf8');
    expect((await readTranslationCheckpoint(file, 'x')).size).toBe(0);
  });
});
