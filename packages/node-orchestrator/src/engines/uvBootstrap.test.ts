import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapUv,
  installFromArchive,
  managedUvInstalled,
  managedUvPath,
  UV_VERSION,
  uvArtifactFor,
} from './uvBootstrap.js';
import { _resetUvCache, configureUvHome, ensureUvPath, resolveUvPath, uvObtainable } from './uv.js';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-uvboot-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  _resetUvCache();
  delete process.env.VIDEODUBBER_UV_PATH;
  delete process.env.VIDEODUBBER_BUNDLED;
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

/**
 * Build a real .tar.gz laid out the way Astral ships one
 * (`uv-<triple>/uv` + `uv-<triple>/uvx`) and return it with its true digest,
 * so the bootstrap's extract + checksum paths run for real rather than mocked.
 */
async function makeArchive(binName = 'uv'): Promise<{ archive: string; bytes: Buffer; sha256: string }> {
  const stage = await tmpDir();
  const inner = path.join(stage, 'uv-x86_64-unknown-linux-gnu');
  await fsp.mkdir(inner, { recursive: true });
  await fsp.writeFile(path.join(inner, binName), '#!/bin/sh\necho uv\n');
  await fsp.writeFile(path.join(inner, 'uvx'), '#!/bin/sh\necho uvx\n');
  const archive = path.join(stage, 'uv.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', stage, 'uv-x86_64-unknown-linux-gnu']);
  const bytes = await fsp.readFile(archive);
  return { archive, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A fetch that serves `bytes` once, counting calls. */
function servingFetch(bytes: Buffer): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe('uv artifact pins', () => {
  it('covers every platform we ship, with a real sha256 and a matching archive extension', () => {
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
    ] as const) {
      const a = uvArtifactFor(platform, arch)!;
      expect(a, `${platform}/${arch}`).toBeDefined();
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.asset).toMatch(platform === 'win32' ? /\.zip$/ : /\.tar\.gz$/);
    }
    // An unsupported combination must be reported, not silently mapped to some
    // other platform's binary.
    expect(uvArtifactFor('linux', 'ppc64')).toBeUndefined();
  });

  it('is version-scoped on disk so a bump never overwrites a running binary', () => {
    const p = managedUvPath('/cfg', 'linux');
    expect(p).toBe(path.join('/cfg', 'tools', 'uv', UV_VERSION, 'uv'));
    expect(managedUvPath('/cfg', 'win32')).toMatch(/uv\.exe$/);
  });

  it('stays in lockstep with the version the release scripts bundle', async () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const sh = await fsp.readFile(path.join(root, 'scripts/package/fetch-uv.sh'), 'utf8');
    const ps = await fsp.readFile(path.join(root, 'scripts/package/fetch-uv.ps1'), 'utf8');
    // A drift here would ship one uv in the installer and self-install another.
    expect(sh).toContain(`UV_VERSION:-${UV_VERSION}`);
    expect(ps).toContain(`else { "${UV_VERSION}" }`);
  });
});

describe('installFromArchive (post-verification unpack)', () => {
  it('finds the binary inside the release layout, marks it executable, and publishes it', async () => {
    const cfg = await tmpDir();
    const work = await tmpDir();
    const { archive } = await makeArchive();

    const published = await installFromArchive(archive, work, cfg, 'linux');
    expect(published).toBe(managedUvPath(cfg, 'linux'));
    // Astral nests the Unix binary inside uv-<triple>/ — it must land flat at
    // the managed path, executable, so resolveUvPath can hand it to spawn().
    const stat = await fsp.stat(published);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
    expect(await managedUvInstalled(cfg)).toBe(published);
  });

  it('rejects an archive with no uv binary rather than recording a broken install', async () => {
    const cfg = await tmpDir();
    const work = await tmpDir();
    const { archive } = await makeArchive('not-uv');

    await expect(installFromArchive(archive, work, cfg, 'linux')).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_FAILED' },
    });
    expect(await managedUvInstalled(cfg)).toBeNull();
  });
});

describe('bootstrapUv', () => {
  it('reports download progress and discards a corrupt/tampered archive', async () => {
    const cfg = await tmpDir();
    const { bytes } = await makeArchive();
    const { impl } = servingFetch(bytes);
    const messages: string[] = [];

    // A synthesized archive cannot hash to the pinned digest — that IS the
    // tamper-evidence, so the guard must fire and publish nothing.
    await expect(
      bootstrapUv({
        configDir: cfg,
        fetchImpl: impl,
        platform: 'linux',
        arch: 'x64',
        onProgress: (_p, m) => messages.push(m),
      }),
    ).rejects.toMatchObject({ appError: { code: 'ENGINE_PACK_FAILED' } });
    expect(await managedUvInstalled(cfg)).toBeNull();
    expect(messages.some((m) => m.includes('Downloading uv'))).toBe(true);
  });

  it('a corrupt/tampered download is discarded, leaving nothing half-installed', async () => {
    const cfg = await tmpDir();
    const { impl } = servingFetch(Buffer.from('not an archive'));
    await expect(
      bootstrapUv({ configDir: cfg, fetchImpl: impl, platform: 'linux', arch: 'x64' }),
    ).rejects.toMatchObject({ appError: { code: 'ENGINE_PACK_FAILED' } });
    expect(await managedUvInstalled(cfg)).toBeNull();
    // No scratch dir survives to be mistaken for a real install.
    await expect(fsp.stat(path.join(cfg, 'tools', 'uv', `${UV_VERSION}.tmp`))).rejects.toThrow();
  });

  it('short-circuits when a managed uv is already on disk (no second download)', async () => {
    const cfg = await tmpDir();
    const target = managedUvPath(cfg, 'linux');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '#!/bin/sh\n');
    const { impl, calls } = servingFetch(Buffer.from('unused'));

    const got = await bootstrapUv({ configDir: cfg, fetchImpl: impl, platform: 'linux', arch: 'x64' });
    expect(got).toBe(target);
    expect(calls()).toBe(0);
  });

  it('reports an unsupported platform instead of downloading the wrong binary', async () => {
    const cfg = await tmpDir();
    await expect(
      bootstrapUv({ configDir: cfg, platform: 'linux', arch: 'ppc64' }),
    ).rejects.toMatchObject({ appError: { code: 'ENGINE_PACK_FAILED' } });
  });

  it('concurrent callers share ONE bootstrap (two pack installs, one download)', async () => {
    const cfg = await tmpDir();
    const { impl, calls } = servingFetch(Buffer.from('corrupt'));
    const results = await Promise.allSettled([
      bootstrapUv({ configDir: cfg, fetchImpl: impl, platform: 'linux', arch: 'x64' }),
      bootstrapUv({ configDir: cfg, fetchImpl: impl, platform: 'linux', arch: 'x64' }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(calls()).toBe(1);
  });

  it('every waiter on the shared download gets progress (not just the first)', async () => {
    // Installing two Python packs at once shares one uv download. The second
    // pack emits NOTHING of its own until uv resolves, so if it doesn't receive
    // the shared progress its row sits frozen for the whole download.
    const cfg = await tmpDir();
    const { bytes } = await makeArchive();
    const { impl } = servingFetch(bytes);
    const first: string[] = [];
    const second: string[] = [];

    const a = bootstrapUv({
      configDir: cfg,
      fetchImpl: impl,
      platform: 'linux',
      arch: 'x64',
      onProgress: (_p, m) => first.push(m),
    });
    const b = bootstrapUv({
      configDir: cfg,
      fetchImpl: impl,
      platform: 'linux',
      arch: 'x64',
      onProgress: (_p, m) => second.push(m),
    });
    await Promise.allSettled([a, b]);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('a throwing progress sink cannot abort the shared download', async () => {
    const cfg = await tmpDir();
    const { bytes } = await makeArchive();
    const { impl } = servingFetch(bytes);
    const good: string[] = [];

    const a = bootstrapUv({
      configDir: cfg,
      fetchImpl: impl,
      platform: 'linux',
      arch: 'x64',
      onProgress: () => {
        throw new Error('bus exploded');
      },
    });
    const b = bootstrapUv({
      configDir: cfg,
      fetchImpl: impl,
      platform: 'linux',
      arch: 'x64',
      onProgress: (_p, m) => good.push(m),
    });
    const results = await Promise.allSettled([a, b]);

    // Both still fail on the (synthetic) checksum — not on the sink.
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).not.toMatch(/bus exploded/);
    }
    expect(good.length).toBeGreaterThan(0);
  });

  it('prunes superseded uv versions after a successful install (no orphaned copies)', async () => {
    const cfg = await tmpDir();
    const work = await tmpDir();
    const { archive } = await makeArchive();
    // Two stale trees a previous pin left behind.
    const stale = path.join(cfg, 'tools', 'uv', '0.0.1');
    await fsp.mkdir(stale, { recursive: true });
    await fsp.writeFile(path.join(stale, 'uv'), 'old');
    const staleTmp = path.join(cfg, 'tools', 'uv', '0.0.2.tmp');
    await fsp.mkdir(staleTmp, { recursive: true });

    await installFromArchive(archive, work, cfg, 'linux');

    const left = await fsp.readdir(path.join(cfg, 'tools', 'uv'));
    expect(left).toEqual([UV_VERSION]);
  });
});

describe('uv resolution tiers', () => {
  it('prefers a previously self-installed uv over PATH, and reports it available', async () => {
    const cfg = await tmpDir();
    const managed = managedUvPath(cfg);
    await fsp.mkdir(path.dirname(managed), { recursive: true });
    await fsp.writeFile(managed, '#!/bin/sh\n');
    configureUvHome(cfg);

    expect(await resolveUvPath()).toBe(managed);
    expect(await uvObtainable()).toBe(true);
  });

  it('a broken BUNDLED uv falls back to the managed copy instead of dead-ending', async () => {
    const cfg = await tmpDir();
    const managed = managedUvPath(cfg);
    await fsp.mkdir(path.dirname(managed), { recursive: true });
    await fsp.writeFile(managed, '#!/bin/sh\n');
    // Packaged app whose declared sidecar vanished (corrupt install): the PATH
    // fallback stays forbidden, but our own pinned copy repairs it.
    process.env.VIDEODUBBER_UV_PATH = path.join(cfg, 'does-not-exist', 'uv');
    process.env.VIDEODUBBER_BUNDLED = '1';
    configureUvHome(cfg);

    expect(await resolveUvPath()).toBe(managed);
  });

  it('ensureUvPath returns the existing uv without downloading anything', async () => {
    const cfg = await tmpDir();
    const managed = managedUvPath(cfg);
    await fsp.mkdir(path.dirname(managed), { recursive: true });
    await fsp.writeFile(managed, '#!/bin/sh\n');
    configureUvHome(cfg);

    await expect(ensureUvPath()).resolves.toBe(managed);
  });
});
