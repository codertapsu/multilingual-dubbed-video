import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialsStore } from '../../credentials/credentialsStore.js';
import { extractJsonObject } from './cloudHttp.js';
import {
  LlmTranslationProvider,
  buildTranslationPrompt,
  parseTranslationReply,
  planTranslationBatches,
} from '../translation/llmTranslationProvider.js';
import { mapOpenAiSegments } from '../stt/openaiSttProvider.js';
import { segmentFilename, wavDurationMs } from '../tts/openaiTtsProvider.js';

describe('extractJsonObject', () => {
  it('parses bare JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('finds the object inside prose', () => {
    expect(extractJsonObject('Here you go: {"a":1} — enjoy!')).toEqual({ a: 1 });
  });
  it('returns undefined for garbage', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
});

describe('translation prompt + reply parsing', () => {
  it('numbers segments by id and demands strict JSON', () => {
    const prompt = buildTranslationPrompt('en', 'vi-VN', [
      { id: 'seg_0001', sourceText: 'Hello there.' },
      { id: 'seg_0002', sourceText: 'Goodbye.' },
    ]);
    expect(prompt).toContain('seg_0001: Hello there.');
    expect(prompt).toContain('"en"');
    expect(prompt).toContain('"vi-VN"');
    expect(prompt).toContain('ONLY a JSON object');
  });

  it('parses replies and ignores malformed entries', () => {
    const map = parseTranslationReply(
      '{"segments":[{"id":"seg_0001","text":"Xin chào."},{"id":42,"text":"bad"},{"id":"seg_0002"}]}',
    );
    expect(map.get('seg_0001')).toBe('Xin chào.');
    expect(map.size).toBe(1);
  });
});

describe('LlmTranslationProvider', () => {
  let dir: string;
  let store: CredentialsStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-llm-'));
    store = new CredentialsStore(dir);
    await store.save({ service: 'openai', apiKey: 'sk-test-1234567890abcdefh1Q4' });
    await store.save({ service: 'anthropic', apiKey: 'sk-ant-test-1234567890ab' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('translates via the OpenAI dialect and maps ids back', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const provider = new LlmTranslationProvider('openai', store, 5000, async (url, headers, body) => {
      calls.push({ url, headers: headers as Record<string, string>, body });
      return {
        choices: [
          { message: { content: '{"segments":[{"id":"seg_0001","text":"Xin chào."},{"id":"seg_0002","text":"Tạm biệt."}]}' } },
        ],
      } as never;
    });

    const result = await provider.translateSegments({
      sourceLanguage: 'en-US',
      targetLanguage: 'vi-VN',
      segments: [
        { id: 'seg_0001', sourceText: 'Hello.', startMs: 0, endMs: 1000 },
        { id: 'seg_0002', sourceText: 'Goodbye.', startMs: 1000, endMs: 2000 },
      ],
    });

    expect(result.segments).toEqual([
      { id: 'seg_0001', translatedText: 'Xin chào.' },
      { id: 'seg_0002', translatedText: 'Tạm biệt.' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers.Authorization).toMatch(/^Bearer sk-test/);
  });

  it('uses the Anthropic dialect for the claude provider', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const provider = new LlmTranslationProvider('anthropic', store, 5000, async (url, headers) => {
      calls.push({ url, headers: headers as Record<string, string> });
      return { content: [{ type: 'text', text: '{"segments":[{"id":"seg_0001","text":"Xin chào."}]}' }] } as never;
    });

    const result = await provider.translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: [{ id: 'seg_0001', sourceText: 'Hello.', startMs: 0, endMs: 1000 }],
    });

    expect(result.segments[0].translatedText).toBe('Xin chào.');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toMatch(/^sk-ant/);
    expect(calls[0].headers['anthropic-version']).toBeTruthy();
  });

  it('falls back to the source text for ids the model dropped', async () => {
    const provider = new LlmTranslationProvider('openai', store, 5000, async () => {
      return { choices: [{ message: { content: '{"segments":[{"id":"seg_0001","text":"Một."}]}' } }] } as never;
    });
    const result = await provider.translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: [
        { id: 'seg_0001', sourceText: 'One.', startMs: 0, endMs: 1000 },
        { id: 'seg_0002', sourceText: 'Two.', startMs: 1000, endMs: 2000 },
      ],
    });
    expect(result.segments[1]).toEqual({ id: 'seg_0002', translatedText: 'Two.' });
  });

  it('throws CLOUD_CREDENTIALS_MISSING without a key', async () => {
    const empty = new CredentialsStore(await mkdtemp(path.join(os.tmpdir(), 'vd-nokey-')));
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const provider = new LlmTranslationProvider('gemini', empty, 5000, async () => ({}) as never);
    await expect(
      provider.translateSegments({ sourceLanguage: 'en', targetLanguage: 'vi', segments: [] }),
    ).rejects.toMatchObject({ appError: { code: 'CLOUD_CREDENTIALS_MISSING' } });
  });

  const tenSegments = Array.from({ length: 10 }, (_, i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    sourceText: `line ${i}`,
    startMs: i * 2000,
    endMs: i * 2000 + 1500,
  }));

  it('injects a provided character sheet into every batch prompt (no analysis call)', async () => {
    const prompts: string[] = [];
    const provider = new LlmTranslationProvider('openai', store, 5000, async (_url, _headers, body) => {
      const b = body as { messages: { content: string }[] };
      prompts.push(b.messages[1]!.content);
      return { choices: [{ message: { content: '{"segments":[]}' } }] } as never;
    });

    await provider.translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: tenSegments,
      documentContext: { pronounGuide: 'học sinh -> giáo viên: thầy/em' },
    });

    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      // Every call is a TRANSLATION call (the provided sheet suppressed analysis)…
      expect(p).toContain('Translate the following subtitle segments');
      // …and carries the sheet.
      expect(p).toContain('thầy/em');
    }
  });

  it('generates + returns the analysis when no sheet is provided', async () => {
    let call = 0;
    const prompts: string[] = [];
    const provider = new LlmTranslationProvider('openai', store, 5000, async (_url, _headers, body) => {
      const b = body as { messages: { content: string }[] };
      prompts.push(b.messages[1]!.content);
      const reply =
        call++ === 0
          ? '{"synopsis":"a lesson","pronounGuide":"thầy/em"}'
          : '{"segments":[]}';
      return { choices: [{ message: { content: reply } }] } as never;
    });

    const result = await provider.translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: tenSegments,
    });

    expect(prompts[0]).toContain('Analyze the following transcript');
    expect(result.analysis).toEqual({ synopsis: 'a lesson', pronounGuide: 'thầy/em' });
    // The generated sheet flows into the translation prompts that follow.
    expect(prompts[1]).toContain('a lesson');
  });
});

describe('OpenAI STT segment mapping', () => {
  it('maps verbose_json to zero-padded ids and integer ms', () => {
    const segments = mapOpenAiSegments([
      { start: 0.0, end: 2.345, text: ' Hello there. ' },
      { start: 2.345, end: 5.0, text: 'General Kenobi.' },
      { start: 5.0, end: 6.0, text: '   ' }, // dropped: empty
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ id: 'seg_0001', index: 0, startMs: 0, endMs: 2345, sourceText: 'Hello there.' });
    expect(segments[1].id).toBe('seg_0002');
  });
});

describe('OpenAI TTS helpers', () => {
  it('derives the filename from trailing digits like the local worker', () => {
    expect(segmentFilename('seg_0007', 99)).toBe('segment_0007.wav');
    expect(segmentFilename('intro', 3)).toBe('segment_0003.wav');
  });

  it('reads the duration from a minimal PCM WAV header', () => {
    // 1 second of silence: 16-bit mono 8 kHz -> byteRate 16000, data 16000 bytes.
    const byteRate = 16000;
    const dataSize = 16000;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(8000, 24); // sample rate
    buf.writeUInt32LE(byteRate, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits/sample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataSize, 40);
    expect(wavDurationMs(buf)).toBe(1000);
  });

  it('returns 0 for non-WAV buffers', () => {
    expect(wavDurationMs(Buffer.from('definitely not a wav file, sorry'))).toBe(0);
  });
});

describe('planTranslationBatches', () => {
  const seg = (id: string, len: number) => ({ id, sourceText: 'x'.repeat(len) });

  it('packs short lines up to the segment cap', () => {
    const segs = Array.from({ length: 60 }, (_, i) => seg(`seg_${i}`, 20));
    const batches = planTranslationBatches(segs, 25, 100_000);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
  });

  it('splits earlier when segments are long (char budget)', () => {
    // ~540 chars each => ~14 fit under an 8000-char budget before the count cap.
    const segs = Array.from({ length: 30 }, (_, i) => seg(`seg_${i}`, 500));
    const batches = planTranslationBatches(segs, 25, 8000);
    expect(batches.length).toBeGreaterThan(Math.ceil(30 / 25));
    for (const b of batches) {
      const chars = b.reduce((n, s) => n + s.id.length + s.sourceText.length + 40, 0);
      // Each batch is within budget OR is a single oversized segment on its own.
      expect(b.length === 1 || chars <= 8000).toBe(true);
    }
  });

  it('never drops or reorders segments', () => {
    const segs = Array.from({ length: 17 }, (_, i) => seg(`seg_${i}`, 1000));
    const flat = planTranslationBatches(segs, 25, 8000).flat();
    expect(flat.map((s) => s.id)).toEqual(segs.map((s) => s.id));
  });
});
