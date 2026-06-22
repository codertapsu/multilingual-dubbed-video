import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnginePackStore } from './engines/enginePackStore.js';
import { SetupStore } from './setup/setupStore.js';
import { clearStorage, describeStorage, dirSize } from './storage.js';

/** Write a file of `bytes` length at `p` (creating parents). */
async function writeBytes(p: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.alloc(bytes, 1));
}

describe('storage', () => {
  let dir: string; // acts as configDir
  let modelsDir: string;
  let enginesDir: string;
  let cacheDir: string;
  let store: EnginePackStore;
  let setup: SetupStore;

  const config = (): { configDir: string; modelsDir: string } => ({ configDir: dir, modelsDir });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-storage-'));
    modelsDir = path.join(dir, 'models');
    enginesDir = path.join(dir, 'engines');
    cacheDir = path.join(dir, 'cache');
    store = new EnginePackStore(dir); // enginesDir === <dir>/engines
    setup = new SetupStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dirSize sums file bytes recursively, and is 0 for a missing dir', async () => {
    expect(await dirSize(path.join(dir, 'nope'))).toBe(0);
    await writeBytes(path.join(enginesDir, 'a.bin'), 1000);
    await writeBytes(path.join(enginesDir, 'sub', 'b.bin'), 500);
    expect(await dirSize(enginesDir)).toBe(1500);
  });

  it('describeStorage reports per-category sizes, total, and installed-pack count', async () => {
    await writeBytes(path.join(enginesDir, 'llama-cpp-metal', 'llama-server'), 2000);
    await store.add({ id: 'llama-cpp-metal', path: store.packDir('llama-cpp-metal'), installedAt: '2026-01-01T00:00:00Z' });
    await writeBytes(path.join(modelsDir, 'huggingface', 'model.bin'), 3000);
    await writeBytes(path.join(cacheDir, 'tmp.dat'), 100);

    const info = await describeStorage(config(), store);
    const byKey = Object.fromEntries(info.locations.map((l) => [l.key, l.bytes]));
    expect(byKey.engines).toBe(2000);
    expect(byKey.models).toBe(3000);
    expect(byKey.cache).toBe(100);
    expect(info.totalBytes).toBe(5100);
    expect(info.root).toBe(dir);
    expect(info.installedEnginePacks).toBe(1);
    // freeBytes is null or a positive number depending on the platform's statfs.
    expect(info.freeBytes === null || info.freeBytes > 0).toBe(true);
  });

  it('clearStorage wipes all categories, resets the stores, and stops engines', async () => {
    // Seed disk + store state.
    await writeBytes(path.join(enginesDir, 'p', 'bin'), 2000);
    await store.add({ id: 'p', path: store.packDir('p'), installedAt: '2026-01-01T00:00:00Z' });
    await writeBytes(path.join(modelsDir, 'piper', 'voice.onnx'), 1000);
    await writeBytes(path.join(cacheDir, 't'), 10);
    await setup.addWhisperModel('small');
    await setup.addPiperVoice('vi_VN-vais1000-medium');
    await setup.addArgosPair({ from: 'en', to: 'vi' });

    let stopped = 0;
    const result = await clearStorage(
      {},
      { config: config(), enginePackStore: store, setupStore: setup, engineManager: { stopAll: async () => { stopped++; } } },
    );

    expect(stopped).toBe(1);
    expect(result.freedBytes).toBe(3010);
    expect(result.cleared.sort()).toEqual(['cache', 'engines', 'models']);
    // Pack records gone; dirs recreated empty.
    expect(await store.list()).toEqual([]);
    expect(await readdir(enginesDir)).toEqual([]);
    expect(await readdir(modelsDir)).toEqual([]);
    expect((await stat(cacheDir)).isDirectory()).toBe(true);
    // Whisper + Piper inventory cleared; Argos pair preserved.
    const status = await setup.getStatus();
    expect(status.installed.whisperModels).toEqual([]);
    expect(status.installed.piperVoices).toEqual([]);
    expect(status.installed.argosPairs).toEqual([{ from: 'en', to: 'vi' }]);
  });

  it('clearStorage honors per-category flags (engines only)', async () => {
    await writeBytes(path.join(enginesDir, 'p', 'bin'), 500);
    await writeBytes(path.join(modelsDir, 'm'), 700);
    const result = await clearStorage(
      { engines: true, models: false, cache: false },
      { config: config(), enginePackStore: store, setupStore: setup },
    );
    expect(result.cleared).toEqual(['engines']);
    expect(result.freedBytes).toBe(500);
    expect(await dirSize(modelsDir)).toBe(700); // models untouched
  });
});
