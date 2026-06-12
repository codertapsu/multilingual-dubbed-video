#!/usr/bin/env node
/**
 * Print the pinned Python requirements for a uv engine pack, one per line, so CI
 * (the VieNeu smoke test) installs the EXACT same set the app would.
 *
 * SINGLE SOURCE OF TRUTH: the pins live in
 * `packages/node-orchestrator/src/engines/uvRequirements.ts`. We parse them out
 * (line-based, tolerant of our own formatting) rather than duplicating them, and
 * fail loudly if the pack or its `base` array can't be found — so a refactor that
 * breaks the parse surfaces as a red CI step, not a silently empty install.
 *
 * Usage: node scripts/print-uv-requirements.mjs <packId>
 *   e.g. node scripts/print-uv-requirements.mjs tts-neural
 *
 * Limitation: only the platform-independent `base` set is emitted. If a pack
 * grows a `perPlatform` overlay, this script errors (so it gets updated) rather
 * than under-installing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packId = process.argv[2];
if (!packId) {
  console.error('usage: node scripts/print-uv-requirements.mjs <packId>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(here, '../packages/node-orchestrator/src/engines/uvRequirements.ts');
const lines = readFileSync(srcPath, 'utf8').split(/\r?\n/);

// Find the pack's block: `  '<packId>': {` … up to the next 2-indent pack key.
const startRe = new RegExp(`^\\s*['"]${packId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]\\s*:\\s*\\{`);
const startIdx = lines.findIndex((l) => startRe.test(l));
if (startIdx === -1) {
  console.error(`error: pack "${packId}" not found in ${srcPath}`);
  process.exit(1);
}
const nextPackRe = /^\s{2}['"][\w-]+['"]\s*:\s*\{/;
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (nextPackRe.test(lines[i]) || /^\};/.test(lines[i])) {
    endIdx = i;
    break;
  }
}
const block = lines.slice(startIdx, endIdx);

if (block.some((l) => /\bperPlatform\b/.test(l))) {
  console.error(`error: pack "${packId}" has a perPlatform overlay this extractor doesn't handle — update scripts/print-uv-requirements.mjs`);
  process.exit(1);
}

// Collect the strings inside the first `base: [ … ]`.
const baseStart = block.findIndex((l) => /\bbase\s*:\s*\[/.test(l));
if (baseStart === -1) {
  console.error(`error: no base[] for pack "${packId}"`);
  process.exit(1);
}
const reqs = [];
for (let i = baseStart; i < block.length; i++) {
  for (const m of block[i].matchAll(/['"]([^'"]+)['"]/g)) reqs.push(m[1]);
  if (i > baseStart && /\]/.test(block[i])) break;
  if (i === baseStart && /\].*$/.test(block[i].replace(/\bbase\s*:\s*\[/, ''))) break;
}
if (reqs.length === 0) {
  console.error(`error: empty base[] for pack "${packId}"`);
  process.exit(1);
}
process.stdout.write(reqs.join('\n') + '\n');
