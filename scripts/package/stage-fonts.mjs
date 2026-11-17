#!/usr/bin/env node
/**
 * Stage the subtitle font (and its licence) into the Tauri bundle resources.
 *
 * Burned-in subtitles are drawn by libass, which used to fall back to whatever
 * the system had: Arial at FFmpeg's default style on Windows, and on macOS
 * whatever fontconfig found. The media worker now ships Be Vietnam Pro
 * SemiBold (OFL, every Vietnamese letter; workers/media-worker/assets/fonts)
 * and hands libass its folder, so a dub looks the same on every machine. In a
 * source checkout it finds the folder itself; the packaged app finds it here
 * (resources/fonts, announced to the worker as VIDEODUBBER_FONTS_DIR by
 * sidecar.rs).
 *
 * The OFL text ships too (the licence requires it) but in resources/licenses,
 * NOT beside the font: libass tries to load every file in its fonts folder, and
 * the error it logged for the licence text masked the real reason whenever a
 * hardware encoder fell back to x264.
 *
 * Both are DECLARED Tauri resources, so this always runs: the bundle step
 * aborts on a missing declared resource.
 *
 * Run from anywhere: node scripts/package/stage-fonts.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const assets = path.join(repoRoot, 'workers', 'media-worker', 'assets');
const resources = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources');

const STAGE = [
  { from: path.join(assets, 'fonts', 'BeVietnamPro-SemiBold.ttf'), to: path.join(resources, 'fonts') },
  { from: path.join(assets, 'licenses', 'BeVietnamPro-OFL.txt'), to: path.join(resources, 'licenses') },
];

for (const { from } of STAGE) {
  if (!existsSync(from)) {
    console.error(`error: ${from} not found`);
    process.exit(1);
  }
}
for (const dir of new Set(STAGE.map((s) => s.to))) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
for (const { from, to } of STAGE) copyFileSync(from, path.join(to, path.basename(from)));
for (const dir of new Set(STAGE.map((s) => s.to))) {
  console.log(`==> Staged ${readdirSync(dir).sort().join(', ')} -> ${dir}`);
}
