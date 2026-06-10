/**
 * scripts/verify-environment.ts — VideoDubber environment doctor.
 *
 * Usage:
 *   pnpm verify
 *   tsx scripts/verify-environment.ts
 *   node --import tsx scripts/verify-environment.ts
 *
 * Checks and prints a status table for everything the local/offline pipeline
 * needs: Node, pnpm, Python, ffmpeg/ffprobe, the 3 Python workers (/health),
 * the Node orchestrator (/health), a faster-whisper model hint, installed Argos
 * languages (queried via the translation worker), and the Piper binary/voice.
 *
 * For each item it prints OK / WARN / MISSING plus a remediation hint and a
 * docs/ link. It exits NON-ZERO only when a *core* requirement (Node or pnpm)
 * is missing. Everything else is a warning so you can verify a partial setup.
 *
 * Implementation constraints: only Node built-ins + global fetch. No extra deps.
 * Fully typed, no `any`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity of a single check result. */
type CheckStatus = 'ok' | 'warn' | 'missing';

/** Whether a failing check should make the whole script exit non-zero. */
type Criticality = 'core' | 'optional';

interface CheckResult {
  /** Short human label shown in the leftmost column. */
  name: string;
  status: CheckStatus;
  /** Detail shown next to the status (version string, URL, reason). */
  detail: string;
  /** Remediation hint shown when status is not "ok". */
  remediation?: string;
  /** Relative docs/ link the user can open for more help. */
  docs?: string;
  /** Core checks failing => non-zero exit. */
  criticality: Criticality;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary could not be spawned at all (ENOENT etc.). */
  spawnError: boolean;
}

// ---------------------------------------------------------------------------
// Config (env-overridable, mirrors the rest of the project)
// ---------------------------------------------------------------------------

const ENV = process.env;

const ORCHESTRATOR_URL = ENV.ORCHESTRATOR_URL ?? 'http://127.0.0.1:5100';
const STT_WORKER_URL = ENV.STT_WORKER_URL ?? 'http://127.0.0.1:5101';
const TRANSLATION_WORKER_URL = ENV.TRANSLATION_WORKER_URL ?? 'http://127.0.0.1:5102';
const TTS_WORKER_URL = ENV.TTS_WORKER_URL ?? 'http://127.0.0.1:5103';

const PYTHON_PATH = ENV.PYTHON_PATH ?? 'python3';
const FFMPEG_PATH = ENV.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE_PATH = ENV.FFPROBE_PATH ?? 'ffprobe';

const FASTER_WHISPER_MODEL = ENV.FASTER_WHISPER_MODEL ?? 'small';
const PIPER_BINARY_PATH = ENV.PIPER_BINARY_PATH;
const PIPER_VOICE_MODEL_PATH = ENV.PIPER_VOICE_MODEL_PATH;

/** Minimum Node major version the toolchain targets (ES2022 / global fetch). */
const MIN_NODE_MAJOR = 18;

/** Short timeout for any HTTP health probe (ms). */
const HEALTH_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** ANSI colors; auto-disabled when stdout is not a TTY or NO_COLOR is set. */
const useColor = process.stdout.isTTY === true && !('NO_COLOR' in ENV);
const color = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string): string => color('32', s);
const yellow = (s: string): string => color('33', s);
const red = (s: string): string => color('31', s);
const dim = (s: string): string => color('2', s);
const bold = (s: string): string => color('1', s);

/**
 * Spawn a command with argv array (never a shell string) and capture output.
 * Resolves (never rejects) so callers can branch on `spawnError`.
 */
function run(cmd: string, args: readonly string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      finish({ code: null, stdout: '', stderr: '', spawnError: true });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, spawnError: false });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, spawnError: false });
    });
  });
}

/** Probe a JSON HTTP endpoint with a hard timeout. */
async function fetchJson(
  url: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: undefined, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNode(): CheckResult {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) {
    return {
      name: 'Node.js',
      status: 'ok',
      detail: `v${version}`,
      criticality: 'core',
    };
  }
  return {
    name: 'Node.js',
    status: 'missing',
    detail: `v${version} (need >= ${MIN_NODE_MAJOR})`,
    remediation: `Install Node ${MIN_NODE_MAJOR}+ (nvm or https://nodejs.org). Global fetch & ES2022 are required.`,
    docs: 'docs/LOCAL_SETUP.md',
    criticality: 'core',
  };
}

async function checkPnpm(): Promise<CheckResult> {
  const res = await run('pnpm', ['--version']);
  if (!res.spawnError && res.code === 0) {
    return { name: 'pnpm', status: 'ok', detail: `v${res.stdout.trim()}`, criticality: 'core' };
  }
  return {
    name: 'pnpm',
    status: 'missing',
    detail: 'not found on PATH',
    remediation: 'Install pnpm: npm i -g pnpm (or: corepack enable).',
    docs: 'docs/LOCAL_SETUP.md',
    criticality: 'core',
  };
}

async function checkPython(): Promise<CheckResult> {
  const res = await run(PYTHON_PATH, ['--version']);
  if (!res.spawnError && res.code === 0) {
    const detail = (res.stdout.trim() || res.stderr.trim()) || 'installed';
    return { name: 'Python', status: 'ok', detail, criticality: 'optional' };
  }
  return {
    name: 'Python',
    status: 'missing',
    detail: `'${PYTHON_PATH}' not found`,
    remediation: 'Install Python 3.10+ or set PYTHON_PATH. Needed for the 3 workers.',
    docs: 'docs/LOCAL_SETUP.md',
    criticality: 'optional',
  };
}

/**
 * Verify an ffmpeg-family binary by running `-version` and reading the first line.
 */
async function checkFfBinary(label: string, bin: string, envName: string): Promise<CheckResult> {
  // `bin` is either an absolute path (from FFMPEG_PATH/FFPROBE_PATH) or a bare
  // command name resolved against PATH by spawn().
  const res = await run(bin, ['-version'], 4000);
  if (!res.spawnError && res.code === 0) {
    const firstLine = res.stdout.split('\n')[0]?.trim() ?? 'version ok';
    return { name: label, status: 'ok', detail: firstLine, criticality: 'optional' };
  }
  return {
    name: label,
    status: 'missing',
    detail: `'${bin}' not runnable`,
    remediation: `Install FFmpeg or set ${envName} to the binary. Probing/rendering needs it.`,
    docs: 'docs/LOCAL_SETUP.md',
    criticality: 'optional',
  };
}

/** Generic /health probe for a worker or the orchestrator. */
async function checkHealth(
  label: string,
  baseUrl: string,
  docs: string,
  startHint: string,
): Promise<CheckResult> {
  const res = await fetchJson(`${baseUrl}/health`);
  if (res.ok) {
    // Summarize capability flags if the worker returned any.
    let caps = '';
    if (res.body && typeof res.body === 'object') {
      const obj = res.body as Record<string, unknown>;
      const flags = Object.entries(obj)
        .filter(([k]) => k !== 'status')
        .map(([k, v]) => `${k}=${formatFlag(v)}`)
        .slice(0, 4);
      if (flags.length > 0) caps = ` ${dim(flags.join(' '))}`;
    }
    return { name: label, status: 'ok', detail: `${baseUrl}${caps}`, criticality: 'optional' };
  }
  const reason = res.status > 0 ? `HTTP ${res.status}` : (res.error ?? 'no response');
  return {
    name: label,
    status: 'warn',
    detail: `${baseUrl} (${reason})`,
    remediation: startHint,
    docs,
    criticality: 'optional',
  };
}

function formatFlag(v: unknown): string {
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return 'obj';
}

/**
 * faster-whisper model presence is only a *hint*: models live in the HuggingFace
 * cache and we don't import Python here. We probe the STT worker's /health for a
 * model flag, and otherwise point at the default cache location.
 */
async function checkWhisperModel(): Promise<CheckResult> {
  const res = await fetchJson(`${STT_WORKER_URL}/health`);
  if (res.ok && res.body && typeof res.body === 'object') {
    const obj = res.body as Record<string, unknown>;
    const model = typeof obj.model === 'string' ? obj.model : undefined;
    const loaded = obj.modelLoaded === true || obj.model_loaded === true;
    if (model || loaded) {
      return {
        name: 'faster-whisper',
        status: 'ok',
        detail: `worker reports model=${model ?? FASTER_WHISPER_MODEL}${loaded ? ' (loaded)' : ''}`,
        criticality: 'optional',
      };
    }
  }
  // Fall back to a filesystem hint for the HF cache.
  const hfCache = ENV.HF_HOME
    ? join(ENV.HF_HOME, 'hub')
    : join(homedir(), '.cache', 'huggingface', 'hub');
  const cached = existsSync(hfCache);
  return {
    name: 'faster-whisper',
    status: 'warn',
    detail: `model '${FASTER_WHISPER_MODEL}' not confirmed${cached ? ` (HF cache: ${hfCache})` : ''}`,
    remediation:
      'Pre-cache it: scripts/setup-local-models.sh (or it downloads on first transcription).',
    docs: 'docs/MODEL_SETUP.md',
    criticality: 'optional',
  };
}

/** Query the translation worker for installed Argos language pairs. */
async function checkArgosLanguages(): Promise<CheckResult> {
  const res = await fetchJson(`${TRANSLATION_WORKER_URL}/languages`);
  if (res.ok && res.body && typeof res.body === 'object') {
    const obj = res.body as Record<string, unknown>;
    const installed = Array.isArray(obj.installed) ? obj.installed : [];
    if (installed.length > 0) {
      const pairs = installed
        .map((p) => {
          if (p && typeof p === 'object') {
            const r = p as Record<string, unknown>;
            return `${String(r.from ?? '?')}->${String(r.to ?? '?')}`;
          }
          return '?';
        })
        .slice(0, 6)
        .join(', ');
      const more = installed.length > 6 ? ` (+${installed.length - 6} more)` : '';
      return {
        name: 'Argos languages',
        status: 'ok',
        detail: `${installed.length} pair(s): ${pairs}${more}`,
        criticality: 'optional',
      };
    }
    return {
      name: 'Argos languages',
      status: 'warn',
      detail: 'worker up, but NO language packages installed',
      remediation:
        'Install a pair, e.g. en->vi: scripts/setup-local-models.sh (or: argospm install translate-en_vi).',
      docs: 'docs/MODEL_SETUP.md',
      criticality: 'optional',
    };
  }
  const reason = res.status > 0 ? `HTTP ${res.status}` : (res.error ?? 'no response');
  return {
    name: 'Argos languages',
    status: 'warn',
    detail: `translation worker unreachable (${reason})`,
    remediation: 'Start the translation worker (scripts/dev-workers.sh), then re-run verify.',
    docs: 'docs/MODEL_SETUP.md',
    criticality: 'optional',
  };
}

/** Piper is purely filesystem/env based — the TTS worker degrades gracefully without it. */
function checkPiper(): CheckResult {
  const binSet = typeof PIPER_BINARY_PATH === 'string' && PIPER_BINARY_PATH.length > 0;
  const voiceSet = typeof PIPER_VOICE_MODEL_PATH === 'string' && PIPER_VOICE_MODEL_PATH.length > 0;

  const binOk = binSet && existsSync(PIPER_BINARY_PATH as string);
  const voiceOk = voiceSet && existsSync(PIPER_VOICE_MODEL_PATH as string);
  const voiceJsonOk = voiceOk && existsSync(`${PIPER_VOICE_MODEL_PATH as string}.json`);

  if (binOk && voiceOk) {
    const sizeMb = voiceOk
      ? (statSync(PIPER_VOICE_MODEL_PATH as string).size / (1024 * 1024)).toFixed(1)
      : '?';
    const jsonNote = voiceJsonOk ? '' : ' (warning: missing .onnx.json config)';
    return {
      name: 'Piper TTS',
      status: voiceJsonOk ? 'ok' : 'warn',
      detail: `binary + voice present (${sizeMb} MB)${jsonNote}`,
      remediation: voiceJsonOk ? undefined : 'Download the matching .onnx.json next to the voice.',
      docs: voiceJsonOk ? undefined : 'docs/MODEL_SETUP.md',
      criticality: 'optional',
    };
  }

  const missing: string[] = [];
  if (!binSet) missing.push('PIPER_BINARY_PATH unset');
  else if (!binOk) missing.push(`PIPER_BINARY_PATH not found (${PIPER_BINARY_PATH})`);
  if (!voiceSet) missing.push('PIPER_VOICE_MODEL_PATH unset');
  else if (!voiceOk) missing.push(`voice not found (${PIPER_VOICE_MODEL_PATH})`);

  return {
    name: 'Piper TTS',
    status: 'warn',
    detail: missing.join('; '),
    remediation:
      'Optional. Without Piper, TTS falls back to system TTS / silent dev WAV. Run scripts/setup-local-models.sh to install.',
    docs: 'docs/MODEL_SETUP.md',
    criticality: 'optional',
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusBadge(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return green('OK     ');
    case 'warn':
      return yellow('WARN   ');
    case 'missing':
      return red('MISSING');
  }
}

function printTable(results: readonly CheckResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length), 4);

  console.log('');
  console.log(bold('  VideoDubber — environment check'));
  console.log('  ' + dim('-'.repeat(70)));

  for (const r of results) {
    const name = r.name.padEnd(nameWidth);
    console.log(`  ${statusBadge(r.status)}  ${bold(name)}  ${r.detail}`);
    if (r.status !== 'ok' && r.remediation) {
      console.log(`  ${' '.repeat(9)}  ${' '.repeat(nameWidth)}  ${dim('-> ' + r.remediation)}`);
      if (r.docs) {
        console.log(`  ${' '.repeat(9)}  ${' '.repeat(nameWidth)}  ${dim('   see ' + r.docs)}`);
      }
    }
  }

  console.log('  ' + dim('-'.repeat(70)));
}

function printSummary(results: readonly CheckResult[]): number {
  const ok = results.filter((r) => r.status === 'ok').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const missing = results.filter((r) => r.status === 'missing').length;

  const coreFailures = results.filter(
    (r) => r.criticality === 'core' && r.status !== 'ok',
  );

  console.log(
    `  Summary: ${green(`${ok} OK`)}, ${yellow(`${warn} warning(s)`)}, ${red(`${missing} missing`)}`,
  );

  if (coreFailures.length > 0) {
    console.log('');
    console.log(
      red(
        `  CORE requirement(s) missing: ${coreFailures.map((r) => r.name).join(', ')}. ` +
          'Fix these before running the app.',
      ),
    );
    console.log('');
    return 1;
  }

  if (warn + missing > 0) {
    console.log('');
    console.log(
      yellow(
        '  Core tooling is present. Some optional components need attention (see above). ' +
          'The app can run with reduced/offline-fallback functionality.',
      ),
    );
  } else {
    console.log('');
    console.log(green('  All checks passed. You are ready to dub.'));
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Core (sync/quick) first.
  const node = checkNode();

  // Run the rest concurrently — they are independent probes.
  const [
    pnpm,
    python,
    ffmpeg,
    ffprobe,
    orchestrator,
    stt,
    translation,
    tts,
    whisper,
    argos,
  ] = await Promise.all([
    checkPnpm(),
    checkPython(),
    checkFfBinary('FFmpeg', FFMPEG_PATH, 'FFMPEG_PATH'),
    checkFfBinary('FFprobe', FFPROBE_PATH, 'FFPROBE_PATH'),
    checkHealth(
      'Orchestrator',
      ORCHESTRATOR_URL,
      'docs/LOCAL_SETUP.md',
      'Start it: pnpm --filter @videodubber/node-orchestrator dev (or ./scripts/dev.sh).',
    ),
    checkHealth(
      'STT worker',
      STT_WORKER_URL,
      'docs/LOCAL_SETUP.md',
      'Start it: ./scripts/dev-workers.sh (port 5101).',
    ),
    checkHealth(
      'Translation worker',
      TRANSLATION_WORKER_URL,
      'docs/LOCAL_SETUP.md',
      'Start it: ./scripts/dev-workers.sh (port 5102).',
    ),
    checkHealth(
      'TTS worker',
      TTS_WORKER_URL,
      'docs/LOCAL_SETUP.md',
      'Start it: ./scripts/dev-workers.sh (port 5103).',
    ),
    checkWhisperModel(),
    checkArgosLanguages(),
  ]);

  const piper = checkPiper();

  const results: CheckResult[] = [
    node,
    pnpm,
    python,
    ffmpeg,
    ffprobe,
    orchestrator,
    stt,
    translation,
    tts,
    whisper,
    argos,
    piper,
  ];

  printTable(results);
  const exitCode = printSummary(results);
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(red('  verify-environment crashed unexpectedly:'));
  console.error(message);
  // A crash in the doctor itself is non-core; do not block on it.
  process.exitCode = 0;
});
