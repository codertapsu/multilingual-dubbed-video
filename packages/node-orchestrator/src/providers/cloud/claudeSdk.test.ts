/**
 * The real SDK path, on the wire, against a local stand-in for the Messages
 * API: what the request looks like (beta header, body, streaming) and that a
 * streamed reply comes back as text. No network, no API key, no cost.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeMessage, sdkSend } from './claudeMessages.js';

let server: http.Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  server = undefined;
});

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

async function standIn(status: number, body: string, contentType: string) {
  const seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: Record<string, unknown> } = {};
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = JSON.parse(raw) as Record<string, unknown>;
      // No keep-alive: a pooled socket left open made a run under heavy load
      // wait seconds for the SDK's retry instead of a fresh connection.
      res.writeHead(status, { 'content-type': contentType, connection: 'close' });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { seen, baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1` };
}

const streamed = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"segments":[{"id":"seg_0001",' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"text":"Xin chào"}]}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
]);

describe('the Anthropic SDK on the wire', { timeout: 30_000 }, () => {
  it('streams a beta request with server-side fallbacks and collects the text', async () => {
    const { seen, baseUrl } = await standIn(200, streamed, 'text/event-stream');
    const message = await sdkSend(
      {
        model: 'claude-opus-5-5',
        max_tokens: 1000,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { apiKey: 'sk-ant-test', baseUrl, timeoutMs: 10_000, beta: true },
    );
    expect(message.stop_reason).toBe('end_turn');
    expect(message.content.map((b) => b.text).join('')).toBe('{"segments":[{"id":"seg_0001","text":"Xin chào"}]}');
    expect(seen.url).toMatch(/^\/v1\/messages/);
    expect(seen.headers?.['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(seen.headers?.['anthropic-version']).toBeTruthy();
    expect(seen.headers?.authorization ?? seen.headers?.['x-api-key']).toContain('sk-ant-test');
    expect(seen.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', max_tokens: 1000 });
    expect(seen.body).not.toHaveProperty('betas'); // sent as the header, not in the body
  });

  it('a plain request through a custom endpoint, end to end', async () => {
    const { seen, baseUrl } = await standIn(200, streamed, 'text/event-stream');
    const reply = await claudeMessage({
      apiKey: 'sk-ant-test',
      baseUrl,
      model: 'claude-sonnet-5-5',
      system: 'sys',
      user: 'hi',
      timeoutMs: 10_000,
    });
    expect(reply.text).toBe('{"segments":[{"id":"seg_0001","text":"Xin chào"}]}');
    expect(seen.headers?.['anthropic-beta']).toBeUndefined();
    expect(seen.body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true });
  });

  it('maps a rejected key to the app error, without echoing the key', async () => {
    const { baseUrl } = await standIn(
      401,
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      'application/json',
    );
    const err = await claudeMessage({
      apiKey: 'sk-ant-secret-123',
      baseUrl,
      model: 'claude-opus-5-5',
      system: 's',
      user: 'u',
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CLOUD_REQUEST_FAILED', message: expect.stringContaining('rejected the API key') });
    expect(JSON.stringify(err)).not.toContain('sk-ant-secret-123');
  });
});
