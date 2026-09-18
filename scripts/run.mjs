#!/usr/bin/env node
/**
 * scripts/run.mjs — run the right shell twin for this OS.
 *
 * WHY THIS EXISTS: every task script in this repo ships as a PAIR — `dev.sh` and
 * `dev.ps1`, `start.sh` and `start.ps1`, and so on — but package.json invoked the
 * `.sh` half directly (`"dev": "bash scripts/dev.sh"`). So `pnpm dev`, `pnpm start`,
 * `pnpm stop`, `pnpm services`, `pnpm dev:workers` and `pnpm package:sidecars` all
 * failed on Windows, and every doc that told a contributor to run them was wrong on
 * the platform least likely to have bash. The `.ps1` twins existed the whole time;
 * nothing routed to them.
 *
 * So: package.json names a TASK, and this picks the implementation.
 *
 *   node scripts/run.mjs dev                    -> scripts/dev.sh            | scripts/dev.ps1
 *   node scripts/run.mjs package/build-sidecars -> scripts/package/….sh      | ….ps1
 *
 * Arguments after the task name are forwarded verbatim, the child's exit code
 * becomes ours, and Ctrl-C reaches the child (these tasks run dev servers, so the
 * signal path matters more than usual).
 *
 * Deliberately dependency-free and CommonJS-free: it runs before `pnpm install` has
 * necessarily brought anything in, and it is the entry point for `pnpm bootstrap`
 * on a machine that has nothing set up yet.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const isWindows = process.platform === 'win32';

const [task, ...forwarded] = process.argv.slice(2);

if (!task) {
  console.error('usage: node scripts/run.mjs <task> [args…]');
  console.error('       <task> is a script name under scripts/, without extension');
  console.error('       e.g. dev, start, stop, bootstrap, package/build-sidecars');
  process.exit(2);
}

// Keep the task inside scripts/: it is interpolated into a filesystem path and
// then executed, so a `../` would run something outside the repo.
if (task.includes('..') || task.startsWith('/') || task.startsWith('\\')) {
  console.error(`run.mjs: refusing to run a task outside scripts/: ${task}`);
  process.exit(2);
}

const ext = isWindows ? '.ps1' : '.sh';
const scriptPath = join(SCRIPT_DIR, `${task.replace(/\//g, isWindows ? '\\' : '/')}${ext}`);

if (!existsSync(scriptPath)) {
  const otherExt = isWindows ? '.sh' : '.ps1';
  const other = join(SCRIPT_DIR, `${task}${otherExt}`);
  console.error(`run.mjs: no ${ext} implementation for task "${task}".`);
  console.error(`         expected: ${scriptPath}`);
  if (existsSync(other)) {
    // The usual cause: someone added one half of a pair. Say so plainly rather
    // than leaving a "file not found" for the other platform's contributor.
    console.error(`         the ${otherExt} twin exists, so this task simply has not been`);
    console.error(`         ported to ${isWindows ? 'Windows' : 'this platform'} yet.`);
  }
  process.exit(127);
}

/** Resolve the PowerShell to use, preferring pwsh 7 (what the .ps1 files require). */
function resolvePwsh() {
  for (const candidate of ['pwsh', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      const major = Number.parseInt(String(probe.stdout).trim(), 10);
      if (candidate === 'powershell' || Number.isNaN(major) || major < 7) {
        // Windows PowerShell 5.1 mis-handles several of these scripts (native
        // stderr becomes a terminating NativeCommandError, among others), and
        // release-windows.ps1 is #requires -Version 7.0 outright.
        console.error('run.mjs: WARNING — using Windows PowerShell 5.1. These scripts target');
        console.error('         PowerShell 7. Install it with:  winget install --id Microsoft.PowerShell -e');
      }
      return candidate;
    }
  }
  console.error('run.mjs: no PowerShell found on PATH (looked for pwsh, powershell).');
  console.error('         install it with:  winget install --id Microsoft.PowerShell -e');
  process.exit(127);
}

const [command, args] = isWindows
  ? [resolvePwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...forwarded]]
  : ['bash', [scriptPath, ...forwarded]];

const child = spawn(command, args, { stdio: 'inherit', cwd: REPO_ROOT });

// Forward the signals that matter for long-running dev tasks. Without this,
// Ctrl-C kills the wrapper and orphans the stack it started.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (err) => {
  console.error(`run.mjs: could not start ${command}: ${err.message}`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  // Mirror the shell convention so CI and release wrappers see a real failure.
  if (signal) process.exit(128 + (osConstants.signals[signal] ?? 1));
  process.exit(code ?? 1);
});
