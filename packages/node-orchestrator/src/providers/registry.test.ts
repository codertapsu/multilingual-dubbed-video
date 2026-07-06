import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDefaultRegistry } from './registry.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vd-registry-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const allProviders = (reg: ReturnType<typeof createDefaultRegistry>) => {
  const d = reg.describe();
  return [...d.stt, ...d.translation, ...d.tts];
};

describe('createDefaultRegistry', () => {
  it('registers the local defaults (no server we run) AND the opt-in third-party cloud providers', () => {
    const reg = createDefaultRegistry(loadConfig({ configDir: tmp }));
    const all = allProviders(reg);
    const ids = all.map((p) => p.id);

    // Local, on-device defaults (Ollama is a local daemon the user runs).
    expect(ids).toEqual(expect.arrayContaining(['faster-whisper', 'argos', 'piper-local', 'ollama']));
    expect(all.find((p) => p.id === 'faster-whisper')?.isLocal).toBe(true);

    // Third-party cloud services the user opts into + pays for are offered too,
    // and are correctly flagged non-local (key-gated, never a default).
    for (const cloud of ['openai-stt', 'openai-translate', 'anthropic-translate', 'gemini-translate', 'openai-tts']) {
      expect(ids).toContain(cloud);
      expect(all.find((p) => p.id === cloud)?.isLocal).toBe(false);
    }
  });
});
