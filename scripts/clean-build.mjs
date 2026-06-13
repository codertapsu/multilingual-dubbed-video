#!/usr/bin/env node
/**
 * scripts/clean-build.mjs — ONE cross-platform command to do a full, clean build
 * of the VideoDubber desktop app, from macOS OR Windows (and Linux).
 *
 *   pnpm desktop:rebuild        # (root package.json)
 *   node scripts/clean-build.mjs
 *
 * What it does, in order:
 *   1. Remove GENERATED build artifacts so nothing stale survives:
 *      - apps/desktop/src-tauri/binaries/*        (the sidecars + their scratch)
 *      - apps/desktop/src-tauri/resources/*       (staged engine-src + bundled CPython)
 *      - apps/desktop/src-tauri/target/release/bundle (the installers)
 *      - every dist/ (orchestrator, shared, media-worker, Angular) + .angular cache
 *      - every *.tsbuildinfo (so tsc fully re-emits)
 *      It deliberately KEEPS node_modules, the cargo dep cache (target/ minus the
 *      bundle), the uv cache, and the worker .venvs — those are correctly
 *      incremental and removing them would add 10-30 min for no correctness gain.
 *      (Set DEEP=1 to also wipe the worker .venvs for a truly-from-zero rebuild.)
 *   2. pnpm install (idempotent; needed on a fresh clone).
 *   3. Ensure each Python worker has a .venv with its requirements (no model
 *      downloads) — build-workers requires the venvs to exist.
 *   4. Build ALL sidecars (orchestrator SEA, the 4 PyInstaller workers, ffmpeg,
 *      uv, the bundled standalone CPython, the engine-src resource) — OS-dispatched
 *      to the .sh (POSIX) or .ps1 (Windows) scripts.
 *   5. tauri build — compiles the Rust app, runs `ng build` (beforeBuildCommand),
 *      and produces the platform installers under target/release/bundle/.
 *
 * Prerequisites (same as any local build): Node 20+, pnpm, Rust toolchain, a
 * Python 3.12 on PATH (for the worker venvs), and — on Windows — PowerShell
 * (Windows PowerShell 5.1, which ships by default, is enough; pwsh 7 is used if
 * present). All hardcoded commands — no shell injection surface.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEEP = process.env.DEEP === '1';

/**
 * The PowerShell launcher to use on Windows: prefer pwsh (PowerShell 7+), but fall
 * back to powershell.exe (Windows PowerShell 5.1), which is all a vanilla Windows
 * ships. The .ps1 build scripts are `#requires -Version 5.1`, so 5.1 is fine.
 */
function resolvePowerShell() {
  const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    stdio: 'ignore',
    shell: true,
  });
  return hasPwsh.status === 0 ? 'pwsh' : 'powershell';
}
const ps = isWin ? resolvePowerShell() : null;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function step(title) {
  console.log(`\n${BOLD}==> ${title}${RESET}`);
}

/** Remove a path (recursively, never throws on absent). Relative to repo root. */
function rmrf(rel) {
  const p = path.join(repoRoot, rel);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`   removed ${rel}`);
  }
}

/** Run a hardcoded command via the platform shell, inheriting stdio. Exits on failure. */
function run(cmd, extraEnv = {}) {
  console.log(`   ${DIM}$ ${cmd}${RESET}`);
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true, // resolves pnpm/pnpm.cmd, pwsh, bash on each OS; commands are hardcoded
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    console.error(`\n[clean-build] failed to launch: ${cmd}\n${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`\n[clean-build] step failed (exit ${res.status}): ${cmd}`);
    process.exit(res.status ?? 1);
  }
}

/** Recursively delete *.tsbuildinfo, skipping heavy/irrelevant dirs. */
function removeTsBuildInfo(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', '.angular']);
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) removeTsBuildInfo(full, depth + 1);
    else if (e.name.endsWith('.tsbuildinfo')) {
      rmSync(full, { force: true });
      console.log(`   removed ${path.relative(repoRoot, full)}`);
    }
  }
}

console.log(`${BOLD}VideoDubber — full clean build${RESET}  (platform: ${process.platform}${DEEP ? ', DEEP' : ''})`);

// 1. Clean generated artifacts -------------------------------------------------
step('Cleaning generated build artifacts');
const binDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');
if (existsSync(binDir)) {
  for (const entry of readdirSync(binDir)) {
    if (entry === '.gitkeep' || entry === 'README.md') continue;
    rmSync(path.join(binDir, entry), { recursive: true, force: true });
  }
  console.log('   cleaned apps/desktop/src-tauri/binaries/* (kept .gitkeep, README.md)');
}
for (const rel of [
  'apps/desktop/src-tauri/resources',
  'apps/desktop/src-tauri/target/release/bundle',
  'apps/desktop/dist',
  'apps/desktop/.angular',
  'packages/shared/dist',
  'packages/node-orchestrator/dist',
  'workers/media-worker/dist',
]) {
  rmrf(rel);
}
removeTsBuildInfo(repoRoot);
if (DEEP) {
  for (const w of ['stt-worker', 'translation-worker', 'tts-worker']) {
    rmrf(`workers/${w}/.venv`);
  }
}

// 2. JS dependencies -----------------------------------------------------------
step('Installing workspace dependencies');
run('pnpm install');

// 3. Python worker venvs (no model downloads) ----------------------------------
step('Ensuring Python worker venvs (requirements only, no model downloads)');
run(
  isWin
    ? `${ps} -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-models.ps1 -SkipModels`
    : 'bash scripts/setup-local-models.sh',
  isWin ? {} : { SKIP_MODELS: '1' },
);

// 4. All sidecars (orchestrator + workers + ffmpeg + uv + bundled CPython + engine-src)
step('Building sidecars');
run(
  isWin
    ? `${ps} -NoProfile -ExecutionPolicy Bypass -File scripts/package/build-sidecars.ps1`
    : 'bash scripts/package/build-sidecars.sh',
);

// 5. Tauri app + installers ----------------------------------------------------
step('Building the Tauri desktop app (this also runs `ng build`)');
run('pnpm --filter videodubber-desktop tauri build');

step('Done. Installers are in apps/desktop/src-tauri/target/release/bundle/');
