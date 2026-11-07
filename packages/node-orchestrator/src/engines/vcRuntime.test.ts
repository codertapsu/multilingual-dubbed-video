/**
 * The Microsoft Visual C++ runtime in front of every native engine pack on Windows.
 *
 * Why it exists: a PE import scan of the installed packs (2026-11-07) found
 * msvcp140.dll imported by onnxruntime, PyTorch, whisper.cpp and llama.cpp, and
 * shipped by none of them. A clean Windows therefore ran the app but died at the
 * first start of every engine it recommended. All I/O here is faked: no test may
 * read the registry or launch Microsoft's installer.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException, type EngineInstallEvent } from '@videodubber/shared';
import { EngineEventBus } from './engineBus.js';
import { EngineInstaller } from './engineInstaller.js';
import { EngineManager } from './engineManager.js';
import { EnginePackStore } from './enginePackStore.js';
import {
  detectVcRuntime,
  ensureVcRuntime,
  isMicrosoftSignature,
  looksLikeVcRuntimeFailure,
  parseVcRuntimeReg,
  signatureCheckEnv,
  VC_REDIST_URL,
  vcInstallOutcome,
  vcRuntimeNeeded,
  type VcDetectDeps,
  type VcInstallDeps,
  type VcRuntimeState,
} from './vcRuntime.js';

/** Verbatim `reg query ...\Runtimes\X64 /reg:64` from a Windows 11 PC with 14.44. */
const REG_14_44 = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64',
  '    Version    REG_SZ    v14.44.35211.00',
  '    Installed    REG_DWORD    0x1',
  '    Major    REG_DWORD    0xe',
  '    Minor    REG_DWORD    0x2c',
  '    Bld    REG_DWORD    0x898b',
  '    Rbld    REG_DWORD    0x0',
  '',
].join('\r\n');
const reg = (minor: number, bld = 30139): string =>
  REG_14_44.replace('0x2c', `0x${minor.toString(16)}`).replace('0x898b', `0x${bld.toString(16)}`);

describe('reading the installed runtime', () => {
  it('parses the registry key the redistributable writes', () => {
    expect(parseVcRuntimeReg(REG_14_44)).toEqual({ major: 14, minor: 44, build: 35211 });
  });

  it('treats Installed=0 as not installed', () => {
    expect(
      parseVcRuntimeReg(
        REG_14_44.replace('Installed    REG_DWORD    0x1', 'Installed    REG_DWORD    0x0'),
      ),
    ).toBeNull();
  });

  it('falls back to the Version string when the DWORDs are absent', () => {
    const old =
      'HKEY_LOCAL_MACHINE\\...\\X64\r\n    Installed    REG_DWORD    0x1\r\n    Version    REG_SZ    v14.29.30139.00\r\n';
    expect(parseVcRuntimeReg(old)).toEqual({ major: 14, minor: 29, build: 30139 });
  });

  const detect = (
    views: Partial<Record<64 | 32, string>>,
    dllPresent: boolean,
  ): Promise<VcRuntimeState> => {
    const deps: VcDetectDeps = {
      systemRoot: 'C:\\Windows',
      regQuery: async (_key, view) => views[view] ?? null,
      fileExists: async (p) => dllPresent && p.toLowerCase().endsWith('msvcp140.dll'),
    };
    return detectVcRuntime(deps);
  };

  it('accepts 14.40 and newer', async () => {
    expect(await detect({ 64: REG_14_44 }, true)).toEqual({
      state: 'ok',
      version: { major: 14, minor: 44, build: 35211 },
    });
    expect((await detect({ 64: reg(40) }, true)).state).toBe('ok');
  });

  it('calls a pre-14.40 runtime outdated: MSVC 14.40+ builds crash in std::mutex against it', async () => {
    expect(await detect({ 64: reg(29) }, true)).toEqual({
      state: 'outdated',
      version: { major: 14, minor: 29, build: 30139 },
    });
  });

  it('takes the newest of the 64- and 32-bit registry views', async () => {
    expect((await detect({ 64: reg(38), 32: REG_14_44 }, true)).state).toBe('ok');
  });

  it('calls a registry entry without its DLL missing', async () => {
    expect(await detect({ 64: REG_14_44 }, false)).toEqual({ state: 'missing' });
  });

  it('does not block DLLs that something else deployed without the key', async () => {
    expect(await detect({}, true)).toEqual({ state: 'ok', version: null });
    expect(await detect({}, false)).toEqual({ state: 'missing' });
  });
});

describe('which packs need it', () => {
  it('is every native pack on Windows, and nothing elsewhere', () => {
    expect(vcRuntimeNeeded({ packKind: 'python-uv' }, 'win32')).toBe(true);
    expect(vcRuntimeNeeded({ packKind: 'binary' }, 'win32')).toBe(true);
    expect(vcRuntimeNeeded({ packKind: 'model' }, 'win32')).toBe(false);
    expect(vcRuntimeNeeded({ packKind: 'python-uv' }, 'darwin')).toBe(false);
  });
});

describe("Microsoft's installer", () => {
  it('maps its exit codes', () => {
    expect(vcInstallOutcome(0)).toBe('installed');
    expect(vcInstallOutcome(1638)).toBe('installed'); // a newer one is already there
    expect(vcInstallOutcome(3010)).toBe('restart-needed');
    expect(vcInstallOutcome(1223)).toBe('cancelled'); // permission prompt declined
    expect(vcInstallOutcome(1602)).toBe('cancelled');
    expect(vcInstallOutcome(1618)).toBe('busy');
    expect(vcInstallOutcome(null)).toBe('failed');
    expect(vcInstallOutcome(1603)).toBe('failed');
  });

  it('runs only a validly signed Microsoft file', () => {
    const sig = (status: string, subject: string): string => JSON.stringify({ status, subject });
    const ms = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
    expect(isMicrosoftSignature(sig('Valid', ms))).toBe(true);
    expect(isMicrosoftSignature(`WARNING: noise\r\n${sig('Valid', ms)}\r\n`)).toBe(true);
    expect(isMicrosoftSignature(sig('HashMismatch', ms))).toBe(false);
    expect(isMicrosoftSignature(sig('NotSigned', ''))).toBe(false);
    expect(
      isMicrosoftSignature(sig('Valid', 'CN=Someone, O=Microsoft Corporation Fan Club, C=US')),
    ).toBe(false);
    expect(isMicrosoftSignature(sig('Valid', 'CN=Microsoft Corporation, O=Evil Ltd'))).toBe(false);
    expect(isMicrosoftSignature('')).toBe(false);
  });

  it("hides PowerShell 7's module path from the 5.1 signature check", () => {
    // Inherited, it made 5.1 fail to load Get-AuthenticodeSignature and print an
    // empty status: the genuine installer was rejected as unsigned (seen live).
    const env = signatureCheckEnv(
      { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'x', PATH: 'p' },
      'C:\\t\\vc.exe',
    );
    expect(env).toEqual({ PATH: 'p', VD_SIGNED_FILE: 'C:\\t\\vc.exe' });
  });
});

/** Scripted install: the states detect() returns in order, and the installer's exit code. */
function fakeInstall(opts: {
  states: VcRuntimeState[];
  exitCode?: number | null;
  signed?: boolean;
  downloadFails?: boolean;
}) {
  const log = {
    downloads: [] as string[],
    runs: [] as string[][],
    progress: [] as string[],
    detects: 0,
    tempDirs: [] as string[],
  };
  const deps: VcInstallDeps = {
    detect: async () => opts.states[Math.min(log.detects++, opts.states.length - 1)]!,
    tempDir: async () => {
      const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-vcredist-test-'));
      log.tempDirs.push(d);
      return d;
    },
    download: async (url, dest) => {
      log.downloads.push(url);
      if (opts.downloadFails) throw new Error('ECONNRESET');
      await fsp.writeFile(dest, 'MZ');
    },
    verifySignature: async () => opts.signed ?? true,
    runInstaller: async (_file, args) => {
      log.runs.push(args);
      await new Promise((r) => setTimeout(r, 20));
      return opts.exitCode === undefined ? 0 : opts.exitCode;
    },
    progress: (m) => log.progress.push(m),
  };
  return { deps, log };
}

const OK: VcRuntimeState = { state: 'ok', version: { major: 14, minor: 44, build: 35211 } };
const MISSING: VcRuntimeState = { state: 'missing' };

describe('ensureVcRuntime', () => {
  it('does nothing when the runtime is already there', async () => {
    const { deps, log } = fakeInstall({ states: [OK] });
    expect(await ensureVcRuntime(deps, 'VieNeu')).toEqual({ ok: true });
    expect(log.downloads).toEqual([]);
    expect(log.runs).toEqual([]);
  });

  it("installs it from Microsoft's permalink, telling the user about the permission prompt", async () => {
    const { deps, log } = fakeInstall({ states: [MISSING, OK] });
    expect(await ensureVcRuntime(deps, 'VieNeu')).toEqual({ ok: true });
    expect(log.downloads).toEqual([VC_REDIST_URL]);
    expect(log.runs).toEqual([['/install', '/passive', '/norestart']]);
    expect(log.progress.join('\n')).toMatch(/permission: click Yes/);
    // The downloaded installer does not stay behind in %TEMP%.
    for (const d of log.tempDirs) await expect(fsp.stat(d)).rejects.toThrow();
  });

  it('never runs an installer without a valid Microsoft signature', async () => {
    const { deps, log } = fakeInstall({ states: [MISSING], signed: false });
    const r = await ensureVcRuntime(deps, 'VieNeu');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/valid Microsoft signature/);
    expect(log.runs).toEqual([]);
  });

  it('leaves numbered manual steps when the permission prompt is declined', async () => {
    const { deps } = fakeInstall({ states: [MISSING], exitCode: 1223 });
    const r = await ensureVcRuntime(deps, 'VieNeu Neural TTS v3');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toBe(
      'VieNeu Neural TTS v3 needs the Microsoft Visual C++ Runtime, and its installation was cancelled at the Windows permission prompt.',
    );
    expect(r.error.remediation).toContain(
      `1. Download the Microsoft Visual C++ Redistributable (x64) from ${VC_REDIST_URL}`,
    );
    expect(r.error.remediation).toContain(
      '3. When it says "Setup Successful", come back here and click Install again.',
    );
    expect(r.error.docsRef).toBe(
      'docs/TROUBLESHOOTING.md#engines-need-the-microsoft-visual-c-runtime',
    );
  });

  it('asks for a restart when Windows needs one to finish', async () => {
    const { deps } = fakeInstall({
      states: [{ state: 'outdated', version: { major: 14, minor: 29, build: 30139 } }],
      exitCode: 3010,
    });
    const r = await ensureVcRuntime(deps, 'VieNeu');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.remediation).toMatch(/^Restart the computer/);
  });

  it('does not trust an exit code alone: the runtime must be there afterwards', async () => {
    const { deps } = fakeInstall({ states: [MISSING, MISSING], exitCode: 0 });
    const r = await ensureVcRuntime(deps, 'VieNeu');
    expect(r.ok).toBe(false);
  });

  it('turns a failed download into the manual steps', async () => {
    const { deps, log } = fakeInstall({ states: [MISSING], downloadFails: true });
    const r = await ensureVcRuntime(deps, 'VieNeu');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.cause).toContain('ECONNRESET');
    expect(log.runs).toEqual([]);
  });

  it('never rejects, so the installer can always report and free its slot', async () => {
    const { deps } = fakeInstall({ states: [MISSING] });
    const r = await ensureVcRuntime(
      { ...deps, detect: async () => Promise.reject(new Error('reg.exe missing')) },
      'VieNeu',
    );
    expect(r.ok).toBe(false);
  });

  it('runs ONE installer for packs installed at the same time', async () => {
    const { deps, log } = fakeInstall({ states: [MISSING, OK] });
    const [a, b] = await Promise.all([
      ensureVcRuntime(deps, 'VieNeu'),
      ensureVcRuntime(deps, 'whisper.cpp'),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(log.runs).toHaveLength(1);
  });
});

describe('the engine installer puts the runtime in place first', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-vc-installer-test-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  function installer(platform: NodeJS.Platform, deps: VcInstallDeps) {
    const store = new EnginePackStore(path.join(tmp, 'config'));
    const bus = new EngineEventBus();
    const events: EngineInstallEvent[] = [];
    bus.subscribe((e) => events.push(e));
    let fetches = 0;
    const inst = new EngineInstaller({
      store,
      bus,
      platform,
      freeBytes: async () => 2 ** 40,
      vcRuntime: (progress) => ({ ...deps, progress }),
      fetchImpl: (async () => {
        fetches++;
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    return { inst, store, events, fetches: () => fetches };
  }

  it('stops BEFORE downloading anything when the runtime cannot be installed', async () => {
    const { deps } = fakeInstall({ states: [MISSING], exitCode: 1223 });
    const { inst, store, events, fetches } = installer('win32', deps);
    await inst.install('whisper-cpp-cuda');
    const error = events.find(
      (e): e is Extract<EngineInstallEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error?.error.message).toMatch(/needs the Microsoft Visual C\+\+ Runtime/);
    expect(fetches()).toBe(0);
    await expect(fsp.stat(store.packDir('whisper-cpp-cuda'))).rejects.toThrow();
    // Not left "in progress": a retry runs the check again.
    await inst.install('whisper-cpp-cuda');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(2);
  });

  it('carries on to the download once the runtime is there', async () => {
    const { deps, log } = fakeInstall({ states: [MISSING, OK] });
    const { inst, events, fetches } = installer('win32', deps);
    await inst.install('whisper-cpp-cuda');
    expect(log.runs).toHaveLength(1);
    expect(fetches()).toBe(1); // the fake 404 then ends the install
    expect(
      events.some((e) => e.type === 'progress' && /Visual C\+\+ Runtime installed/.test(e.message)),
    ).toBe(true);
  });

  it('skips the check for weights-only packs and on other platforms', async () => {
    const { deps, log } = fakeInstall({ states: [MISSING] });
    await installer('win32', deps).inst.install('translategemma-4b');
    await installer('darwin', deps).inst.install('llama-cpp-metal');
    expect(log.detects).toBe(0);
  });
});

describe('an engine that dies at start for want of the runtime', () => {
  let tmp: string;
  let store: EnginePackStore;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-vc-start-test-'));
    store = new EnginePackStore(tmp);
    const exe = path.join(
      store.packDir('whisper-cpp-cuda'),
      process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server',
    );
    await fsp.mkdir(path.dirname(exe), { recursive: true });
    await fsp.writeFile(exe, '');
    await store.add({
      id: 'whisper-cpp-cuda',
      path: store.packDir('whisper-cpp-cuda'),
      installedAt: '2026-11-07T00:00:00Z',
    });
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  /** A child that exits at once with STATUS_DLL_NOT_FOUND, as Windows reports it. */
  function manager(vc: VcRuntimeState) {
    return new EngineManager({
      store,
      allocatePort: async () => 52100,
      healthProbe: async () => false,
      spawnImpl: () => {
        const handlers: Record<string, (...a: unknown[]) => void> = {};
        setTimeout(() => handlers['exit']?.(3221225781, null), 5);
        return {
          on: (ev: string, cb: (...a: unknown[]) => void) => {
            handlers[ev] = cb;
          },
          stderr: { on: () => undefined },
          kill: () => true,
        } as never;
      },
      startTimeoutMs: 30_000,
      vcRuntimeState: async () => vc,
    });
  }

  it('says which runtime to install, and fails fast instead of waiting out the timeout', async () => {
    const started = Date.now();
    const err = await manager(MISSING)
      .ensureRunning('whisper-cpp-cuda')
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(AppErrorException);
    const appError = (err as AppErrorException).appError;
    expect(appError.message).toMatch(
      /needs the Microsoft Visual C\+\+ Runtime, which is not installed/,
    );
    expect(appError.remediation).toContain('retry the step');
  });

  it('keeps the generic error when the runtime is fine (the missing DLL is something else)', async () => {
    const err = await manager(OK)
      .ensureRunning('whisper-cpp-cuda')
      .catch((e: unknown) => e);
    expect((err as AppErrorException).appError.code).toBe('ENGINE_UNAVAILABLE');
  });

  it('recognises how a missing runtime shows up', () => {
    expect(looksLikeVcRuntimeFailure(3221225781, '')).toBe(true);
    expect(looksLikeVcRuntimeFailure(-1073741515, '')).toBe(true);
    expect(
      looksLikeVcRuntimeFailure(
        1,
        'ImportError: DLL load failed while importing onnxruntime_pybind11_state: The specified module could not be found.',
      ),
    ).toBe(true);
    expect(looksLikeVcRuntimeFailure(1, 'OSError: [Errno 98] address already in use')).toBe(false);
  });
});
