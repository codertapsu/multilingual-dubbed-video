#!/usr/bin/env node
/**
 * Validate the voice catalog snapshots (part of `pnpm check`).
 *
 * The app downloads and trusts exactly what these files say, so every rule here
 * is one a download or the library depends on:
 *   - ids are unique across ALL engines (a project stores only the id), and an
 *     id's prefix names its engine (`voiceEngineOfId` routes on it);
 *   - every file and preview is pinned: a commit revision in the URL, never a
 *     branch, plus a sha256 and a byte size the installer verifies;
 *   - every voice has a licence category and a label, because the library
 *     shows a badge on every item;
 *   - a destination path never escapes the voice's folder.
 *
 * Platform-neutral Node (no twins needed): it only reads JSON.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'packages/node-orchestrator/src/voices/catalog');

const ENGINES = new Set(['piper', 'vieneu-classic', 'vieneu', 'zerotts', 'kokoro', 'supertonic', 'voxcpm', 'openai']);
const CATEGORIES = new Set(['permissive', 'attribution', 'use-restricted', 'non-commercial', 'service-terms', 'unknown']);
const GENDERS = new Set(['female', 'male', 'neutral']);
const ACCENTS = new Set(['north', 'central', 'south']);

/** Mirror of shared `voiceEngineOfId` (kept in sync by the orchestrator test). */
function engineOfId(id) {
  if (id.startsWith('vieneu-v3-') || id.startsWith('vieneu-v2-')) return 'vieneu-classic';
  if (id.startsWith('vieneu38-')) return 'vieneu';
  for (const e of ['zerotts', 'kokoro', 'supertonic', 'voxcpm', 'openai']) if (id.startsWith(`${e}-`)) return e;
  return 'piper';
}

/** A Hugging Face or GitHub URL pinned to a 40-hex commit. */
const PINNED = /^https:\/\/(huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/|raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/|github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/)/;

export function checkCatalogs(catalogs) {
  const errors = [];
  const seen = new Map();
  for (const [file, catalog] of catalogs) {
    const where = (id, msg) => errors.push(`${file}: ${id ? `${id}: ` : ''}${msg}`);
    if (!ENGINES.has(catalog.engine)) where('', `unknown engine "${catalog.engine}"`);
    if (`${catalog.engine}.json` !== file) where('', `engine "${catalog.engine}" does not match the file name`);
    for (const s of catalog.sources ?? []) {
      if (!/^[0-9a-f]{40}$/.test(s.revision ?? '')) where('', `source ${s.repo} is not pinned to a commit`);
    }
    if (!Array.isArray(catalog.voices) || catalog.voices.length === 0) where('', 'has no voices');
    for (const v of catalog.voices ?? []) {
      const id = v.id ?? '?';
      if (!v.id || typeof v.id !== 'string') where('', 'a voice has no id');
      if (seen.has(id)) where(id, `duplicate id (also in ${seen.get(id)})`);
      seen.set(id, file);
      if (id.includes('#')) where(id, 'ids must not contain "#" (it separates a speaker index)');
      if (v.engine !== catalog.engine) where(id, `engine "${v.engine}" in a ${catalog.engine} catalog`);
      if (engineOfId(id) !== catalog.engine) where(id, `id prefix routes to "${engineOfId(id)}", not "${catalog.engine}"`);
      if (!v.name) where(id, 'no name');
      if (!Array.isArray(v.languages) || v.languages.length === 0) where(id, 'no languages');
      if (v.gender !== undefined && !GENDERS.has(v.gender)) where(id, `gender "${v.gender}"`);
      if (v.accent !== undefined && !ACCENTS.has(v.accent)) where(id, `accent "${v.accent}"`);
      if (!(v.sampleRate > 0)) where(id, 'no sample rate');
      if (!v.license || !CATEGORIES.has(v.license.category)) where(id, `licence category "${v.license?.category}"`);
      if (!v.license?.label) where(id, 'no licence label');
      if (!Array.isArray(v.files)) where(id, 'files must be an array');
      for (const f of v.files ?? []) {
        if (!PINNED.test(f.url ?? '')) where(id, `file URL is not pinned to a commit: ${f.url}`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) where(id, `file ${f.destPath} has no sha256`);
        if (!(f.bytes > 0)) where(id, `file ${f.destPath} has no size`);
        const dest = String(f.destPath ?? '');
        if (!dest || path.posix.isAbsolute(dest) || dest.split('/').includes('..') || dest.includes('\\')) {
          where(id, `destPath "${dest}" escapes the voice folder`);
        }
      }
      if (v.preview) {
        if (!PINNED.test(v.preview.url ?? '')) where(id, `preview URL is not pinned: ${v.preview.url}`);
        if (!/^[0-9a-f]{64}$/.test(v.preview.sha256 ?? '')) where(id, 'preview has no sha256');
        if (!(v.preview.bytes > 0)) where(id, 'preview has no size');
      }
      for (const s of v.speakers ?? []) {
        if (!Number.isInteger(s.index) || s.index < 0 || !s.name) where(id, `bad speaker ${JSON.stringify(s)}`);
      }
      if (v.replacedBy !== undefined && typeof v.replacedBy !== 'string') where(id, 'replacedBy must be a voice id');
    }
  }
  // A replacement must exist somewhere in the catalog.
  for (const [file, catalog] of catalogs) {
    for (const v of catalog.voices ?? []) {
      if (v.replacedBy && !seen.has(v.replacedBy)) errors.push(`${file}: ${v.id}: replacedBy "${v.replacedBy}" is not a voice`);
    }
  }
  return errors;
}

function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const catalogs = files.map((f) => [f, JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))]);
  const errors = checkCatalogs(catalogs);
  const voices = catalogs.reduce((n, [, c]) => n + (c.voices?.length ?? 0), 0);
  if (errors.length) {
    console.error(`check-voice-catalog: ${errors.length} problem(s) in ${files.length} catalogs:`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`check-voice-catalog: ${voices} voices in ${files.length} catalogs OK`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
