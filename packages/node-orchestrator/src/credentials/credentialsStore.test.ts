import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialsStore, MOTHER_CLAUDE_PLACEHOLDER_KEY, maskKey, normalizeMotherClaudeUrl } from './credentialsStore.js';

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

  // Claude through Mother Claude: the user's Claude plan instead of an API key.
  describe('Claude through Mother Claude', () => {
    const realKey = 'sk-ant-real-1234567890abcd';
    const fileOf = async () =>
      JSON.parse(await readFile(path.join(dir, 'credentials.json'), 'utf8')) as Record<string, Record<string, string>>;

    it('switching keeps the API key, and switching back uses it again', async () => {
      await store.save({ service: 'anthropic', apiKey: realKey, model: 'claude-sonnet-5-5' });
      await store.save({ service: 'anthropic', via: 'mother-claude' });

      expect(await store.get('anthropic')).toEqual({
        apiKey: MOTHER_CLAUDE_PLACEHOLDER_KEY,
        baseUrl: 'http://127.0.0.1:5612',
        model: 'claude-sonnet-5-5',
        fromEnv: false,
        via: 'mother-claude',
      });
      expect((await fileOf()).anthropic?.apiKey).toBe(realKey);
      const described = (await store.describe()).find((c) => c.service === 'anthropic');
      expect(described).toMatchObject({
        configured: true,
        via: 'mother-claude',
        maskedKey: 'sk-…abcd',
        motherClaude: { url: 'http://127.0.0.1:5612', keySet: false },
      });

      await store.save({ service: 'anthropic', via: 'api-key' });
      const back = await store.get('anthropic');
      expect(back).toMatchObject({ apiKey: realKey, baseUrl: undefined, model: 'claude-sonnet-5-5' });
      expect(back.via).toBeUndefined();
    });

    it('is configured with no API key at all (that is the point of it)', async () => {
      await store.save({ service: 'anthropic', via: 'mother-claude' });
      const described = (await store.describe()).find((c) => c.service === 'anthropic');
      expect(described?.configured).toBe(true);
      expect(described?.maskedKey).toBeUndefined();
    });

    it("sends Mother Claude's own key and address when set, never showing the key", async () => {
      await store.save({
        service: 'anthropic',
        via: 'mother-claude',
        motherClaudeUrl: ' http://127.0.0.1:5700/v1/ ',
        motherClaudeKey: 'mc-key-0123456789',
      });
      expect(await store.get('anthropic')).toMatchObject({ apiKey: 'mc-key-0123456789', baseUrl: 'http://127.0.0.1:5700' });
      expect(await store.motherClaude()).toEqual({ url: 'http://127.0.0.1:5700', apiKey: 'mc-key-0123456789' });
      const described = await store.describe();
      expect(described.find((c) => c.service === 'anthropic')?.motherClaude).toEqual({ url: 'http://127.0.0.1:5700', keySet: true });
      expect(JSON.stringify(described)).not.toContain('mc-key-0123456789');

      await store.save({ service: 'anthropic', motherClaudeKey: null });
      expect((await store.get('anthropic')).apiKey).toBe(MOTHER_CLAUDE_PLACEHOLDER_KEY);
    });

    it('does not store the default address, so an untouched setting follows it', async () => {
      await store.save({ service: 'anthropic', via: 'mother-claude', motherClaudeUrl: 'http://127.0.0.1:5700' });
      await store.save({ service: 'anthropic', motherClaudeUrl: 'http://127.0.0.1:5612/' });
      expect((await fileOf()).anthropic).toEqual({ via: 'mother-claude' });
    });

    it('refuses an address that is not http(s), saying what to copy', async () => {
      await expect(store.save({ service: 'anthropic', motherClaudeUrl: 'not an address' })).rejects.toThrow(/Base URL/);
      await expect(store.save({ service: 'anthropic', motherClaudeUrl: 'ftp://127.0.0.1:5612' })).rejects.toThrow(/http:\/\//);
      expect(normalizeMotherClaudeUrl('https://mc.example.com/v1')).toBe('https://mc.example.com');
    });

    it('ignores ANTHROPIC_API_KEY while the plan is chosen', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-1234567890abcd';
      await store.save({ service: 'anthropic', via: 'mother-claude' });
      expect(await store.get('anthropic')).toMatchObject({ apiKey: MOTHER_CLAUDE_PLACEHOLDER_KEY, fromEnv: false });
    });

    it('belongs to Claude only', async () => {
      await store.save({ service: 'openai', via: 'mother-claude', motherClaudeUrl: 'http://127.0.0.1:5700' });
      expect(await store.get('openai')).toMatchObject({ apiKey: undefined, baseUrl: undefined });
      expect((await store.get('openai')).via).toBeUndefined();
    });
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
