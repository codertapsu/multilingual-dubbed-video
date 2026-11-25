import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { setWorkerTransport } from '../workerHttp.js';
import { cleanReads, OCR_SLICE, RapidOcrProvider, sliceTimeoutMs } from './rapidOcrProvider.js';

afterEach(() => setWorkerTransport(null));

const engines = (): Pick<EngineManager, 'ensureRunning'> & { ensureRunning: ReturnType<typeof vi.fn> } =>
  ({ ensureRunning: vi.fn(async () => 'http://reader/') }) as never;
const store = (installed: boolean) => ({ isInstalled: async (id: string) => installed && id === 'ocr-rapid' }) as unknown as EnginePackStore;

describe('the subtitle reader (ocr-rapid)', () => {
  it('reads the frames file in slices, starting the engine for each, with progress', async () => {
    const asked: { offset: number; count: number }[] = [];
    setWorkerTransport(async (_method, url, payload) => {
      const body = JSON.parse(payload ?? '{}') as { offset: number; count: number; framesPath: string };
      expect(url).toBe('http://reader/read');
      expect(body.framesPath).toBe('C:\\p\\audio\\subtitle_frames.u8');
      asked.push({ offset: body.offset, count: body.count });
      const results = Array.from({ length: body.count }, (_, k) => ({ index: body.offset + k, text: ` 第${body.offset + k}句 `, confidence: 0.9, lines: 1 }));
      return { status: 200, ok: true, text: JSON.stringify({ results, processMs: 1 }) };
    });
    const e = engines();
    const progress: string[] = [];
    const reader = new RapidOcrProvider(e, store(true));
    const out = await reader.read({ path: 'C:\\p\\audio\\subtitle_frames.u8', width: 1536, height: 58, count: OCR_SLICE + 5 }, {
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    expect(asked).toEqual([
      { offset: 0, count: OCR_SLICE },
      { offset: OCR_SLICE, count: 5 },
    ]);
    expect(e.ensureRunning).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(OCR_SLICE + 5);
    expect(out![OCR_SLICE + 4]).toEqual({ index: OCR_SLICE + 4, text: `第${OCR_SLICE + 4}句`, confidence: 0.9, lines: 1 });
    expect(progress).toEqual([`0/${OCR_SLICE + 5}`, `${OCR_SLICE}/${OCR_SLICE + 5}`, `${OCR_SLICE + 5}/${OCR_SLICE + 5}`]);
  });

  it('is nothing to read with when the pack is not installed', async () => {
    const reader = new RapidOcrProvider(engines(), store(false));
    expect(await reader.available()).toBe(false);
    expect(await reader.read({ path: 'x', width: 10, height: 10, count: 3 })).toBeNull();
  });

  it('keeps each frame in its place: what the engine skipped or garbled reads as nothing', () => {
    expect(
      cleanReads(
        [
          { index: 11, text: '快跑', confidence: 1.7, lines: 1 },
          { index: 99, text: 'outside the slice' },
          { index: 'x', text: 'no index' },
        ],
        10,
        3,
      ),
    ).toEqual([
      { index: 10, text: '', confidence: 0, lines: 0 },
      { index: 11, text: '快跑', confidence: 1, lines: 1 },
      { index: 12, text: '', confidence: 0, lines: 0 },
    ]);
  });

  it('gives a slice time for the model to load and the machine to be slow', () => {
    expect(sliceTimeoutMs(5)).toBe(120_000);
    expect(sliceTimeoutMs(300)).toBe(600_000);
  });
});
