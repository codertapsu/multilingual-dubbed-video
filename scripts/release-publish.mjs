#!/usr/bin/env node
/**
 * scripts/release-publish.mjs — turn the finished draft into a published release,
 * with the one check that a browser tab cannot do for you.
 *
 * WHY THIS EXISTS: publishing was the last entirely-manual step of the release.
 * Both machines upload into the same draft, then the maintainer opened
 * github.com, eyeballed the asset list, wrote the notes and clicked "Publish
 * release". Clicking that button on a draft that is missing the Windows
 * installer — or, far worse, whose latest.json is missing a platform entry —
 * ships a broken auto-update to EVERY user at once and cannot be taken back:
 * clients resolve releases/latest, so the moment it is published it is what
 * everyone downloads. A latest.json without `windows-x86_64` is the nastiest
 * shape of that bug, because nothing looks wrong — the .exe is right there in the
 * asset list — those users simply never see an update again.
 *
 * So: this script re-runs scripts/release-status.mjs FIRST and refuses to publish
 * anything it reports as incomplete. That refusal is the entire point; publishing
 * itself is one PATCH.
 *
 * Usage:
 *   node scripts/release-publish.mjs                           # DRY RUN (default)
 *   node scripts/release-publish.mjs --notes-file NOTES.md     # still a dry run
 *   node scripts/release-publish.mjs --notes-file NOTES.md --yes
 *   node scripts/release-publish.mjs --tag v0.9.0 --prerelease --yes
 *
 * Flags:
 *   --tag vX.Y.Z      default: the version in tauri.conf.json
 *   --repo owner/name default: codertapsu/multilingual-dubbed-video
 *   --notes-file PATH release notes, read from a file (markdown)
 *   --notes "..."     release notes, inline
 *   --prerelease      publish as a pre-release (GitHub will not mark it "Latest")
 *   --yes             actually PATCH the release. Without it NOTHING is written.
 *
 * Notes are APPENDED under the download table that release-upload.{sh,ps1} seeds
 * from scripts/package/release-body-header.md. That table is the only thing
 * stopping a Mac user downloading the .app.tar.gz instead of the .dmg, so it is
 * never replaced — see composeBody() below.
 *
 * Auth: $GH_TOKEN, or the OAuth token from `git credential fill` — the same two
 * places scripts/package/release-upload.sh looks (release-upload.sh:39).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { arg, collectStatus, die, gh, githubToken, has, render, resolveTag } from './release-status.mjs';

const DEFAULT_REPO = 'codertapsu/multilingual-dubbed-video';

/**
 * The `---` that release-body-header.md ends with is the boundary between the
 * generated download table and the hand-written changelog. Splitting there means
 * this script is idempotent: re-running with corrected notes replaces the
 * changelog and leaves the table untouched, instead of stacking a second copy of
 * the notes (or, worse, overwriting the table).
 *
 * If a body has no such boundary — a release created by hand, or one whose header
 * was edited away — nothing is thrown away: the whole existing body is treated as
 * the header and the notes go underneath it, with a warning. Losing a maintainer's
 * hand-written body to a tidier merge rule is not a trade worth making.
 */
export function composeBody(existingBody, notes) {
  const body = existingBody ?? '';
  if (!notes) return { body, headerKept: true, warning: null };

  const lines = body.split('\n');
  const boundary = lines.findIndex((l) => l.trim() === '---');
  if (boundary === -1) {
    const warning = body.trim()
      ? 'the draft body has no `---` boundary from release-body-header.md; appending the notes below the whole existing body rather than replacing any of it'
      : null;
    const head = body.trim() ? `${body.trimEnd()}\n\n---\n` : '';
    return { body: `${head}\n${notes.trim()}\n`, headerKept: Boolean(body.trim()), warning };
  }
  const header = lines.slice(0, boundary + 1).join('\n');
  return { body: `${header}\n\n${notes.trim()}\n`, headerKept: true, warning: null };
}

/**
 * --notes-file wins over --notes; neither means "keep whatever the draft has".
 *
 * A relative path resolves against the CURRENT DIRECTORY, not the repo root. It
 * used to resolve against the repo root, which is the one resolution rule that can
 * publish the WRONG notes without erroring: run this from docs/ with a NOTES.md
 * beside you AND a stale NOTES.md at the root, and you silently ship the root one.
 * `--notes-file X` must mean the X the maintainer can see from where they typed it.
 */
function readNotes() {
  const file = arg('notes-file');
  if (file) {
    const resolved = path.resolve(process.cwd(), file);
    try {
      const text = readFileSync(resolved, 'utf8');
      if (!text.trim()) return die(`--notes-file is empty: ${resolved}`);
      return { text, source: resolved };
    } catch (e) {
      return die(`could not read --notes-file ${resolved}: ${e.message}`);
    }
  }
  const inline = arg('notes');
  if (inline?.trim()) return { text: inline, source: '--notes' };
  return null;
}

const USAGE = `usage: node scripts/release-publish.mjs [--tag vX.Y.Z] [--repo owner/name]
                                       [--notes-file PATH | --notes "..."]
                                       [--prerelease] [--yes]

Publishes the finished draft release. DRY RUN unless --yes is passed. Refuses to
publish a release that scripts/release-status.mjs reports as incomplete.`;

async function main() {
  if (has('help') || has('h')) {
    console.log(USAGE);
    return 0;
  }

  const repo = arg('repo', process.env.GH_REPO ?? DEFAULT_REPO);
  const tag = resolveTag();
  const token = githubToken();
  const apply = has('yes');
  const prerelease = has('prerelease');

  // --- 1. the gate. Never reordered: nothing below may run on a bad release. ---
  const status = await collectStatus({ token, repo, tag });
  console.log(render(status));
  console.log('');

  if (!status.found) {
    console.error(`error: no release exists for ${tag}. Build and upload first (pnpm release --sidecars --upload on each machine).`);
    return 1;
  }

  // "Verify the tag does not already exist as a PUBLISHED release" — if it is
  // already out, republishing is at best a no-op and at worst re-dates it.
  if (!status.draft) {
    console.log(`nothing to do: ${tag} is ALREADY PUBLISHED.`);
    console.log(`  ${status.htmlUrl}`);
    console.log('To ship a new build, bump the version (node scripts/check-versions.mjs --set X.Y.Z) and cut a new tag.');
    return 1;
  }

  if (!status.ready) {
    console.error('refusing to publish: the release is incomplete.');
    console.error('');
    console.error('Publishing now would ship this to every user at once, and it cannot be undone —');
    console.error('the updater resolves releases/latest, so a published release is immediately what');
    console.error('everyone downloads. A missing latest.json platform entry is the quiet version of');
    console.error('this bug: the installer is visible on the release and those users still never get');
    console.error('an update.');
    console.error('');
    console.error('Outstanding:');
    for (const item of status.outstanding) console.error(`  - ${item}`);
    return 1;
  }

  // --- 2. the body -----------------------------------------------------------
  const notes = readNotes();
  const composed = composeBody(status.bodyText ?? null, notes?.text ?? null);

  console.log('would publish:');
  console.log(`  repo          ${repo}`);
  console.log(`  tag           ${tag}   (release id ${status.releaseId})`);
  console.log(`  target        ${status.targetCommitish ?? '?'}  — publishing creates this git tag if it does not exist yet`);
  console.log(`  prerelease    ${prerelease}${prerelease ? '' : '  — GitHub will mark this release "Latest", which is what the updater resolves'}`);
  if (notes) {
    console.log(`  release notes ${notes.source}  (${notes.text.trim().length} chars, appended UNDER the download table)`);
    if (composed.warning) console.log(`  warning       ${composed.warning}`);
  } else {
    console.log(`  release notes (none given) — keeping the draft's existing body as-is, ${status.bodyLength} chars,`);
    console.log('                seeded from scripts/package/release-body-header.md. Pass --notes-file to add a changelog.');
  }

  if (notes) {
    console.log('');
    console.log('--- body that would be written ---');
    console.log(composed.body.length > 2000 ? `${composed.body.slice(0, 2000)}\n... (${composed.body.length} chars total)` : composed.body);
    console.log('--- end body ---');
  }

  // --- 3. write, but only on an explicit --yes -------------------------------
  if (!apply) {
    console.log('');
    console.log('DRY RUN — nothing was changed. Re-run with --yes to publish.');
    return 0;
  }

  const payload = { draft: false, prerelease };
  if (notes) payload.body = composed.body;
  const res = await gh(token, `https://api.github.com/repos/${repo}/releases/${status.releaseId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const published = await res.json();

  console.log('');
  console.log(`published ${tag}${prerelease ? ' (pre-release)' : ''}`);
  console.log(`  ${published.html_url}`);
  console.log('');
  console.log('Users on any older version will now be offered this build (the updater reads');
  console.log('releases/latest/download/latest.json). Verify once from a real install before');
  console.log('telling anyone.');
  console.log('');
  console.log('Old releases are ~1 GB each and nothing needs them once this is out:');
  console.log('  node scripts/package/prune-releases.mjs            # dry run, keeps the 2 newest');
  console.log('  node scripts/package/prune-releases.mjs --apply');
  return 0;
}

// Guarded the same way release-status.mjs is, so composeBody() can be imported
// and exercised without the import itself trying to publish something.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
