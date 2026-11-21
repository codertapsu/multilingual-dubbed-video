/**
 * What the app can say about its own state when something went wrong
 * (Settings → Diagnostics, Help → Export support bundle, the plugin's
 * get_diagnostics): health, the GPU and who holds it, the queue with its
 * reasons, engines and their last output, disk use per project and free disk,
 * recent warnings and errors, and crash reports.
 *
 * The support bundle is a zip of the same, plus log tails, written to
 * `<config>/logs/support/`. It never contains API keys or site logins, and the
 * home folder is written as `~`.
 */
import { execFile } from 'node:child_process';
import { type Dirent, readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackendCrash, BackendHealth, QueueState } from '@videodubber/shared';

import { freeBytes } from '../engines/diskSpace.js';
import { engineLogFile, tailFile, type LogRecord, type StructuredLog } from './logFiles.js';
import { buildZip, type ZipEntry } from './zip.js';

const execFileAsync = promisify(execFile);

/** One graphics card's memory and load, from nvidia-smi. */
export interface GpuUse {
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  utilizationPct: number;
}

export interface DiagnosticsSummary {
  generatedAt: string;
  health: BackendHealth;
  /** null: no NVIDIA card, or nvidia-smi did not answer. */
  gpu: GpuUse[] | null;
  /** Who holds the heavy (GPU) lane: a project id, `editor:<id>`, `preview:<voice>`… */
  laneOwner?: string;
  queue: QueueState | null;
  engines: { running: string[]; unusable: string[]; lastOutput: Record<string, string> };
  disk: { freeBytes?: number; projectsDir: string; projects: { id: string; name: string; bytes: number }[] };
  recent: { warnings: LogRecord[]; errors: LogRecord[] };
  crashes: { file: string; at: string; kind: string }[];
}

export interface DiagnosticsDeps {
  logsDir: string;
  structured: StructuredLog;
  health: () => BackendHealth;
  queueState: () => Promise<QueueState>;
  laneOwner: () => string | undefined;
  runningEngines: () => string[];
  unusableEngines: () => string[];
  projectsDir: () => string;
  listProjects: () => Promise<{ id: string; name: string; workspaceDir: string }[]>;
  /** Extra JSON files for the bundle (system profile, versions, preferences): name → value. */
  extras?: () => Promise<Record<string, unknown>>;
  /** nvidia-smi (tests inject one). */
  gpu?: () => Promise<GpuUse[] | null>;
}

/** Live GPU memory and load, or null. Best-effort: 5 s at most. */
export async function queryNvidiaGpus(): Promise<GpuUse[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
    );
    return parseNvidiaSmi(stdout);
  } catch {
    return null;
  }
}

/** nvidia-smi's CSV lines. Pure. */
export function parseNvidiaSmi(stdout: string): GpuUse[] | null {
  const gpus = stdout
    .split(/\r?\n/)
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((p) => p.length >= 4 && p[0])
    .map(([name, used, total, util]) => ({
      name: name!,
      memoryUsedMb: Number(used) || 0,
      memoryTotalMb: Number(total) || 0,
      utilizationPct: Number(util) || 0,
    }));
  return gpus.length > 0 ? gpus : null;
}

/** Total size of a folder's files (symlinks not followed). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += await fsp.stat(p).then((s) => s.size, () => 0);
    }
  }
  return total;
}

/** Write the home folder as `~` (a support bundle may be shared). Pure. */
export function redactHome(text: string, home = os.homedir()): string {
  if (!home) return text;
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
  let out = text;
  for (const v of variants) if (v.length > 3) out = out.split(v).join('~');
  return out;
}

export class DiagnosticsService {
  private diskCache: { at: number; value: DiagnosticsSummary['disk'] } | undefined;

  constructor(private readonly deps: DiagnosticsDeps) {}

  /** Crash reports on disk: Node's fatal reports, the shell's crash markers, JavaScript crashes. */
  crashes(): DiagnosticsSummary['crashes'] {
    const out: DiagnosticsSummary['crashes'] = [];
    const look = (dir: string, prefix: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!/\.json$/i.test(name)) continue;
        if (prefix && !name.startsWith(prefix)) continue;
        const file = path.join(dir, name);
        let at: string;
        try {
          at = statSync(file).mtime.toISOString();
        } catch {
          continue;
        }
        const kind = name.startsWith('backend-crash') ? 'backend exit' : name.startsWith('crash-') ? 'JavaScript error' : 'Node fatal report';
        out.push({ file, at, kind });
      }
    };
    look(path.join(this.deps.logsDir, 'crash'), '');
    look(this.deps.logsDir, 'crash-');
    return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
  }

  private async disk(): Promise<DiagnosticsSummary['disk']> {
    if (this.diskCache && Date.now() - this.diskCache.at < 60_000) return this.diskCache.value;
    const projectsDir = this.deps.projectsDir();
    const projects = await this.deps.listProjects().catch(() => []);
    const sized = [];
    for (const p of projects) sized.push({ id: p.id, name: p.name, bytes: await folderBytes(p.workspaceDir) });
    sized.sort((a, b) => b.bytes - a.bytes);
    const free = await freeBytes(projectsDir).catch(() => undefined);
    const value = { ...(free !== undefined ? { freeBytes: free } : {}), projectsDir, projects: sized.slice(0, 40) };
    this.diskCache = { at: Date.now(), value };
    return value;
  }

  async summary(): Promise<DiagnosticsSummary> {
    const records = this.deps.structured.recent(512 * 1024);
    const running = this.deps.runningEngines();
    const unusable = this.deps.unusableEngines();
    const lastOutput: Record<string, string> = {};
    for (const id of new Set([...running, ...unusable])) {
      lastOutput[id] = tailFile(engineLogFile(this.deps.logsDir, id), 4096);
    }
    const laneOwner = this.deps.laneOwner();
    return {
      generatedAt: new Date().toISOString(),
      health: this.deps.health(),
      gpu: await (this.deps.gpu ?? queryNvidiaGpus)(),
      ...(laneOwner ? { laneOwner } : {}),
      queue: await this.deps.queueState().catch(() => null),
      engines: { running, unusable, lastOutput },
      disk: await this.disk(),
      recent: {
        warnings: records.filter((r) => r.level === 'warn').slice(-30),
        errors: records.filter((r) => r.level === 'error').slice(-30),
      },
      crashes: this.crashes(),
    };
  }

  /** The support bundle: a zip in `<logs>/support/`, its path and size. */
  async bundle(now = new Date()): Promise<{ path: string; sizeBytes: number }> {
    const entries: ZipEntry[] = [];
    const text = (name: string, value: string): void => {
      entries.push({ name, data: redactHome(value) });
    };
    text('summary.json', JSON.stringify(await this.summary(), null, 2));
    const extras = (await this.deps.extras?.().catch(() => ({}))) ?? {};
    for (const [name, value] of Object.entries(extras)) text(`${name}.json`, JSON.stringify(value, null, 2));
    // Log tails: the app's own, the shell's, each worker's, each engine's.
    const logs = this.deps.logsDir;
    const tails: [string, number][] = [
      ['orchestrator.jsonl', 2 * 1024 * 1024],
      ['videodubber-orchestrator.log', 2 * 1024 * 1024],
      ['shell.log', 512 * 1024],
      ['vd-stt-worker.log', 512 * 1024],
      ['vd-translation-worker.log', 512 * 1024],
      ['vd-tts-worker.log', 512 * 1024],
    ];
    for (const [name, max] of tails) {
      const t = tailFile(path.join(logs, name), max);
      if (t) text(`logs/${name}`, t);
    }
    try {
      for (const name of readdirSync(path.join(logs, 'engines'))) {
        if (!name.endsWith('.log')) continue;
        text(`logs/engines/${name}`, tailFile(path.join(logs, 'engines', name), 512 * 1024));
      }
    } catch {
      /* no engine has run */
    }
    for (const c of this.crashes()) {
      try {
        text(`crash/${path.basename(c.file)}`, readFileSync(c.file, 'utf8').slice(0, 4 * 1024 * 1024));
      } catch {
        /* moved meanwhile */
      }
    }
    const dir = path.join(logs, 'support');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `support-${now.toISOString().replace(/[:.]/g, '-')}.zip`);
    const zip = buildZip(entries, now);
    writeFileSync(file, zip);
    return { path: file, sizeBytes: zip.length };
  }
}

export type { BackendCrash };
