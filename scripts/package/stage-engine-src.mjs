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
 * (workers/tts-engine-omnivoice/vd_omnivoice is deliberately NOT staged: the
 * OmniVoice pack is disabled for releases pending output-quality work — see
 * docs/OMNIVOICE.md. Re-add it here when the pack is re-enabled.)
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
// vd_omnivoice intentionally absent while the pack is release-disabled (docs/OMNIVOICE.md).
const SOURCES = [
  path.join(repoRoot, 'workers', 'tts-engine-neural', 'vd_tts_engine'),
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
