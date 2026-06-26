#!/usr/bin/env node
/**
 * Stage the first-party engine-pack worker SOURCE into the Tauri bundle
 * resources, so the packaged app can run the Python engine packs with NOTHING
 * for the user to install. Cross-platform (Node) so it runs identically in the
 * POSIX (build-sidecars.sh) and Windows (build-sidecars.ps1) sidecar builds —
 * the Windows path previously skipped this, which broke `tauri build` because
 * the declared `resources/engine-src` resource was missing.
 *
 * Copies each first-party engine worker package into apps/desktop/src-tauri/
 * resources/engine-src/<package> (gitignored; tauri.conf bundles the dir). The
 * orchestrator puts this dir on PYTHONPATH (VIDEODUBBER_ENGINE_SRC_DIR), so every
 * package staged here is importable as `python -m <package>`:
 *   - workers/tts-engine-neural/vd_tts_engine   (VieNeu)
 *
 * (OmniVoice / vd_omnivoice is intentionally NOT staged while its engine pack is
 * disabled — see DISABLED_PACK_IDS in enginePackCatalog.ts — so the bundle stays
 * lean. Re-add it here when OmniVoice is re-enabled.)
 *
 * Run from anywhere: node scripts/package/stage-engine-src.mjs
 */
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const destDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'engine-src');

// Each first-party engine-pack worker package to stage (importable as `python -m <name>`).
const SOURCES = [
  path.join(repoRoot, 'workers', 'tts-engine-neural', 'vd_tts_engine'),
  // OmniVoice (vd_omnivoice) omitted while its pack is disabled (see file header).
];

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.error(`error: engine source not found at ${src}`);
    process.exit(1);
  }
  const dest = path.join(destDir, path.basename(src));
  console.log(`==> Staging engine source: ${src} -> ${dest}`);
  // Copy the package, excluding caches/compiled files.
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => !s.includes('__pycache__') && !s.endsWith('.pyc'),
  });
  const staged = readdirSync(dest).filter((f) => f.endsWith('.py')).sort();
  console.log(`==> Staged ${path.basename(src)}: ${staged.join(', ')}`);
  if (staged.length === 0) {
    console.error(`error: no .py files staged for ${src}`);
    process.exit(1);
  }
}
