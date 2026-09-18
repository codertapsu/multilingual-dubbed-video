#!/usr/bin/env node
/**
 * scripts/release-version.mjs — start a release cycle by bumping the app version
 * everywhere it is written, in ONE reviewable command.
 *
 *   pnpm release:version 0.10.0          # dry run: show the before/after table
 *   pnpm release:version minor --yes     # compute 0.10.0 from 0.9.0 and write it
 *
 * WHY THIS EXISTS
 * ---------------
 * The version lives in four manifests plus Cargo.lock, and a bump has always been
 * five hand-edits made under release pressure. scripts/check-versions.mjs exists
 * precisely because that has been done half-way before — but check-versions is the
 * smoke alarm, not the fire prevention. This is the thing you run instead of the
 * five edits.
 *
 * The expensive half-bump is specifically tauri.conf.json. release-upload.{sh,ps1}
 * derives the DRAFT TAG from tauri.conf.json's version, so if that file alone stays
 * stale the build succeeds, the deep-sign succeeds, the notarization succeeds — and
 * then this release's installers are uploaded onto the PREVIOUS release, on top of
 * assets users are already downloading. Nothing in that chain errors. You find out
 * from a user. The other direction is just as bad: bump tauri.conf.json only, and
 * the repo ships a build whose package.json lies about what it is, which is how the
 * next person mis-diagnoses a version bug.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not reimplement the writing. The four manifests are rewritten by
 * `node scripts/check-versions.mjs --set <ver>`, which already knows each file's
 * shape and already verifies every write by reading it back with the same reader
 * the check uses. This script adds the parts check-versions deliberately has no
 * opinion about: which version comes next, whether the tree is in a state where a
 * bump is reviewable, Cargo.lock, and a rollback if any of it fails.
 *
 * It does not commit, tag, build, or touch GitHub. A bump is a commit you write and
 * read; the release itself is the two-machine dance printed at the end.
 *
 * "ATOMIC ENOUGH"
 * ---------------
 * Five separate files cannot be written atomically without a transaction the
 * filesystem will not give us. So instead: snapshot all five in memory, do the
 * writes, then re-run the full consistency check — and if ANY step fails, restore
 * every snapshot before exiting non-zero. The failure mode this rules out is the
 * one that actually happened (a partially-bumped tree that nobody noticed), not a
 * power cut mid-write.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compose, don't duplicate: check-versions.mjs owns "where the version lives and
// how to read it out of each file". Importing is safe — it only calls main() when
// it is process.argv[1], which it is not here.
import { readVersions } from './check-versions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHECK_VERSIONS = path.join(HERE, 'check-versions.mjs');
const SRC_TAURI = path.join(ROOT, 'apps', 'desktop', 'src-tauri');
const CARGO_LOCK = path.join(SRC_TAURI, 'Cargo.lock');
const CRATE = 'videodubber-desktop';

const USAGE = `
release-version — bump the app version across every manifest, in one command.

  pnpm release:version <X.Y.Z | major | minor | patch> [flags]

  --yes               actually write. Without it this is a DRY RUN and the
                      working tree is not touched.
  --allow-dirty       bump even though the working tree has other changes.
  --allow-downgrade   allow a version LOWER than the current one.
  --help              this text.

Files rewritten:
  package.json
  apps/desktop/package.json
  apps/desktop/src-tauri/tauri.conf.json
  apps/desktop/src-tauri/Cargo.toml
  apps/desktop/src-tauri/Cargo.lock   (via \`cargo update --workspace --offline\`)
`.trimStart();

const die = (msg) => {
  console.error(`release-version: ${msg}`);
  process.exit(1);
};
const warn = (msg) => console.warn(`release-version: WARNING ${msg}`);

// --- arguments ---------------------------------------------------------------
// Deliberately strict about unknown flags. A typo'd `--yes` (`--y`, `-yes`) would
// otherwise be silently dropped and the run would look like a successful dry run,
// which is exactly the class of "it said it worked" this script is fighting.
const KNOWN_FLAGS = new Set(['--yes', '--allow-dirty', '--allow-downgrade', '--help', '-h']);
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('-'));
const positional = argv.filter((a) => !a.startsWith('-'));

for (const f of flags) if (!KNOWN_FLAGS.has(f)) die(`unknown flag ${f}\n\n${USAGE}`);
if (flags.includes('--help') || flags.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const APPLY = flags.includes('--yes');
const ALLOW_DIRTY = flags.includes('--allow-dirty');
const ALLOW_DOWNGRADE = flags.includes('--allow-downgrade');

if (positional.length === 0) die(`a version (or major/minor/patch) is required.\n\n${USAGE}`);
if (positional.length > 1) die(`expected one version, got ${positional.length}: ${positional.join(' ')}`);
const requested = positional[0];

// --- semver ------------------------------------------------------------------
// Strict on purpose, and deliberately NARROWER than semver proper: no build
// metadata (`+sha`). check-versions.mjs rejects it, Cargo.toml tolerates it, and
// WiX would choke on it — a version string that only three of the five files can
// hold is not a version this repo can ship.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parseSemver(v, what) {
  const m = SEMVER.exec(v ?? '');
  if (!m) {
    const hint = String(v).includes('+')
      ? ' (build metadata like "+sha" is not usable here — see the comment above SEMVER)'
      : '';
    die(`${what} "${v}" is not a strict semver version${hint}.`);
  }
  return {
    raw: v,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** Standard semver precedence, including the prerelease rules. */
function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  // 1.0.0-rc.1 < 1.0.0 — a version WITH a prerelease is lower than one without.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers rank below alphanumeric
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * `patch` on a prerelease RELEASES it (0.10.0-rc.1 -> 0.10.0) rather than going to
 * 0.10.1, matching `npm version`. Cutting rc.1 and then wanting the real 0.10.0 is
 * the only reason a prerelease would exist in this repo.
 */
function bumpFrom(cur, kind) {
  if (kind === 'major') return `${cur.major + 1}.0.0`;
  if (kind === 'minor') return `${cur.major}.${cur.minor + 1}.0`;
  if (cur.pre.length) return `${cur.major}.${cur.minor}.${cur.patch}`;
  return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
}

// --- read the current state ---------------------------------------------------
function readLockVersion(text) {
  // [[package]] blocks are `name = "..."` then `version = "..."`.
  return new RegExp(`name\\s*=\\s*"${CRATE}"\\s*\\nversion\\s*=\\s*"([^"]+)"`).exec(text)?.[1];
}

let manifests;
try {
  manifests = readVersions();
} catch (err) {
  die(`could not read the version manifests: ${err?.message ?? err}`);
}

let lockText;
try {
  lockText = readFileSync(CARGO_LOCK, 'utf8');
} catch (err) {
  die(
    `could not read ${path.relative(ROOT, CARGO_LOCK)}: ${err?.message ?? err}\n` +
      '  It is committed, so this means a broken checkout — restore it before bumping,\n' +
      '  otherwise the next cargo build writes a lockfile that never saw this version.',
  );
}
const rows = [
  ...manifests.map((m) => ({ file: m.file, before: m.version ?? '(unreadable)' })),
  { file: path.relative(ROOT, CARGO_LOCK), before: readLockVersion(lockText) ?? '(unreadable)' },
];

const distinct = [...new Set(manifests.map((m) => m.version))];
const INCONSISTENT = distinct.length > 1 || distinct[0] === undefined;
if (INCONSISTENT) {
  // The manifests already disagree — which is the very thing this script prevents,
  // so it has evidently been run too late. A bump still fixes it, but "the next
  // patch" of a repo with two current versions is a guess, so make the human say it.
  console.error('release-version: the manifests already DISAGREE about the current version:');
  for (const r of rows) console.error(`  ${r.before.padEnd(14)} ${r.file}`);
  if (['major', 'minor', 'patch'].includes(requested)) {
    die(`cannot compute "${requested}" from an inconsistent tree — pass an explicit X.Y.Z.`);
  }
  console.error('  (continuing: an explicit version was given, which will settle it)\n');
}

// The highest manifest version is "current" for the downgrade guard: if one file is
// stale, the release that actually shipped is the higher one, and that is what we
// must not go below.
const readable = manifests.filter((m) => m.version);
if (readable.length === 0) die('no manifest has a readable version — fix them by hand first.');
const current = readable
  .map((m) => parseSemver(m.version, `the version in ${m.file}`))
  .sort(compareSemver)
  .pop();

const target = ['major', 'minor', 'patch'].includes(requested)
  ? bumpFrom(current, requested)
  : requested;
const next = parseSemver(target, 'the requested version');

// --- guards -------------------------------------------------------------------
const cmp = compareSemver(next, current);
// "Already at X" is only true when EVERY manifest is at X. On an INCONSISTENT
// tree the highest manifest is usually the one file that ran ahead — a
// tauri.conf.json bumped alone, which is the exact incident in the header — and
// asking for that same version is the repair, not a no-op. Refusing it here said
// "nothing to bump" about a tree where four of the five files were stale.
if (cmp === 0 && !INCONSISTENT) die(`already at ${target}. Nothing to bump.`);
if (cmp < 0 && !ALLOW_DOWNGRADE) {
  die(
    `${target} is LOWER than the current ${current.raw}.\n` +
      '  Tauri\'s updater compares semver, so shipping a lower version strands every\n' +
      '  installed client — it will never see this release. Pass --allow-downgrade if\n' +
      '  you are certain (e.g. undoing a bump that was never released).' +
      (INCONSISTENT
        ? '\n  NOTE: the manifests disagree, so "current" here is the HIGHEST of them —\n' +
          '  which may well be the stale file you are trying to pull back into line.'
        : ''),
  );
}
if (next.pre.length) {
  warn(
    `${target} is a PRERELEASE and nothing in this repo has shipped one.\n` +
      '  The WiX MSI ProductVersion field only accepts X.Y.Z, so the Windows leg may\n' +
      '  refuse to bundle. Try it on Windows before relying on it.',
  );
}

let dirty = '';
try {
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  warn('`git status` failed (not a checkout, or git is unavailable) — clean-tree guard skipped.');
}
// A dry run writes nothing, so it still prints the table — you came here to see
// what the bump WOULD be, and being told only about an unrelated stray file is a
// worse answer than being told both. It still exits non-zero, so the blocker
// cannot be mistaken for approval.
const blockedByDirt = Boolean(dirty) && !ALLOW_DIRTY;
if (blockedByDirt) {
  console.error('release-version: the working tree is not clean:');
  const lines = dirty.split('\n');
  for (const line of lines.slice(0, 20)) console.error(`  ${line}`);
  if (lines.length > 20) console.error(`  ...and ${lines.length - 20} more`);
  console.error(
    '  A bump must be reviewable as its own diff — commit or stash first,\n' +
      '  or pass --allow-dirty if you really want it mixed in.',
  );
  if (APPLY) process.exit(1);
}

// --- the table ----------------------------------------------------------------
for (const r of rows) r.after = target;
const w0 = Math.max(...rows.map((r) => r.file.length), 'file'.length);
const w1 = Math.max(...rows.map((r) => r.before.length), 'before'.length);

console.log(
  cmp === 0
    ? `\n${APPLY ? 'Settling' : 'DRY RUN — would settle'} every manifest on ${target}` +
        ' (they disagree today)\n'
    : `\n${APPLY ? 'Bumping' : 'DRY RUN — would bump'} ${current.raw} -> ${target}\n`,
);
console.log(`  ${'file'.padEnd(w0)}  ${'before'.padEnd(w1)}  after`);
console.log(`  ${'-'.repeat(w0)}  ${'-'.repeat(w1)}  ${'-'.repeat(target.length)}`);
for (const r of rows) {
  const mark = r.before === r.after ? '  (already)' : '';
  console.log(`  ${r.file.padEnd(w0)}  ${r.before.padEnd(w1)}  ${r.after}${mark}`);
}
console.log(`\n  draft release tag this produces: v${target}`);

if (!APPLY) {
  console.log('\nNothing was written. Re-run with --yes to apply.');
  if (blockedByDirt) console.log('BLOCKED: the working tree is not clean (see above) — --yes would refuse.');
  process.exit(blockedByDirt ? 1 : 0);
}

// --- write, then prove it -----------------------------------------------------
const TOUCHED = [...manifests.map((m) => path.join(ROOT, m.file)), CARGO_LOCK];
const snapshot = new Map(TOUCHED.map((f) => [f, readFileSync(f, 'utf8')]));

function rollback(why) {
  console.error(`\nrelease-version: ${why}`);
  console.error('release-version: rolling back — restoring all five files to how they were.');
  for (const [file, text] of snapshot) {
    try {
      if (readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
    } catch (err) {
      console.error(`  COULD NOT RESTORE ${file}: ${err?.message ?? err}`);
      console.error(`  Restore it by hand:  git checkout -- ${path.relative(ROOT, file)}`);
    }
  }
  process.exit(1);
}

console.log('');
try {
  // Piped, not inherited: --set signs off with "now run a build so Cargo.lock
  // follows, then commit all five", which is true when you invoke it by hand and
  // a lie here — Cargo.lock is re-locked three lines below. Keep its per-file
  // confirmations (they are the receipt that each write was read back) and drop
  // the advice this script has already taken.
  // stdio must be spelled out: execFileSync's default forwards the child's stderr
  // straight to ours, so relying on the default AND printing err.stderr on failure
  // prints every error twice.
  const out = execFileSync(process.execPath, [CHECK_VERSIONS, '--set', target], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const line of out.split('\n')) if (line.startsWith('  set ')) console.log(line);
} catch (err) {
  if (err?.stdout) process.stdout.write(err.stdout);
  if (err?.stderr) process.stderr.write(err.stderr);
  rollback('check-versions --set failed (see above).');
}

/**
 * Cargo.lock carries the crate's own version too, and a stale one makes every
 * subsequent `cargo` invocation rewrite it — so it turns up as an unrelated line in
 * the NEXT commit's diff instead of this one's.
 *
 * `cargo update --workspace --offline` is the right tool: it re-locks only the
 * workspace members (measured: ~0.5s, and the diff is exactly the one `version =`
 * line), it needs no network, and it lets cargo own its own lockfile format. The
 * hand-edit below is a fallback for a machine without a cargo toolchain, and it
 * rewrites ONLY the `version` inside the `[[package]]` block whose `name` is the
 * crate — never a blanket replace, because ~4900 lines of this file are third-party
 * packages and several of them are also at 0.9.0.
 */
let lockMethod = '';
try {
  execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: SRC_TAURI, stdio: 'pipe' });
  lockMethod = 'cargo update --workspace --offline';
} catch (err) {
  warn(`cargo could not re-lock (${String(err?.message ?? err).split('\n')[0]}) — editing the [[package]] block directly.`);
}
const lockNow = readFileSync(CARGO_LOCK, 'utf8');
if (readLockVersion(lockNow) !== target) {
  const patched = lockNow.replace(
    new RegExp(`(name\\s*=\\s*"${CRATE}"\\s*\\nversion\\s*=\\s*")[^"]+(")`),
    `$1${target}$2`,
  );
  if (readLockVersion(patched) !== target) {
    rollback(`could not set ${CRATE} to ${target} in Cargo.lock.`);
  }
  writeFileSync(CARGO_LOCK, patched);
  lockMethod = lockMethod
    ? `${lockMethod} left it stale, so: hand-edited the [[package]] block`
    : 'hand-edited the [[package]] block';
}
console.log(`  set ${path.relative(ROOT, CARGO_LOCK)} -> ${target}  (${lockMethod})`);

// The command that bumps also proves the bump. Without this the script's own
// success message would be the only evidence, and that is precisely the assurance
// that failed us before.
console.log('');
try {
  execFileSync(process.execPath, [CHECK_VERSIONS], { cwd: ROOT, stdio: 'inherit' });
} catch {
  // Nothing to print: stdio was inherited, so check-versions has already said
  // exactly which files disagree.
  rollback('check-versions REJECTED the result — the bump did not land cleanly.');
}

console.log(`
Next steps
----------
  1. Review and commit the bump on its own:
       git diff
       git add -A && git commit -m "chore(release): v${target}"
       git push

  2. Build and upload from BOTH machines, in parallel. They create/join the SAME
     draft release v${target} and each merges its own entry into latest.json:

       macOS    pnpm release --sidecars --upload
       Windows  pnpm release -Sidecars -Upload
                (D:\\development\\projects\\multilingual-dubbed-video)

     macOS contributes 3 assets, Windows 4, plus the shared latest.json.

  3. Review the draft on github.com, write the release notes, and publish.
`);
