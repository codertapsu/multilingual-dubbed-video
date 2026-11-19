import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import type { ClaudeSend } from '../providers/cloud/claudeMessages.js';
import { CredentialsStore } from './credentialsStore.js';
import { probeMotherClaude, testCloudCredential } from './testConnection.js';

/**
 * Settings' Test button for Claude through Mother Claude. It must send a real
 * message: Mother Claude 0.16.1 listed models while every message failed, so a
 * model listing would have passed a connection that could not translate.
 */
describe('testCloudCredential — Claude through Mother Claude', () => {
  let dir: string;
  let store: CredentialsStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-creds-test-'));
    store = new CredentialsStore(dir);
    await store.save({ service: 'anthropic', via: 'mother-claude', model: 'claude-sonnet-5-5' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const up: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });

  it('sends one tiny real message, the way translation does', async () => {
    const probed: string[] = [];
    const sent: { params: Record<string, unknown>; ctx: Parameters<ClaudeSend>[1] }[] = [];
    const result = await testCloudCredential(store, 'anthropic', {
      fetchImpl: async (url) => {
        probed.push(String(url));
        return new Response('{"data":[]}', { status: 200 });
      },
      claudeSend: async (params, ctx) => {
        sent.push({ params, ctx });
        return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    });

    expect(result).toMatchObject({ service: 'anthropic', ok: true });
    expect(result.detail).toContain('Mother Claude');
    expect(probed).toEqual(['http://127.0.0.1:5612/v1/models']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ctx).toMatchObject({ apiKey: 'mother-claude', baseUrl: 'http://127.0.0.1:5612', via: 'mother-claude', beta: false });
    expect(sent[0]!.params).toMatchObject({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'ok?' }] });
  });

  it('a closed Mother Claude fails fast with the steps to start it, sending nothing', async () => {
    const result = await testCloudCredential(store, 'anthropic', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      claudeSend: async () => {
        throw new Error('must not send while Mother Claude is down');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not running at http://127.0.0.1:5612');
    expect(result.detail).toContain('Start the API');
  });

  it("names a key on Mother Claude's HTTP API as the problem", async () => {
    const result = await testCloudCredential(store, 'anthropic', {
      fetchImpl: async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 }),
      claudeSend: async () => {
        throw new Error('must not send with a rejected key');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('has a key');
  });

  it('a message that fails comes back with its reason and its fix', async () => {
    const result = await testCloudCredential(store, 'anthropic', {
      fetchImpl: up,
      claudeSend: async () => {
        throw new AppErrorException('CLOUD_REQUEST_FAILED', 'Claude request failed (HTTP 503).', {
          remediation: 'Retry the step.',
        });
      },
    });
    expect(result).toEqual({ service: 'anthropic', ok: false, detail: 'Claude request failed (HTTP 503). Retry the step.' });
  });

  it('the API-key path is untouched after switching back', async () => {
    await store.save({ service: 'anthropic', via: 'api-key' });
    delete process.env.ANTHROPIC_API_KEY;
    const result = await testCloudCredential(store, 'anthropic', {
      fetchImpl: up,
      claudeSend: async () => {
        throw new Error('the key test lists models; it sends no message');
      },
    });
    expect(result).toMatchObject({ ok: false, detail: 'No API key configured for Anthropic (Claude).' });
  });
});

describe('probeMotherClaude', () => {
  it('asks its model list with the key, so no tokens are spent', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const status = await probeMotherClaude('http://127.0.0.1:5700/', 'mc-key', async (url, init) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') });
      return new Response('{}', { status: 404 });
    });
    // Any HTTP answer means something listens there; only 401/403 is about the key.
    expect(status).toEqual({ url: 'http://127.0.0.1:5700/', reachable: true });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:5700/v1/models', key: 'mc-key' }]);
  });

  it('reports a refused connection as not running', async () => {
    const status = await probeMotherClaude('http://127.0.0.1:5612', 'mother-claude', async () => {
      throw new TypeError('fetch failed');
    });
    expect(status).toEqual({ url: 'http://127.0.0.1:5612', reachable: false });
  });
});
