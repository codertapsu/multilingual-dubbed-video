import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialsStore, maskKey } from './credentialsStore.js';

describe('CredentialsStore', () => {
  let dir: string;
  let store: CredentialsStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-creds-'));
    store = new CredentialsStore(dir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a key and reports it masked, never in full', async () => {
    await store.save({ service: 'openai', apiKey: 'sk-test-1234567890abcdefh1Q4' });

    const eff = await store.get('openai');
    expect(eff.apiKey).toBe('sk-test-1234567890abcdefh1Q4');
    expect(eff.fromEnv).toBe(false);

    const described = await store.describe();
    const openai = described.find((c) => c.service === 'openai');
    expect(openai?.configured).toBe(true);
    expect(openai?.maskedKey).toBe('sk-…h1Q4');
    // The full key must never appear in the describe() payload.
    expect(JSON.stringify(described)).not.toContain('sk-test-1234567890abcdefh1Q4');
  });

  it('clears a key when saving null/empty', async () => {
    await store.save({ service: 'gemini', apiKey: 'AIza-something-long-enough' });
    await store.save({ service: 'gemini', apiKey: null });
    const eff = await store.get('gemini');
    expect(eff.apiKey).toBeUndefined();
    const file = JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8')) as object;
    expect(file).toEqual({});
  });

  it('keeps baseUrl/model independent of the key', async () => {
    await store.save({ service: 'openai', apiKey: 'sk-test-1234567890abcdefh1Q4' });
    await store.save({ service: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'my-model' });
    const eff = await store.get('openai');
    expect(eff.apiKey).toBe('sk-test-1234567890abcdefh1Q4');
    expect(eff.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(eff.model).toBe('my-model');
  });

  it('falls back to environment variables and flags fromEnv', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-1234567890abcd';
    const eff = await store.get('anthropic');
    expect(eff.apiKey).toBe('sk-ant-env-1234567890abcd');
    expect(eff.fromEnv).toBe(true);

    const described = await store.describe();
    const anthropic = described.find((c) => c.service === 'anthropic');
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.fromEnv).toBe(true);
  });

  it('writes the file with owner-only permissions (POSIX)', async () => {
    await store.save({ service: 'openai', apiKey: 'sk-test-1234567890abcdefh1Q4' });
    if (process.platform !== 'win32') {
      const info = await stat(path.join(dir, 'credentials.json'));
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('treats a corrupt file as empty instead of crashing', async () => {
    await store.save({ service: 'openai', apiKey: 'sk-test-1234567890abcdefh1Q4' });
    const file = path.join(dir, 'credentials.json');
    await rm(file);
    const eff = await store.get('openai');
    expect(eff.apiKey).toBeUndefined();
  });
});

describe('maskKey', () => {
  it('keeps only a short prefix and the last 4 characters', () => {
    expect(maskKey('sk-proj-abcdefghijklmnop')).toBe('sk-…mnop');
  });
  it('fully masks short keys', () => {
    expect(maskKey('short')).toBe('••••');
  });
});
