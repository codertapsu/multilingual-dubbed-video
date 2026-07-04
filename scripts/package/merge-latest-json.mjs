#!/usr/bin/env node
/**
 * merge-latest-json.mjs — build/merge the auto-updater manifest (`latest.json`)
 * on the GitHub draft release, one platform at a time. Cross-platform (plain
 * Node, REST only — no `gh` CLI), so the SAME tool runs on the Mac and the
 * Windows desktop; each machine merges ITS platform entry into whatever the
 * other already uploaded. Replaces the by-hand merge that v0.2.0 needed.
 *
 *   node scripts/package/merge-latest-json.mjs \
 *     --tag v0.3.0 \
 *     --platform windows-x86_64 \
 *     --artifact apps/desktop/src-tauri/target/release/bundle/nsis/VideoDubber_0.3.0_x64-setup.exe
 *
 * Platform keys the updater looks up (tauri.conf.json plugins.updater):
 *   darwin-aarch64  -> the notarize-repaired VideoDubber_<ver>_aarch64.app.tar.gz
 *   windows-x86_64  -> the NSIS VideoDubber_<ver>_x64-setup.exe
 *
 * What it does:
 *   1. Finds the release (draft or published) for --tag; with --fix-tag, repairs
 *      a tauri-action "untagged-<sha>" draft tag first (no target_commitish —
 *      that 422s when the git tag already exists).
 *   2. Downloads the release's current latest.json asset (if any) and MERGES —
 *      other platforms' entries are preserved.
 *   3. Sets platforms[--platform] = { signature: <contents of <artifact>.sig or
 *      --sig>, url: https://github.com/<repo>/releases/download/<tag>/<basename> }.
 *   4. Sets version (tag without the leading v), pub_date (now), and notes
 *      (--notes wins; else the existing notes survive).
 *   5. Uploads the merged latest.json (deleting the old asset) — idempotent.
 *
 * Auth: $GH_TOKEN, or the OAuth token from `git credential fill`.
 * Flags: --repo owner/name (default codertapsu/multilingual-dubbed-video),
 *        --sig <path>, --notes <text>, --fix-tag, --dry-run (print, no upload).
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

const repo = arg('repo', 'codertapsu/multilingual-dubbed-video');
const tag = arg('tag') ?? die('--tag vX.Y.Z is required');
const platform = arg('platform') ?? die('--platform is required (darwin-aarch64 | windows-x86_64)');
const artifact = arg('artifact') ?? die('--artifact <path> is required (the updater archive/installer)');
if (!/^v\d/.test(tag)) die(`--tag must look like v1.2.3 (got "${tag}")`);
if (!existsSync(artifact)) die(`artifact not found: ${artifact}`);

const sigPath = arg('sig', `${artifact}.sig`);
if (!existsSync(sigPath)) {
  die(`signature not found: ${sigPath} — did the build run with TAURI_SIGNING_PRIVATE_KEY set?`);
}
const signature = readFileSync(sigPath, 'utf8').trim();
if (!signature) die(`signature file is empty: ${sigPath}`);

function token() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  try {
    const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  die('no GitHub token (set GH_TOKEN, or sign in so `git credential` has one)');
}
const TOKEN = token();

const API = `https://api.github.com/repos/${repo}`;
async function gh(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res;
}

// --- 1. find the release (drafts included; the "list" endpoint sees drafts) ---
const releases = await (await gh(`${API}/releases?per_page=100`)).json();
let release = releases.find((r) => r.tag_name === tag);
if (!release && has('fix-tag')) {
  // A tauri-action draft may still carry the placeholder untagged-<sha> tag.
  const untagged = releases.filter((r) => r.draft && r.tag_name.startsWith('untagged-'));
  if (untagged.length === 1) {
    console.log(`fixing draft tag: ${untagged[0].tag_name} -> ${tag}`);
    await gh(`${API}/releases/${untagged[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ tag_name: tag }), // NO target_commitish (422 when the git tag exists)
      headers: { 'Content-Type': 'application/json' },
    });
    release = untagged[0];
  } else if (untagged.length > 1) {
    die(`--fix-tag: ${untagged.length} untagged drafts found — fix manually`);
  }
}
if (!release) die(`no release found for tag ${tag} (create the draft first: release-upload upload/ensure)`);
console.log(`release ${tag} -> id ${release.id}${release.draft ? ' (draft)' : ''}`);

// --- 2. fetch the existing latest.json (asset downloads on drafts need the API url + octet-stream) ---
const assets = await (await gh(`${API}/releases/${release.id}/assets?per_page=100`)).json();
const existing = assets.find((a) => a.name === 'latest.json');
let manifest = { version: '', notes: '', pub_date: '', platforms: {} };
if (existing) {
  const res = await gh(`${API}/releases/assets/${existing.id}`, {
    headers: { Accept: 'application/octet-stream' },
  });
  manifest = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  console.log(`merging into existing latest.json (platforms: ${Object.keys(manifest.platforms ?? {}).join(', ') || 'none'})`);
} else {
  console.log('no existing latest.json on the release — creating a fresh one');
}

// --- 3+4. upsert this platform's entry + top-level fields ---
const basename = path.basename(artifact);
manifest.platforms = manifest.platforms ?? {};
manifest.platforms[platform] = {
  signature,
  url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename)}`,
};
manifest.version = tag.replace(/^v/, '');
manifest.pub_date = new Date().toISOString();
const notes = arg('notes');
if (notes) manifest.notes = notes;
else if (!manifest.notes) manifest.notes = `VideoDubber ${manifest.version}`;

const body = `${JSON.stringify(manifest, null, 2)}\n`;
console.log(`\nmerged latest.json:\n${body}`);
if (has('dry-run')) { console.log('(dry-run: not uploaded)'); process.exit(0); }

// --- 5. replace the asset ---
if (existing) {
  await gh(`${API}/releases/assets/${existing.id}`, { method: 'DELETE' });
}
await gh(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=latest.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
console.log(`uploaded latest.json (${platform} entry set). Remember: the artifact itself (+ its .sig if you upload sigs as assets) must be on the same release, and the draft's tag must be ${tag} before publishing.`);
