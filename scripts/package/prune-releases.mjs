#!/usr/bin/env node
/**
 * prune-releases.mjs — keep only the N most recent published releases.
 *
 * Old releases are pure cost: every VideoDubber release carries ~600 MB-1.5 GB
 * of installers, and nothing needs the old ones. The updater always reads
 * `releases/latest/download/latest.json`, so a client on ANY version updates
 * straight to the newest — it never consults the release it is currently on.
 *
 *   node scripts/package/prune-releases.mjs            # dry run, keeps 2
 *   node scripts/package/prune-releases.mjs --apply
 *   node scripts/package/prune-releases.mjs --keep 3 --apply
 *
 * Deliberate choices:
 *   - DRY RUN BY DEFAULT. Deleting a release is irreversible, so it takes an
 *     explicit --apply.
 *   - DRAFTS ARE NEVER TOUCHED. A draft is usually the release being assembled
 *     right now; deleting it would destroy in-flight work.
 *   - THE `latest` RELEASE IS NEVER TOUCHED, even if the ordering says
 *     otherwise — deleting it would break auto-update for every user.
 *   - GIT TAGS ARE KEPT. They cost nothing and are how you check out or diff
 *     the source a shipped build came from. Deleting the release removes the
 *     binaries; deleting the tag would throw away the history too. Pass
 *     --tags to remove them as well, if you really want that.
 *
 * Auth: $GH_TOKEN, or the OAuth token from `git credential fill`.
 */
import { execSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const REPO = arg('repo', 'codertapsu/multilingual-dubbed-video');
const KEEP = Math.max(1, Number.parseInt(arg('keep', '2'), 10) || 2);
const APPLY = has('apply');
const DROP_TAGS = has('tags');

function token() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) {
    console.error('error: no GitHub token (set GH_TOKEN, or sign in so `git credential` has one)');
    process.exit(1);
  }
  return m[1].trim();
}
const TOKEN = token();
const API = `https://api.github.com/repos/${REPO}`;

async function gh(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res;
}

const releases = await (await gh(`${API}/releases?per_page=100`)).json();
const latestTag = await (await gh(`${API}/releases/latest`)).json().then((r) => r.tag_name).catch(() => null);

const published = releases
  .filter((r) => !r.draft)
  .sort((a, b) => new Date(b.published_at ?? 0) - new Date(a.published_at ?? 0));

const keep = new Set(published.slice(0, KEEP).map((r) => r.id));
if (latestTag) {
  const l = published.find((r) => r.tag_name === latestTag);
  if (l) keep.add(l.id); // never prune what the updater resolves to
}
const drafts = releases.filter((r) => r.draft);
const doomed = published.filter((r) => !keep.has(r.id));

console.log(`repo: ${REPO} | keeping the ${KEEP} newest published release(s)` + (latestTag ? ` + '${latestTag}' (latest)` : ''));
for (const r of published) {
  const size = (r.assets ?? []).reduce((a, x) => a + x.size, 0);
  const dl = (r.assets ?? []).reduce((a, x) => a + x.download_count, 0);
  const mark = keep.has(r.id) ? 'KEEP  ' : 'DELETE';
  console.log(`  ${mark} ${r.tag_name.padEnd(9)} ${(size / 1e6).toFixed(0).padStart(5)} MB  ${String(dl).padStart(5)} downloads  ${String(r.published_at).slice(0, 10)}`);
}
for (const r of drafts) console.log(`  SKIP   ${r.tag_name.padEnd(9)} (draft — never pruned)`);

if (doomed.length === 0) {
  console.log('\nnothing to prune.');
  process.exit(0);
}
const freed = doomed.reduce((a, r) => a + (r.assets ?? []).reduce((b, x) => b + x.size, 0), 0);
console.log(`\n${doomed.length} release(s) to delete, freeing ~${(freed / 1e9).toFixed(2)} GB.`);

if (!APPLY) {
  console.log('(dry run — re-run with --apply to delete)');
  process.exit(0);
}

for (const r of doomed) {
  await gh(`${API}/releases/${r.id}`, { method: 'DELETE' });
  console.log(`  deleted release ${r.tag_name}`);
  if (DROP_TAGS) {
    try {
      await gh(`${API}/git/refs/tags/${r.tag_name}`, { method: 'DELETE' });
      console.log(`  deleted tag     ${r.tag_name}`);
    } catch (e) {
      console.log(`  (tag ${r.tag_name} not deleted: ${e.message.slice(0, 80)})`);
    }
  }
}
console.log('\ndone. Installers for the pruned versions are gone; the updater is unaffected —');
console.log('it always resolves releases/latest, so clients on any version still update to the newest.');
