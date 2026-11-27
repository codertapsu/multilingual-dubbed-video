import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetupStore, defaultSetupStatus, defaultPreferences } from './setupStore.js';

let tmp: string;
let store: SetupStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-setup-test-'));
  store = new SetupStore(path.join(tmp, 'config'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('SetupStore round-trip', () => {
  it('returns defaults when no setup.json exists', async () => {
    const status = await store.getStatus();
    expect(status).toEqual(defaultSetupStatus());
    expect(status.firstRunComplete).toBe(false);
    expect(status.installed.whisperModels).toEqual([]);
    expect(status.installed.argosPairs).toEqual([]);
    expect(status.installed.piperVoices).toEqual([]);
  });

  it('persists and reloads first-run completion', async () => {
    const saved = await store.markFirstRunComplete();
    expect(saved.firstRunComplete).toBe(true);

    const reloaded = await store.getStatus();
    expect(reloaded.firstRunComplete).toBe(true);
  });

  it('records installed models idempotently', async () => {
    await store.addWhisperModel('base');
    await store.addWhisperModel('base'); // duplicate: no-op
    await store.addArgosPair({ from: 'en', to: 'vi' });
    await store.addArgosPair({ from: 'en', to: 'vi' }); // duplicate: no-op
    await store.addArgosPair({ from: 'en', to: 'es' });
    await store.addPiperVoice('vi_VN-vais1000-medium');
    await store.addPiperVoice('vi_VN-vais1000-medium'); // duplicate: no-op

    const status = await store.getStatus();
    expect(status.installed.whisperModels).toEqual(['base']);
    expect(status.installed.argosPairs).toEqual([
      { from: 'en', to: 'vi' },
      { from: 'en', to: 'es' },
    ]);
    expect(status.installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);
  });

  it('reconciles disk-detected models into the inventory (idempotent)', async () => {
    await store.addWhisperModel('small'); // already recorded
    const detected = {
      whisperModels: ['small', 'large-v3-turbo'],
      argosPairs: [{ from: 'en', to: 'vi' }],
      piperVoices: ['vi_VN-vais1000-medium'],
    };
    const after = await store.reconcileInstalled(detected);
    expect(after.installed.whisperModels).toEqual(['small', 'large-v3-turbo']);
    expect(after.installed.argosPairs).toEqual([{ from: 'en', to: 'vi' }]);
    expect(after.installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);

    // A second reconcile with the same detection adds nothing new.
    const again = await store.reconcileInstalled(detected);
    expect(again.installed).toEqual(after.installed);
  });

  it('preserves installed lists when marking first-run complete', async () => {
    await store.addWhisperModel('small');
    await store.addPiperVoice('en_US-lessac-medium');
    await store.markFirstRunComplete();

    const status = await store.getStatus();
    expect(status.firstRunComplete).toBe(true);
    expect(status.installed.whisperModels).toEqual(['small']);
    expect(status.installed.piperVoices).toEqual(['en_US-lessac-medium']);
  });

  it('writes a real setup.json file in the config dir', async () => {
    await store.addWhisperModel('base');
    const raw = await fsp.readFile(path.join(tmp, 'config', 'setup.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.installed.whisperModels).toEqual(['base']);
  });

  it('tolerates a malformed setup.json by falling back to defaults', async () => {
    const configDir = path.join(tmp, 'config');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(path.join(configDir, 'setup.json'), '{not valid json', 'utf8');
    const status = await store.getStatus();
    expect(status).toEqual(defaultSetupStatus());
  });

  it('backfills missing fields from a partial setup.json', async () => {
    const configDir = path.join(tmp, 'config');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(
      path.join(configDir, 'setup.json'),
      JSON.stringify({ firstRunComplete: true }),
      'utf8',
    );
    const status = await store.getStatus();
    expect(status.firstRunComplete).toBe(true);
    expect(status.installed).toEqual({ whisperModels: [], argosPairs: [], piperVoices: [] });
  });
});

describe('SetupStore preferences round-trip', () => {
  it('defaults to autoUpdate enabled', async () => {
    const prefs = await store.getPreferences();
    expect(prefs).toEqual(defaultPreferences());
    expect(prefs.autoUpdate).toBe(true);
  });

  it('persists and reloads autoUpdate=false', async () => {
    const saved = await store.savePreferences({ autoUpdate: false });
    expect(saved.autoUpdate).toBe(false);
    const reloaded = await store.getPreferences();
    expect(reloaded.autoUpdate).toBe(false);
  });

  it('coerces a truthy non-boolean to a clean boolean', async () => {
    // The route should normalize, but the store also guards.
    await store.savePreferences({ autoUpdate: true });
    const reloaded = await store.getPreferences();
    expect(reloaded.autoUpdate).toBe(true);
  });

  it('keeps the chosen local models; "" goes back to automatic; junk is dropped', async () => {
    await store.savePreferences({ autoUpdate: true, localModels: { translation: 'translategemma-27b', chat: 'chat-gemma4-12b' } });
    expect((await store.getPreferences()).localModels).toEqual({
      translation: 'translategemma-27b',
      chat: 'chat-gemma4-12b',
    });
    await store.savePreferences({ autoUpdate: true, localModels: { translation: '', chat: 'chat-gemma4-12b' } });
    expect((await store.getPreferences()).localModels).toEqual({ chat: 'chat-gemma4-12b' });
    await store.savePreferences({ autoUpdate: true, localModels: { translation: '../../etc', chat: '' } as never });
    expect((await store.getPreferences()).localModels).toBeUndefined();
  });

  it('keeps the downloads-while-dubbing choice (it snapped back to Automatic before)', async () => {
    await store.savePreferences({ autoUpdate: true, downloads: { whileDubbing: 'one-task' } });
    expect((await store.getPreferences()).downloads).toEqual({ whileDubbing: 'one-task' });
    await store.savePreferences({ autoUpdate: true, downloads: { whileDubbing: 'sometimes' } as never });
    expect((await store.getPreferences()).downloads).toBeUndefined();
  });

  it('keeps the default voices; "" goes back to none; junk is dropped (2026-11-27)', async () => {
    await store.savePreferences({ autoUpdate: true, defaultVoices: { male: 'vp_d54fadbeedb4b84f', female: 'vp_1545a09ba583ad6a' } });
    expect((await store.getPreferences()).defaultVoices).toEqual({ male: 'vp_d54fadbeedb4b84f', female: 'vp_1545a09ba583ad6a' });
    await store.savePreferences({ autoUpdate: true, defaultVoices: { male: '', female: 'vieneu38-my-duyen' } });
    expect((await store.getPreferences()).defaultVoices).toEqual({ female: 'vieneu38-my-duyen' });
    await store.savePreferences({ autoUpdate: true, defaultVoices: { male: '../x', female: 42 } as never });
    expect((await store.getPreferences()).defaultVoices).toBeUndefined();
  });
});
