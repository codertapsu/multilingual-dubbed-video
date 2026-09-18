#!/usr/bin/env node
/**
 * check-i18n.mjs — every translation key the UI asks for must exist in EVERY
 * shipped locale.
 *
 * WHY THIS EXISTS: a missing key is invisible at build time. Angular compiles
 * `{{ 'a.b.c' | translate }}` happily whether or not `a.b.c` is defined, and
 * TranslateService falls through to returning the KEY — so the failure mode is
 * a user staring at `settings.engines.title` in the middle of a screen. The
 * desktop app has no unit-test runner, so this script IS its test: it is wired
 * to `pnpm --filter videodubber-desktop test`.
 *
 * It reports three things, all of which are real defects:
 *   1. keys used by the UI but missing from a locale  -> renders a raw key
 *   2. keys defined in one locale but not the other   -> silent fallback
 *   3. keys defined but never used                    -> dead weight (warning)
 *
 * Usage:  node scripts/check-i18n.mjs [--unused]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'apps/desktop/src');
const I18N = path.join(SRC, 'i18n');

/** Every `.ts`/`.html` under the app, where translate keys can appear. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (/\.(ts|html)$/.test(entry) && !full.startsWith(I18N)) {
      out.push(full);
    }
  }
  return out;
}

/** Flatten a nested tree to dotted leaf keys. */
function flatten(tree, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

/**
 * Strip comments before scanning. Without this, a doc-comment EXAMPLE such as
 * `{{ 'queue.position' | translate }}` is reported as a key the UI uses and
 * fails the build — which it did, the first time this ran.
 */
function stripComments(text, isHtml) {
  if (isHtml) return text.replace(/<!--[\s\S]*?-->/g, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A plausible translation key: dotted, lowercase, no slashes. */
const KEY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * Collect every key feeding a `| translate`.
 *
 * Not a single regex: keys are chosen inline as often as they are written
 * literally — `(installing() ? 'update.installing' : 'update.install-now') |
 * translate` is two keys, and an adjacency-only match sees neither. So for each
 * pipe, walk BACK across the balanced expression that feeds it and take every
 * string literal inside.
 */
function keysFeedingPipes(text) {
  const found = new Set();
  const pipeRe = /\|\s*translate\b/g;
  let m;
  while ((m = pipeRe.exec(text)) !== null) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    let start;
    if (text[i] === ')') {
      let depth = 0;
      for (; i >= 0; i--) {
        if (text[i] === ')') depth++;
        else if (text[i] === '(') {
          depth--;
          if (depth === 0) break;
        }
      }
      start = i;
    } else {
      const quote = text[i];
      if (quote !== "'" && quote !== '"' && quote !== '`') continue;
      start = text.lastIndexOf(quote, i - 1);
      if (start < 0) continue;
    }
    const slice = text.slice(start, m.index);
    for (const lit of slice.matchAll(/['"`]([^'"`]+)['"`]/g)) {
      if (KEY_RE.test(lit[1])) found.add(lit[1]);
    }
  }
  return found;
}

/**
 * Prefixes whose leaves are chosen at runtime (a status enum picking
 * `status.completed`), so the static scan cannot see the individual keys.
 * Exempt from the "unused" report; still required in every locale.
 */
const DYNAMIC_KEY_PREFIXES = [
  'status.',
  'download.',
  'common.',
  'opt.',
  'whisper.',
  'svc.',
  'ducking-hint.',
  'speed-hint.',
  'misc.phase-',
  // The quality ladder and the provider list are both data-driven: their leaves
  // are chosen at runtime from a table, so the static scan cannot see them.
  'source-video.quality-',
  'source-video.provider.',
  'storage-loc.',
  'reason.',
  'capacity.',
];

/**
 * The mirror image of keysFeedingPipes: a string literal written DIRECTLY in
 * front of a `| translate` that is not a plausible key.
 *
 * WHY: TranslateService.instant returns the key itself on a miss, so a piped
 * literal that is not a key renders as raw English in every locale and looks
 * deliberate. That is how every status pill in the app printed 'Created' /
 * 'Running' / 'Completed' to a Vietnamese user while vi.json already had
 * status.created / status.running / status.completed — the miss is silent by
 * design, so nothing at runtime ever complains.
 *
 * SCOPE, honestly: this catches `{{ 'Cancel' | translate }}`, the direct form.
 * It does NOT catch the shape that caused the status-badge bug —
 * `{{ meta().label | translate }}`, where the English text lives in a
 * STATUS_META table three files away. Following that statically would mean
 * resolving the expression, and guessing would produce exactly the kind of false
 * positive the stripComments() comment above records the cost of. The table form
 * is a code fix (store keys in the table), not something a scanner can see.
 */
function nonKeyLiteralsFeedingPipes(text) {
  const found = new Set();
  const pipeRe = /\|\s*translate\b/g;
  let m;
  while ((m = pipeRe.exec(text)) !== null) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    // Only inspect a DIRECT string literal. An expression (`foo() | translate`,
    // `(a ? 'x.y' : 'x.z') | translate`) may legitimately hold non-key literals
    // in unrelated arguments, and flagging those would be a false positive —
    // the lesson the stripComments() comment above already records.
    const quote = text[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = text.lastIndexOf(quote, i - 1);
    if (start < 0) continue;
    const literal = text.slice(start + 1, i);
    // Interpolated template literals are expressions, not keys.
    if (quote === '`' && literal.includes('${')) continue;
    if (!KEY_RE.test(literal)) found.add(literal);
  }
  return found;
}

/** `instant('a.b')` in TypeScript. */
const CALL_RE = /\binstant\(\s*['"`]([^'"`]+)['"`]/g;

const locales = readdirSync(I18N)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

if (locales.length === 0) {
  console.error('check-i18n: no locale files found in', I18N);
  process.exit(1);
}

const trees = Object.fromEntries(
  locales.map((l) => [l, JSON.parse(readFileSync(path.join(I18N, `${l}.json`), 'utf8'))]),
);
const defined = Object.fromEntries(locales.map((l) => [l, flatten(trees[l])]));

const used = new Set();
/** file -> the non-key literals it pipes through `translate` (see check 0). */
const literalPipes = new Map();
for (const file of walk(path.join(SRC, 'app'))) {
  const text = stripComments(readFileSync(file, 'utf8'), file.endsWith('.html'));
  for (const k of keysFeedingPipes(text)) used.add(k);
  const bogus = nonKeyLiteralsFeedingPipes(text);
  if (bogus.size) literalPipes.set(path.relative(SRC, file), [...bogus].sort());
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text)) !== null) {
    if (KEY_RE.test(m[1])) used.add(m[1]);
  }
}

let failed = false;

// 0. Display text piped through `translate` — renders raw English in every
//    locale, and is the ONLY check here that would have caught the status-badge
//    bug (see nonKeyLiteralsFeedingPipes).
if (literalPipes.size) {
  failed = true;
  console.error(`\n✗ ${literalPipes.size} file(s) pipe a non-key string literal through | translate:`);
  for (const [file, lits] of [...literalPipes].sort()) {
    console.error(`    ${file}`);
    for (const l of lits) console.error(`      ${JSON.stringify(l)}`);
  }
  console.error('    Use a key ("status.created"), or drop the | translate.');
}

// 1. Used but undefined — the raw-key-on-screen bug.
for (const locale of locales) {
  const missing = [...used].filter((k) => !defined[locale].has(k)).sort();
  if (missing.length) {
    failed = true;
    console.error(`\n✗ ${locale}.json is missing ${missing.length} key(s) the UI uses:`);
    for (const k of missing) console.error(`    ${k}`);
  }
}

// 2. Defined in one locale but not another — a silent fallback to English, or
//    a Vietnamese-only string an English user never sees.
const union = new Set(locales.flatMap((l) => [...defined[l]]));
for (const locale of locales) {
  const gaps = [...union].filter((k) => !defined[locale].has(k)).sort();
  if (gaps.length) {
    failed = true;
    console.error(`\n✗ ${locale}.json is missing ${gaps.length} key(s) that other locales define:`);
    for (const k of gaps) console.error(`    ${k}`);
  }
}

// 2b. Placeholders must match across locales. `{{ version }}` in en and
//     `{{ v }}` in vi compiles fine and renders a literal "{{ v }}" to whoever
//     picked that language — invisible until a user in that locale hits it.
const placeholders = (s) =>
  [...String(s).matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
const leafOf = (tree, key) => key.split('.').reduce((c, k) => (c == null ? undefined : c[k]), tree);
const base = locales[0];
for (const locale of locales.slice(1)) {
  for (const key of defined[base]) {
    if (!defined[locale].has(key)) continue;
    const a = placeholders(leafOf(trees[base], key));
    const b = placeholders(leafOf(trees[locale], key));
    if (a !== b) {
      failed = true;
      console.error(`\n✗ ${key}: placeholders differ — ${base}[${a}] vs ${locale}[${b}]`);
    }
  }
}

// 3. Defined but unused — a warning, never a failure: a key may be referenced
//    in a way this scan cannot see, and failing the build on a false positive
//    would teach people to delete real strings.
if (process.argv.includes('--unused')) {
  const unused = [...(defined[locales[0]] ?? [])]
    .filter((k) => !used.has(k) && !DYNAMIC_KEY_PREFIXES.some((p) => k.startsWith(p)))
    .sort();
  if (unused.length) {
    console.warn(`\n⚠ ${unused.length} defined key(s) are never referenced:`);
    for (const k of unused) console.warn(`    ${k}`);
  }
}

if (failed) {
  console.error('\ncheck-i18n: FAILED');
  process.exit(1);
}
console.log(
  `check-i18n: ok — ${used.size} key(s) used, ${defined[locales[0]].size} defined, locales: ${locales.join(', ')}`,
);
