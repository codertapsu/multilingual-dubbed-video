import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineInstallEvent } from '@videodubber/shared';
import { EngineEventBus } from './engineBus.js';
import { EngineInstaller } from './engineInstaller.js';
import { EnginePackStore } from './enginePackStore.js';

/**
 * Engine-pack install is the most failure-prone user-facing operation in the app
 * (network, checksum, archive, uv resolution, per-OS paths), it runs on the
 * user's machine and not the maintainer's, and it had no test at all — despite
 * declaring `fetchImpl`/`now` as injection seams. These cover the parts whose
 * failure is silent or expensive: checksum rejection, and not destroying a
 * working multi-GB pack when an update fails.
 *
 * `translategemma-4b` is used because it is a single, non-archive artifact with
 * a pinned sha256, so no extraction tooling is involved.
 */
const PACK_ID = 'translategemma-4b';

let tmp: string;
let store: EnginePackStore;
let bus: EngineEventBus;
let events: EngineInstallEvent[];

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-engine-installer-test-'));
  store = new EnginePackStore(path.join(tmp, 'config'));
  bus = new EngineEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A fetch that streams `bytes` with a content-length. */
function fileFetch(bytes: Uint8Array): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })) as unknown as typeof fetch;
}

function errorOf(list: EngineInstallEvent[]): Extract<EngineInstallEvent, { type: 'error' }> | undefined {
  return list.find((e): e is Extract<EngineInstallEvent, { type: 'error' }> => e.type === 'error');
}

describe('EngineInstaller', () => {
  it('rejects a checksum mismatch and records nothing', async () => {
    const installer = new EngineInstaller({ store, bus, fetchImpl: fileFetch(new Uint8Array(64).fill(1)) });

    await installer.install(PACK_ID);

    const error = errorOf(events);
    expect(error?.error.code).toBe('ENGINE_PACK_FAILED');
    expect(error?.error.message).toContain('Checksum mismatch');
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(await store.isInstalled(PACK_ID)).toBe(false);
    // Neither the pack dir nor the temp download survives a rejected install.
    await expect(fsp.stat(store.packDir(PACK_ID))).rejects.toThrow();
  });

  it('keeps the previously installed pack when an update fails', async () => {
    // Regression: install `rm -rf`d the pack dir before the first byte was
    // fetched, so a dropped connection while "updating" a working 2-4 GB pack
    // left the user with nothing and an hour of re-downloading.
    const packDir = store.packDir(PACK_ID);
    await fsp.mkdir(packDir, { recursive: true });
    await fsp.writeFile(path.join(packDir, 'model.gguf'), 'WORKING COPY', 'utf8');
    await store.add({ id: PACK_ID, path: packDir, version: 'Q4_K_M', installedAt: '2026-01-01T00:00:00.000Z' });

    const installer = new EngineInstaller({
      store,
      bus,
      fetchImpl: (async () => {
        throw new Error('network dropped');
      }) as unknown as typeof fetch,
    });

    await installer.install(PACK_ID);

    expect(await fsp.readFile(path.join(packDir, 'model.gguf'), 'utf8')).toBe('WORKING COPY');
    expect(await store.isInstalled(PACK_ID)).toBe(true);
    expect(errorOf(events)?.error.message).toContain('still in place');
    // No stale scratch directory left behind.
    await expect(fsp.stat(`${packDir}.old`)).rejects.toThrow();
  });

  it('survives a pack dir that cannot be moved aside (Windows file lock)', async () => {
    // Regression: the move-aside ran BEFORE the try/catch, so an EPERM/EBUSY
    // rename (Windows, whenever a llama.cpp or venv python still has a file in
    // the pack open) rejected install() with no `error` event for the UI and
    // skipped the `finally` — the pack id stayed in `running` forever and every
    // later attempt answered "already in progress" until the app restarted.
    const packDir = store.packDir(PACK_ID);
    await fsp.mkdir(packDir, { recursive: true });
    await fsp.writeFile(path.join(packDir, 'model.gguf'), 'WORKING COPY', 'utf8');
    await store.add({ id: PACK_ID, path: packDir, version: 'Q4_K_M', installedAt: '2026-01-01T00:00:00.000Z' });

    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }),
    );
    const installer = new EngineInstaller({ store, bus, fetchImpl: fileFetch(new Uint8Array(8)) });

    await expect(installer.install(PACK_ID)).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalled();
    // The error is reported through the bus, like every other install failure.
    expect(errorOf(events)?.error.code).toBe('ENGINE_PACK_FAILED');
    expect(errorOf(events)?.error.message).toContain('still in place');
    // The working copy was NOT deleted: it never moved, so packDir still holds it.
    expect(await fsp.readFile(path.join(packDir, 'model.gguf'), 'utf8')).toBe('WORKING COPY');

    // And the pack is not wedged as "already in progress" — a retry really runs.
    rename.mockRestore();
    events.length = 0;
    await installer.install(PACK_ID);
    expect(events.some((e) => e.type === 'log' && e.message.includes('already in progress'))).toBe(false);
  });

  it('cleans up a leftover .old directory from an earlier crash', async () => {
    const packDir = store.packDir(PACK_ID);
    await fsp.mkdir(`${packDir}.old`, { recursive: true });
    await fsp.writeFile(path.join(`${packDir}.old`, 'stale'), 'x', 'utf8');

    const installer = new EngineInstaller({ store, bus, fetchImpl: fileFetch(new Uint8Array(8)) });
    await installer.install(PACK_ID); // fails on checksum, which is fine here

    await expect(fsp.stat(`${packDir}.old`)).rejects.toThrow();
  });

  it('refuses a second concurrent install of the same pack', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const installer = new EngineInstaller({
      store,
      bus,
      fetchImpl: (async () => {
        await gate;
        throw new Error('stopped');
      }) as unknown as typeof fetch,
    });

    const first = installer.install(PACK_ID);
    await installer.install(PACK_ID); // returns immediately, guarded
    release?.();
    await first;

    expect(
      events.filter((e) => e.type === 'log' && e.message.includes('already in progress')),
    ).toHaveLength(1);
  });

  it('reports a clear error for an unknown pack id', async () => {
    const installer = new EngineInstaller({ store, bus });
    await installer.install('not-a-pack');
    expect(errorOf(events)?.error.code).toBe('ENGINE_PACK_MISSING');
  });
});
