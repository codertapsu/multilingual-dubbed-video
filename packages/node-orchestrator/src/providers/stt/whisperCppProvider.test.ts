/**
 * The whisper.cpp STT provider had no test, and shipped two bugs that hid each
 * other: whisper-server was started with no model (so it died loading its
 * default `models/ggml-base.en.bin`), and the request asked for
 * `response_format=json`, which whisper-server answers with `{ text }` alone —
 * so fixing only the model would have produced an EMPTY transcript. These tests
 * drive the provider against a real local HTTP server and pin both.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import {
  detectedLanguageOf,
  mapWhisperServerSegments,
  WhisperCppProvider,
  type WhisperServerResponse,
} from './whisperCppProvider.js';

/** Trimmed from a real whisper-server v1.9.5 verbose_json answer (RTX 3050, a Chinese chunk). */
const VERBOSE_JSON: WhisperServerResponse = {
  text: '这又给小爷我干哪儿来了 这里不是三千',
  segments: [
    { start: 0, end: 4.48, text: '这又给小爷我干哪儿来了' },
    { start: 4.48, end: 5.96, text: '这里不是三千' },
    { start: 5.96, end: 6.5, text: '[BLANK_AUDIO]' },
    { start: 30, end: 46.96, text: '虎哥 这啥地方啊' },
  ],
  language_probabilities: { zh: 0.9901, en: 0.0072, ja: 0.001 },
};

interface Captured {
  fields: Record<string, string>;
  fileName?: string;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('WhisperCppProvider', () => {
  let dir: string;
  let audio: string;
  let server: Server;
  let baseUrl: string;
  let captured: Captured[];
  let reply: WhisperServerResponse;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-whispercpp-'));
    audio = path.join(dir, 'chunk_0000.wav');
    await writeFile(audio, Buffer.from('RIFF....WAVEfmt '));
    captured = [];
    reply = VERBOSE_JSON;
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      const form = await new Response(body, {
        headers: { 'content-type': req.headers['content-type'] ?? '' },
      }).formData();
      const fields: Record<string, string> = {};
      let fileName: string | undefined;
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else fileName = v.name;
      }
      captured.push({ fields, ...(fileName ? { fileName } : {}) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const provider = (opts: { resolveModel?: (m: string) => Promise<string> } = {}) => {
    const starts: { packId: string; opts: unknown }[] = [];
    const p = new WhisperCppProvider(
      {
        ensureRunning: async (packId: string, o?: unknown) => {
          starts.push({ packId, opts: o });
          return baseUrl;
        },
      },
      async () => 'whisper-cpp-cuda',
      opts.resolveModel ?? (async (m) => path.join(dir, `whisper-model-${m}`, 'model.bin')),
      30_000,
    );
    return { p, starts };
  };

  it('starts the engine WITH the project model, exclusively', async () => {
    const { p, starts } = provider();
    await p.transcribe({ audioPath: audio, language: 'zh', model: 'large-v3-turbo', wordTimestamps: true });
    expect(starts).toEqual([
      {
        packId: 'whisper-cpp-cuda',
        opts: { exclusive: true, model: path.join(dir, 'whisper-model-large-v3-turbo', 'model.bin') },
      },
    ]);
  });

  it('asks for verbose_json — `json` carries no segments — and returns them timed', async () => {
    const { p } = provider();
    const result = await p.transcribe({ audioPath: audio, language: 'zh', model: 'large-v3-turbo', wordTimestamps: true });

    expect(captured[0]!.fields.response_format).toBe('verbose_json');
    expect(captured[0]!.fields.language).toBe('zh');
    expect(captured[0]!.fileName).toBe('chunk_0000.wav');
    expect(result.segments.map((s) => [s.startMs, s.endMs, s.sourceText])).toEqual([
      [0, 4480, '这又给小爷我干哪儿来了'],
      [4480, 5960, '这里不是三千'],
      [30000, 46960, '虎哥 这啥地方啊'],
    ]);
    expect(result.segments.map((s) => s.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003']);
    expect(result.detectedLanguage).toBe('zh');
  });

  it('leaves the language to the engine when the project has none, and reports what it detected', async () => {
    const { p } = provider();
    const result = await p.transcribe({ audioPath: audio, model: 'large-v3-turbo', wordTimestamps: true });
    // Omitted, not "en": the engine is launched with `-l auto`.
    expect(captured[0]!.fields).not.toHaveProperty('language');
    expect(result.detectedLanguage).toBe('zh');
  });

  it('a project language wins over detection', async () => {
    reply = { ...VERBOSE_JSON, language_probabilities: { en: 0.6, zh: 0.4 } };
    const { p } = provider();
    const result = await p.transcribe({ audioPath: audio, language: 'zh-CN', model: 'small', wordTimestamps: true });
    expect(captured[0]!.fields.language).toBe('zh');
    expect(result.detectedLanguage).toBe('zh');
  });

  it('a missing or unsupported model fails BEFORE an engine is started', async () => {
    const { p, starts } = provider({
      resolveModel: async () => {
        throw new AppErrorException('ENGINE_PACK_MISSING', 'whisper.cpp needs the "large-v3-turbo" speech model.');
      },
    });
    await expect(
      p.transcribe({ audioPath: audio, model: 'large-v3-turbo', wordTimestamps: true }),
    ).rejects.toMatchObject({ appError: { code: 'ENGINE_PACK_MISSING' } });
    expect(starts).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe('mapWhisperServerSegments', () => {
  it('drops segments that are only a non-speech annotation, keeps speech next to one', () => {
    const texts = mapWhisperServerSegments([
      { start: 0, end: 1, text: ' [BLANK_AUDIO]' },
      { start: 1, end: 2, text: '(音乐)' },
      { start: 2, end: 3, text: '♪ ♪' },
      { start: 3, end: 4, text: '[音乐] [掌声]' },
      { start: 4, end: 5, text: '【字幕】' },
      { start: 5, end: 6, text: '(笑) 你好' },
      { start: 6, end: 7, text: '   ' },
      { start: 7, end: 8, text: 'Hello there.' },
    ]).map((s) => s.sourceText);
    expect(texts).toEqual(['(笑) 你好', 'Hello there.']);
  });

  it('reads centisecond t0/t1 when start/end are absent', () => {
    const [seg] = mapWhisperServerSegments([{ t0: 150, t1: 420, text: 'hi' }]);
    expect([seg!.startMs, seg!.endMs]).toEqual([1500, 4200]);
  });
});

describe('detectedLanguageOf', () => {
  it('takes the most probable language CODE, not the full name', () => {
    expect(detectedLanguageOf({ language_probabilities: { en: 0.1, vi: 0.85, zh: 0.05 } })).toBe('vi');
    expect(detectedLanguageOf({})).toBeUndefined();
  });
});
