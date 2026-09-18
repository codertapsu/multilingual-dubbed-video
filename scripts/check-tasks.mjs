#!/usr/bin/env node
/**
 * scripts/check-tasks.mjs — every dispatched task must have BOTH shell twins.
 *
 * WHY THIS EXISTS: package.json used to invoke `bash scripts/<task>.sh` directly, so
 * `pnpm dev`, `pnpm start`, `pnpm stop`, `pnpm services`, `pnpm dev:workers` and
 * `pnpm package:sidecars` all failed on Windows — even though a `.ps1` twin sat right
 * next to every one of those `.sh` files. The scripts were fine; the wiring was not,
 * and no test could see it because nothing ever asserted the pair was complete.
 *
 * Tasks now route through scripts/run.mjs, which picks the twin for the host OS. That
 * moves the failure from "wrong on Windows forever" to "missing at runtime on one OS",
 * which is better but still only discovered by a contributor on that OS. This closes it:
 * adding a one-sided task fails `pnpm check` on any machine.
 *
 * Genuinely single-platform tasks are declared in PLATFORM_ONLY below, with a reason.
 * That list is the point — an exception has to be argued for in writing, once.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tasks that legitimately exist for one OS only. Key is the task path as written in
 * package.json; the value is why, and is printed when the task is skipped.
 */
const PLATFORM_ONLY = {
  'package/dmg-add-instructions':
    'posix: builds the .dmg Finder layout — a macOS disk-image concept with no Windows analogue',
};

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

const problems = [];
const rows = [];

for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
  const match = /^node\s+scripts\/run\.mjs\s+([^\s]+)/.exec(body);
  if (!match) continue;
  const task = match[1];

  const sh = join(REPO_ROOT, 'scripts', `${task}.sh`);
  const ps1 = join(REPO_ROOT, 'scripts', `${task}.ps1`);
  const hasSh = existsSync(sh);
  const hasPs1 = existsSync(ps1);

  const exception = PLATFORM_ONLY[task];
  let status;

  if (hasSh && hasPs1) {
    status = 'both';
  } else if (exception && ((hasSh && exception.startsWith('posix')) || (hasPs1 && exception.startsWith('windows')))) {
    status = 'single (declared)';
  } else if (!hasSh && !hasPs1) {
    status = 'MISSING BOTH';
    problems.push(`${name} -> scripts/${task}.{sh,ps1}: neither implementation exists`);
  } else {
    status = hasSh ? 'MISSING .ps1' : 'MISSING .sh';
    const missing = hasSh ? `${task}.ps1` : `${task}.sh`;
    const os = hasSh ? 'Windows' : 'macOS/Linux';
    problems.push(
      `${name} -> scripts/${missing} is missing, so \`pnpm ${name}\` fails on ${os}. ` +
        `Write the twin, or declare it in PLATFORM_ONLY in scripts/check-tasks.mjs with a reason.`,
    );
  }
  rows.push({ name, task, status });
}

const width = Math.max(...rows.map((r) => r.name.length), 4);
for (const r of rows) {
  const flag = r.status.startsWith('MISSING') ? '✗' : '·';
  console.log(`  ${flag} ${r.name.padEnd(width)}  ${r.task.padEnd(30)} ${r.status}`);
}

/**
 * Every .ps1 must be pure ASCII.
 *
 * WHY: a .ps1 with no byte-order mark is decoded by PowerShell using the host's
 * ANSI codepage, not UTF-8. A UTF-8 em dash (E2 80 94) therefore arrives as three
 * Windows-1252 characters, and where that lands inside a quoted string the parser
 * loses the string terminator and cascades into dozens of bogus errors far from
 * the real one. This shipped: 123 em dashes across 15 scripts, and the Windows box
 * could not parse bootstrap.ps1, diagnose-llama-engine.ps1, setup-local-models.ps1,
 * build-orchestrator.ps1 or build-workers.ps1 at all.
 *
 * ASCII rather than adding a BOM, deliberately. A BOM fixes PARSING but not OUTPUT:
 * these scripts print a lot of user-facing text, and an em dash written to a console
 * running codepage 437 or 850 is still mojibake. ASCII is correct at both ends.
 *
 * macOS and Linux decode UTF-8 fine, so nothing on the authoring machine ever
 * notices — which is exactly why this needs to be a check and not a convention.
 */
// Positive match on the high range. A negated \u0000-\u007F class would be
// equivalent but trips eslint's no-control-regex.
const NON_ASCII = /[\u0080-\uFFFF]/g;
let psFiles;
try {
  psFiles = execFileSync('git', ['ls-files', '*.ps1'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  // Not a git checkout (a release tarball, say). The twin check above still ran.
  psFiles = [];
}

for (const rel of psFiles) {
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const found = [...new Set(text.match(NON_ASCII) ?? [])];
  if (found.length === 0) continue;
  const shown = found
    .slice(0, 6)
    .map((c) => `${JSON.stringify(c)} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ');
  problems.push(
    `${rel} contains non-ASCII characters: ${shown}. PowerShell reads a BOM-less .ps1 in the ` +
      `host's ANSI codepage, so these break the parse on Windows and render as mojibake in ` +
      `console output. Use an ASCII equivalent (- for an em dash, ... for an ellipsis).`,
  );
}

if (problems.length > 0) {
  console.error(`\ncheck-tasks: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `\ncheck-tasks: OK - ${rows.length} dispatched task(s) runnable on both OSes; ` +
    `${psFiles.length} .ps1 file(s) pure ASCII.`,
);
