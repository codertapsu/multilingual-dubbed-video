import { describe, expect, it } from 'vitest';
import { OllamaPullManager, listOllamaModels, parseOllamaModelList } from './ollamaModels.js';

/** A Response-like that streams the given NDJSON lines as its body. */
function streamResponse(lines: string[], ok = true, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(`${l}\n`));
      controller.close();
    },
  });
  return { ok, status, body } as unknown as Response;
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response;
}

describe('parseOllamaModelList', () => {
  it('extracts model ids from the /v1/models body', () => {
    expect(parseOllamaModelList({ data: [{ id: 'qwen2.5:7b' }, { id: 'gemma2:9b' }, {}] })).toEqual([
      'qwen2.5:7b',
      'gemma2:9b',
    ]);
    expect(parseOllamaModelList({})).toEqual([]);
    expect(parseOllamaModelList(undefined)).toEqual([]);
  });
});

describe('listOllamaModels', () => {
  it('returns the pulled model ids', async () => {
    const fetchImpl = (async () => jsonResponse({ data: [{ id: 'qwen2.5:7b' }] })) as unknown as typeof fetch;
    expect(await listOllamaModels('http://x/v1', fetchImpl)).toEqual(['qwen2.5:7b']);
  });

  it('returns [] when the daemon is down', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await listOllamaModels('http://x/v1', fetchImpl)).toEqual([]);
  });
});

describe('OllamaPullManager', () => {
  it('tracks progress to done across the NDJSON pull stream', async () => {
    const fetchImpl = (async () =>
      streamResponse([
        '{"status":"pulling manifest"}',
        '{"status":"downloading","completed":50,"total":100}',
        '{"status":"downloading","completed":100,"total":100}',
        '{"status":"success"}',
      ])) as unknown as typeof fetch;
    const mgr = new OllamaPullManager('http://127.0.0.1:11434/v1', fetchImpl);

    mgr.start('qwen2.5:7b');
    const final = await mgr.wait('qwen2.5:7b');
    expect(final.status).toBe('done');
    expect(final.percent).toBe(100);
  });

  it('surfaces an error line from the stream', async () => {
    const fetchImpl = (async () =>
      streamResponse(['{"status":"pulling"}', '{"error":"model not found"}'])) as unknown as typeof fetch;
    const mgr = new OllamaPullManager('http://127.0.0.1:11434/v1', fetchImpl);

    mgr.start('does-not-exist');
    const final = await mgr.wait('does-not-exist');
    expect(final.status).toBe('error');
    expect(final.error).toBe('model not found');
  });

  it('reports an error on a non-ok pull response', async () => {
    const fetchImpl = (async () => streamResponse([], false, 500)) as unknown as typeof fetch;
    const mgr = new OllamaPullManager('http://127.0.0.1:11434/v1', fetchImpl);
    mgr.start('m');
    const final = await mgr.wait('m');
    expect(final.status).toBe('error');
  });

  it('is idempotent while a pull is in flight', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return streamResponse(['{"status":"success"}']);
    }) as unknown as typeof fetch;
    const mgr = new OllamaPullManager('http://x/v1', fetchImpl);
    mgr.start('m');
    mgr.start('m'); // second call while pulling -> no extra fetch
    await mgr.wait('m');
    expect(calls).toBe(1);
  });
});
