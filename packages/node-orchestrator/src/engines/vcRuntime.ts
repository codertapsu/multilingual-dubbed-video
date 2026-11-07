/**
 * The Microsoft Visual C++ runtime that every downloadable engine pack needs on Windows.
 *
 * Measured, not assumed: a PE import scan of every .dll/.pyd/.exe in the installed packs
 * found `msvcp140.dll` imported by onnxruntime (both VieNeu packs), PyTorch (the GPU pack),
 * whisper.cpp and llama.cpp, and the GPU pack additionally needs `msvcp140_atomic_wait.dll`
 * and `vcruntime140_threads.dll`, which only recent runtimes have. None of the packs ship
 * it. The base app does not notice: the frozen workers carry their own copy (PyInstaller
 * collects it) and the bundled CPython carries `vcruntime140.dll` but not `msvcp140.dll`. So
 * on a clean Windows the app works, and every engine the app RECOMMENDS dies at its first
 * start with "DLL load failed", after a download of up to 4.5 GB.
 *
 * A present-but-old runtime is as bad as none. Binaries built with MSVC 14.40+ (VS 2022
 * 17.10) crash inside `std::mutex` against an older `msvcp140.dll`; onnxruntime and Arrow
 * both had to work around it in their own builds. So the floor is a version, not "installed".
 *
 * The fix is the installer Microsoft publishes for exactly this. When a pack needs it, the
 * engine installer downloads it, checks Microsoft's signature, and runs it. Windows asks the
 * user for permission once, and that prompt is the consent; declining leaves numbered steps
 * on screen instead. All I/O is injected so the decisions are unit-tested without touching
 * the registry or running an installer.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppError, EnginePackInfo } from '@videodubber/shared';

/**
 * Microsoft's permalink for the latest supported v14 redistributable (VS 2017 through 2026,
 * one binary-compatible runtime). It redirects to the current build on
 * download.visualstudio.microsoft.com, so it cannot carry a pinned sha256 like the catalog
 * artifacts do. Microsoft's Authenticode signature is checked instead.
 */
export const VC_REDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';

/** The oldest runtime that is safe for binaries built with MSVC 14.40+ (see the module doc). */
export const VC_RUNTIME_FLOOR = { major: 14, minor: 40 } as const;

const REG_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64';
export const VC_RUNTIME_DOCS =
  'docs/TROUBLESHOOTING.md#engines-need-the-microsoft-visual-c-runtime';

export interface VcRuntimeVersion {
  major: number;
  minor: number;
  build: number;
}

export type VcRuntimeState =
  | { state: 'ok'; version: VcRuntimeVersion | null }
  | { state: 'missing' }
  | { state: 'outdated'; version: VcRuntimeVersion };

export const formatVcVersion = (v: VcRuntimeVersion): string => `${v.major}.${v.minor}.${v.build}`;

/** Weights-only packs run inside an engine that has its own check. Everything else is native code. */
export function vcRuntimeNeeded(
  pack: Pick<EnginePackInfo, 'packKind'>,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32' && pack.packKind !== 'model';
}

/**
 * Parse `reg query <Runtimes\X64>`. Microsoft documents this key, written by the
 * redistributable, as the way to detect it. Returns null when it says not installed.
 */
export function parseVcRuntimeReg(stdout: string): VcRuntimeVersion | null {
  const dword = (name: string): number | undefined => {
    const m = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, 'im').exec(stdout);
    return m ? parseInt(m[1]!, 16) : undefined;
  };
  if (dword('Installed') !== 1) return null;
  const major = dword('Major');
  const minor = dword('Minor');
  const build = dword('Bld');
  if (major !== undefined && minor !== undefined) return { major, minor, build: build ?? 0 };
  // Older layouts carry only the string form, e.g. "v14.29.30139.00".
  const s = /^\s*Version\s+REG_SZ\s+v?(\d+)\.(\d+)\.(\d+)/im.exec(stdout);
  return s ? { major: Number(s[1]), minor: Number(s[2]), build: Number(s[3]) } : null;
}

const compare = (
  a: VcRuntimeVersion,
  b: { major: number; minor: number; build?: number },
): number => a.major - b.major || a.minor - b.minor || a.build - (b.build ?? 0);

export interface VcDetectDeps {
  /** `reg query <key> /reg:<view>` stdout, or null when the key is absent. */
  regQuery: (key: string, view: 64 | 32) => Promise<string | null>;
  fileExists: (p: string) => Promise<boolean>;
  systemRoot: string;
}

/**
 * Is a runtime at least {@link VC_RUNTIME_FLOOR} installed? The 32-bit registry view is
 * read too, because the bootstrapper is a 32-bit process and some versions only wrote there.
 */
export async function detectVcRuntime(deps: VcDetectDeps): Promise<VcRuntimeState> {
  let best: VcRuntimeVersion | null = null;
  for (const view of [64, 32] as const) {
    const out = await deps.regQuery(REG_KEY, view).catch(() => null);
    const v = out ? parseVcRuntimeReg(out) : null;
    if (v && (!best || compare(v, best) > 0)) best = v;
  }
  const dllPresent = await deps
    .fileExists(path.join(deps.systemRoot, 'System32', 'msvcp140.dll'))
    .catch(() => false);
  if (best) {
    // The registry outliving the DLL (a "cleaner" tool, a botched uninstall) is still missing.
    if (!dllPresent) return { state: 'missing' };
    return compare(best, VC_RUNTIME_FLOOR) >= 0
      ? { state: 'ok', version: best }
      : { state: 'outdated', version: best };
  }
  // DLLs without the key: deployed by something other than the redistributable (an OEM
  // image, another app's installer). The version is unknown, so do not stand in the way.
  // The GPU pack's self-check and the engine's start-up error still catch a bad one.
  return dllPresent ? { state: 'ok', version: null } : { state: 'missing' };
}

export type VcInstallOutcome = 'installed' | 'restart-needed' | 'cancelled' | 'busy' | 'failed';

/** What the bootstrapper's exit code means (WiX Burn / MSI codes). */
export function vcInstallOutcome(code: number | null): VcInstallOutcome {
  switch (code) {
    case 0:
    case 1638: // a newer version is already installed
      return 'installed';
    case 3010: // ERROR_SUCCESS_REBOOT_REQUIRED: files were in use, replaced at restart
    case 1641:
      return 'restart-needed';
    case 1602: // the user cancelled
    case 1223: // the Windows permission prompt was declined
      return 'cancelled';
    case 1618: // another installation (often Windows Update) is running
      return 'busy';
    default:
      return 'failed';
  }
}

/** Where the user picks up again: installing a pack, or running one that is installed. */
export type VcContext = 'install' | 'run';
const AGAIN: Record<VcContext, string> = {
  install: 'click Install again',
  run: 'retry the step (Retry on the processing screen)',
};

/** The manual fix, numbered. Also used by the GPU pack's self-check (gpuVerify.ts). */
export const vcRuntimeSteps = (context: VcContext): string =>
  `1. Download the Microsoft Visual C++ Redistributable (x64) from ${VC_REDIST_URL} (free, from Microsoft). ` +
  '2. Open the downloaded file, tick "I agree to the license terms" and click Install (if it offers Repair ' +
  'instead, click Repair). Windows asks for permission: click Yes (an administrator account is needed; on a ' +
  'work PC, ask your IT team). ' +
  `3. When it says "Setup Successful", come back here and ${AGAIN[context]}. VideoDubber does not need a restart.`;
const steps = vcRuntimeSteps;

export type VcRuntimeError = Pick<
  AppError,
  'code' | 'message' | 'remediation' | 'docsRef' | 'cause'
>;
export type VcFailure =
  'missing' | 'outdated' | 'unverified' | Exclude<VcInstallOutcome, 'installed'>;

/** The error the user sees when the runtime could not be put in place. */
export function vcRuntimeError(
  reason: VcFailure,
  detail?: { version?: VcRuntimeVersion; packName?: string; cause?: string; context?: VcContext },
): VcRuntimeError {
  const context = detail?.context ?? 'install';
  const what = detail?.packName ?? 'This engine';
  const base = `${what} needs the Microsoft Visual C++ Runtime`;
  const message: Record<VcFailure, string> = {
    missing: `${base}, which is not installed on this PC.`,
    outdated: `${base} ${VC_RUNTIME_FLOOR.major}.${VC_RUNTIME_FLOOR.minor} or newer; this PC has ${detail?.version ? formatVcVersion(detail.version) : 'an older version'}.`,
    cancelled: `${base}, and its installation was cancelled at the Windows permission prompt.`,
    busy: `${base}, but Windows is busy installing something else (often Windows Update).`,
    'restart-needed': `${base}. It was installed, but Windows must restart to finish setting it up.`,
    failed: `${base}, and installing it automatically did not succeed.`,
    unverified: `${base}, but the downloaded installer did not carry a valid Microsoft signature, so it was not run.`,
  };
  const remediation =
    reason === 'restart-needed'
      ? `Restart the computer, then open VideoDubber and ${AGAIN[context]}.` +
        (context === 'install' ? ' Nothing has been downloaded for the engine yet.' : '')
      : reason === 'busy'
        ? `Wait a few minutes for the other installation to finish (or restart the computer), then ${AGAIN[context]}. If it keeps failing: ${steps(context)}`
        : steps(context);
  return {
    code: 'ENGINE_PACK_FAILED',
    message: message[reason],
    remediation,
    docsRef: VC_RUNTIME_DOCS,
    ...(detail?.cause ? { cause: detail.cause } : {}),
  };
}

/** Windows' "a DLL this program needs is missing" (STATUS_DLL_NOT_FOUND), as Node reports it. */
const STATUS_DLL_NOT_FOUND = [0xc0000135, -1073741515];
/** Access violation: the std::mutex crash an outdated msvcp140.dll causes. */
const STATUS_ACCESS_VIOLATION = [0xc0000005, -1073741819];

/**
 * Does an engine that died at start look like a missing or outdated runtime? Packs
 * installed before the installer checked (or a runtime removed since) end up here.
 */
export function looksLikeVcRuntimeFailure(code: number | null, stderr: string): boolean {
  if (
    code !== null &&
    (STATUS_DLL_NOT_FOUND.includes(code) || STATUS_ACCESS_VIOLATION.includes(code))
  )
    return true;
  return /DLL load failed|WinError 126|msvcp140|vcruntime140|The specified module could not be found/i.test(
    stderr,
  );
}

export interface VcInstallDeps {
  download: (url: string, dest: string) => Promise<void>;
  /** Authenticode check: true only for a valid signature by Microsoft Corporation. */
  verifySignature: (file: string) => Promise<boolean>;
  /** Runs the installer and resolves with its exit code. */
  runInstaller: (file: string, args: string[]) => Promise<number | null>;
  detect: () => Promise<VcRuntimeState>;
  progress: (message: string) => void;
  tempDir: () => Promise<string>;
}

export type VcEnsureResult = { ok: true } | { ok: false; error: VcRuntimeError };

let inFlight: Promise<VcEnsureResult> | null = null;

/**
 * Make sure the runtime is in place, or say exactly what the user must do. Shared between
 * concurrent installs: two recommended packs installed at once must not race two copies of
 * the same Microsoft installer (the second would fail with 1618).
 */
export function ensureVcRuntime(deps: VcInstallDeps, packName: string): Promise<VcEnsureResult> {
  inFlight ??= runEnsure(deps, packName)
    .then((error): VcEnsureResult => (error ? { ok: false, error } : { ok: true }))
    // Never rejects: the installer must always be able to emit an error event and free
    // the pack's "install in progress" slot.
    .catch((err: unknown): VcEnsureResult => ({
      ok: false,
      error: vcRuntimeError('failed', { packName, cause: String(err) }),
    }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Resolves with the error to show, or null once the runtime is in place. */
async function runEnsure(deps: VcInstallDeps, packName: string): Promise<VcRuntimeError | null> {
  const before = await deps.detect();
  if (before.state === 'ok') return null;

  deps.progress(
    before.state === 'outdated'
      ? `${packName} needs a newer Microsoft Visual C++ Runtime (this PC has ${formatVcVersion(before.version)}). Downloading it from Microsoft…`
      : `${packName} needs the Microsoft Visual C++ Runtime (free, from Microsoft). Downloading it…`,
  );
  const dir = await deps.tempDir();
  const file = path.join(dir, 'vc_redist.x64.exe');
  try {
    try {
      await deps.download(VC_REDIST_URL, file);
    } catch (err) {
      return vcRuntimeError(before.state, {
        packName,
        cause: `download: ${String(err)}`,
        ...('version' in before ? { version: before.version } : {}),
      });
    }
    if (!(await deps.verifySignature(file).catch(() => false))) {
      return vcRuntimeError('unverified', { packName });
    }
    deps.progress(
      'Installing the Microsoft Visual C++ Runtime. Windows will ask for permission: click Yes…',
    );
    const code = await deps
      .runInstaller(file, ['/install', '/passive', '/norestart'])
      .catch(() => null);
    const outcome = vcInstallOutcome(code);
    if (outcome !== 'installed')
      return vcRuntimeError(outcome, { packName, cause: `vc_redist exit code ${code}` });
    const after = await deps.detect();
    if (after.state !== 'ok') {
      return vcRuntimeError(after.state, {
        packName,
        cause: `vc_redist exited ${code} but the runtime is still ${after.state}`,
        ...('version' in after ? { version: after.version } : {}),
      });
    }
    deps.progress('Microsoft Visual C++ Runtime installed.');
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The real I/O, Windows only. Kept here so the installer just calls one function.
// ---------------------------------------------------------------------------

function capture(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: env ?? process.env,
    });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** The production {@link VcInstallDeps}; `progress` comes from the caller. */
export function systemVcDeps(
  progress: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): VcInstallDeps {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const detectDeps: VcDetectDeps = {
    systemRoot,
    regQuery: async (key, view) => {
      const { code, stdout } = await capture(path.join(systemRoot, 'System32', 'reg.exe'), [
        'query',
        key,
        `/reg:${view}`,
      ]);
      return code === 0 ? stdout : null;
    },
    fileExists: (p) =>
      fsp
        .stat(p)
        .then((s) => s.isFile())
        .catch(() => false),
  };
  return {
    progress,
    detect: () => detectVcRuntime(detectDeps),
    tempDir: () => fsp.mkdtemp(path.join(os.tmpdir(), 'videodubber-vcredist-')),
    download: async (url, dest) => {
      const res = await fetchImpl(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(
        Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(dest),
      );
    },
    // Windows PowerShell 5.1 ships with every supported Windows. The path travels in an
    // environment variable, never inside the command text, so no quoting can break it.
    verifySignature: async (file) => {
      const script =
        '$s = Get-AuthenticodeSignature -LiteralPath $env:VD_SIGNED_FILE; ' +
        '[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
      const { stdout } = await capture(
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        signatureCheckEnv(process.env, file),
      );
      return isMicrosoftSignature(stdout);
    },
    // Not hidden: /passive shows Microsoft's own progress bar, so the user can see what
    // the permission prompt was for.
    runInstaller: (file, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: 'ignore', windowsHide: false });
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      }),
  };
}

/**
 * The environment for the Windows PowerShell 5.1 signature check. PSModulePath is
 * dropped: started from PowerShell 7 (a terminal, `pnpm dev`), the app inherits 7's
 * module path, and 5.1 then cannot load its own Get-AuthenticodeSignature. It prints
 * an empty status, so every genuine Microsoft installer looked unsigned. Without the
 * variable, 5.1 rebuilds its default path.
 */
export function signatureCheckEnv(env: NodeJS.ProcessEnv, file: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'psmodulepath') out[k] = v;
  out.VD_SIGNED_FILE = file;
  return out;
}

/** `Get-AuthenticodeSignature` output → trusted? Pure, for the tests. */
export function isMicrosoftSignature(stdout: string): boolean {
  try {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    const sig = JSON.parse(line) as { status?: string; subject?: string };
    return sig.status === 'Valid' && /(^|,\s*)O=Microsoft Corporation(,|$)/.test(sig.subject ?? '');
  } catch {
    return false;
  }
}
