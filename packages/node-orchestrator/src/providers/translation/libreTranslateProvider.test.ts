import { afterEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import { setWorkerTransport, type RawWorkerResponse } from '../workerHttp.js';
import { LibreTranslateProvider } from './libreTranslateProvider.js';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';

function rawJson(body: unknown, status = 200): RawWorkerResponse {
  return { status, ok: status >= 200 && status < 300, text: JSON.stringify(body) };
}

const fakeEngines = (baseUrl: string): EngineManager =>
  ({ ensureRunning: async () => baseUrl }) as unknown as EngineManager;
// requireInstalledPack only calls store.isInstalled for the resolved pack id.
const fakeStore = (installed: boolean): EnginePackStore =>
  ({ isInstalled: async () => installed }) as unknown as EnginePackStore;

afterEach(() => setWorkerTransport(null));

describe('LibreTranslateProvider', () => {
  it('batches segments into one /translate call and maps the array response back by id+order', async () => {
    let captured: { method: string; url: string; body: Record<string, unknown> } | undefined;
    setWorkerTransport(async (method, url, payload) => {
      captured = { method, url, body: JSON.parse(payload ?? '{}') };
      // LibreTranslate returns translatedText as an array when q is an array.
      return rawJson({ translatedText: ['Xin chào', 'Tạm biệt'] });
    });

    const provider = new LibreTranslateProvider(fakeEngines('http://127.0.0.1:5099'), fakeStore(true), 5000);
    const res = await provider.translateSegments({
      sourceLanguage: 'en-US',
      targetLanguage: 'vi-VN',
      segments: [
        { id: 'seg_0001', sourceText: 'Hello' },
        { id: 'seg_0002', sourceText: 'Goodbye' },
      ],
    });

    expect(captured?.method).toBe('POST');
    expect(captured?.url).toMatch(/\/translate$/);
    expect(captured?.body.q).toEqual(['Hello', 'Goodbye']); // one batched request
    expect(captured?.body.source).toBe('en'); // reduced to Argos base subtag
    expect(captured?.body.target).toBe('vi');
    expect(captured?.body.format).toBe('text');
    expect(res.segments).toEqual([
      { id: 'seg_0001', translatedText: 'Xin chào' },
      { id: 'seg_0002', translatedText: 'Tạm biệt' },
    ]);
  });

  it('accepts a single-string translatedText response', async () => {
    setWorkerTransport(async () => rawJson({ translatedText: 'Xin chào' }));
    const provider = new LibreTranslateProvider(fakeEngines('http://127.0.0.1:5099'), fakeStore(true), 5000);
    const res = await provider.translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: [{ id: 'seg_0001', sourceText: 'Hello' }],
    });
    expect(res.segments).toEqual([{ id: 'seg_0001', translatedText: 'Xin chào' }]);
  });

  it('maps a 400 "pair not available" into TRANSLATION_PACKAGE_MISSING with remediation', async () => {
    // LibreTranslate returns 400 with a PLAIN-STRING error body for an
    // unavailable pair; workerHttp can't decode it, so the provider must remap.
    setWorkerTransport(async () =>
      rawJson({ error: 'vi (vi) is not available as a target language from zh (zh)' }, 400),
    );
    const provider = new LibreTranslateProvider(fakeEngines('http://127.0.0.1:5099'), fakeStore(true), 5000);
    await expect(
      provider.translateSegments({
        sourceLanguage: 'zh',
        targetLanguage: 'vi',
        segments: [{ id: 'seg_0001', sourceText: '你好' }],
      }),
    ).rejects.toMatchObject({
      appError: expect.objectContaining({
        code: 'TRANSLATION_PACKAGE_MISSING',
        remediation: expect.stringContaining('Translation packs'),
      }),
    });
  });

  it('only remaps HTTP 400 — a 500 passes through unchanged (not a package error)', async () => {
    setWorkerTransport(async () => rawJson({ error: 'internal' }, 500));
    const provider = new LibreTranslateProvider(fakeEngines('http://127.0.0.1:5099'), fakeStore(true), 5000);
    let caught: AppErrorException | undefined;
    try {
      await provider.translateSegments({
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        segments: [{ id: 'seg_0001', sourceText: 'Hello' }],
      });
    } catch (e) {
      caught = e as AppErrorException;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    expect(caught?.appError.code).not.toBe('TRANSLATION_PACKAGE_MISSING');
  });

  it('returns empty without starting the server when there are no segments', async () => {
    let called = false;
    setWorkerTransport(async () => {
      called = true;
      return rawJson({});
    });
    const provider = new LibreTranslateProvider(fakeEngines('http://x'), fakeStore(true), 5000);
    const res = await provider.translateSegments({ sourceLanguage: 'en', targetLanguage: 'vi', segments: [] });
    expect(res.segments).toEqual([]);
    expect(called).toBe(false);
  });
});
