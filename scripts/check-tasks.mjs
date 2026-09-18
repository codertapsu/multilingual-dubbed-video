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

if (problems.length > 0) {
  console.error(`\ncheck-tasks: ${problems.length} cross-platform gap(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\ncheck-tasks: OK — ${rows.length} dispatched task(s), every one runnable on both OSes.`);
