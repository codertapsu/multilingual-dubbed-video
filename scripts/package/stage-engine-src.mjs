#!/usr/bin/env node
/**
 * Stage the first-party engine-pack worker SOURCE into the Tauri bundle
 * resources, so the packaged app can run the Python engine packs with NOTHING
 * for the user to install. Cross-platform (Node) so it runs identically in the
 * POSIX (build-sidecars.sh) and Windows (build-sidecars.ps1) sidecar builds —
 * the Windows path previously skipped this, which broke `tauri build` because
 * the declared `resources/engine-src` resource was missing.
 *
 * Copies workers/tts-engine-neural/vd_tts_engine -> apps/desktop/src-tauri/
 * resources/engine-src/vd_tts_engine (gitignored; tauri.conf bundles it).
 *
 * Run from anywhere: node scripts/package/stage-engine-src.mjs
 */
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const src = path.join(repoRoot, 'workers', 'tts-engine-neural', 'vd_tts_engine');
const destDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'engine-src');
const dest = path.join(destDir, 'vd_tts_engine');

if (!existsSync(src)) {
  console.error(`error: engine source not found at ${src}`);
  process.exit(1);
}

console.log(`==> Staging engine source: ${src} -> ${dest}`);
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
// Copy the package, excluding caches/compiled files.
cpSync(src, dest, {
  recursive: true,
  filter: (s) => !s.includes('__pycache__') && !s.endsWith('.pyc'),
});

const staged = readdirSync(dest).filter((f) => f.endsWith('.py')).sort();
console.log(`==> Staged: ${staged.join(', ')}`);
if (staged.length === 0) {
  console.error('error: no .py files staged');
  process.exit(1);
}
