#!/usr/bin/env node
/**
 * scripts/release-status.mjs — "where is this release up to, and what is still
 * missing?", answered read-only in a couple of seconds.
 *
 * WHY THIS EXISTS: since 2026-07-04 a release is built on TWO machines at once
 * (this Mac, arm64 only; a separate Windows box at D:\development\projects\
 * multilingual-dubbed-video) and both upload into the SAME GitHub draft. Neither
 * machine can see the other's progress. Up to now the only way to answer "is
 * Windows done yet?" was to keep a browser tab on the draft and count assets by
 * eye — against a filename convention where the .dmg legitimately has no .sig and
 * the .app.tar.gz legitimately does, so "8 files" is the only correct answer and
 * "7 files" tells you nothing about WHICH one is absent.
 *
 * It is written in plain Node, not as a .sh/.ps1 twin, on purpose. The BUILD half
 * of a release is genuinely platform-specific and stays in twins; COORDINATION is
 * not, and two implementations of it would drift. scripts/check-tasks.mjs only
 * demands twins for tasks routed through run.mjs, so `pnpm release:status` ->
 * `node scripts/release-status.mjs` needs none.
 *
 * Usage:
 *   node scripts/release-status.mjs                 # tag from tauri.conf.json
 *   node scripts/release-status.mjs --tag v0.8.1
 *   node scripts/release-status.mjs --json          # machine-readable
 *   node scripts/release-status.mjs --repo owner/name
 *
 * Exit code: 0 when the release is COMPLETE (every asset present, latest.json
 * carrying all three platform keys at the right version), non-zero otherwise —
 * so it can gate a script. scripts/release-publish.mjs imports this module and
 * refuses to publish anything that would exit non-zero here.
 *
 * Read-only. It performs GETs and nothing else.
 *
 * Auth: $GH_TOKEN, or the OAuth token from `git credential fill` — the same two
 * places scripts/package/release-upload.sh looks (release-upload.sh:39), so if
 * uploading works, this works.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// eslint.config.mjs enumerates the Node globals available to plain .mjs files and
// `fetch` is not in that list (it predates Node's global fetch), so `no-undef`
// rejects a bare call. Reach it through globalThis rather than adding an inline
// /* global */ pragma that the next reader has to decode. Same trick in
// release-publish.mjs, which imports the helpers below.
const httpFetch = globalThis.fetch;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const DEFAULT_REPO = 'codertapsu/multilingual-dubbed-video';

/**
 * The three platform keys the Tauri updater looks up (tauri.conf.json
 * plugins.updater). `windows-x86_64-msi` exists because an MSI-installed user
 * cannot be updated by an NSIS payload, so the MSI gets its own target.
 */
export const PLATFORM_KEYS = ['darwin-aarch64', 'windows-x86_64', 'windows-x86_64-msi'];

/**
 * The canonical asset set, grouped by the MACHINE that produces it — which is the
 * real unit of work here, since the two boxes finish at different times.
 *
 * Verified against the live v0.9.0 draft and the published v0.8.1 / v0.8.0 /
 * v0.7.1 / v0.7.0: every one carries exactly these eight files.
 *
 * NOTE the .dmg has NO .sig and that is CORRECT — the updater installs the
 * .app.tar.gz, never the disk image (see release-body-header.md, which exists
 * because users kept downloading the .app.tar.gz by mistake). Do not "fix" it by
 * adding a signature row here; you will make every complete release look broken.
 */
export const MACHINES = [
  {
    name: 'macOS',
    detail: 'this Mac — build, deep-sign, notarize, staple',
    assets: [
      { suffix: '_aarch64.app.tar.gz', note: 'updater payload' },
      { suffix: '_aarch64.app.tar.gz.sig', note: 'updater signature' },
      { suffix: '_aarch64.dmg', note: 'installer (no .sig by design)' },
    ],
  },
  {
    name: 'Windows',
    detail: 'the Windows box — installer is UNSIGNED by standing decision',
    assets: [
      { suffix: '_x64-setup.exe', note: 'NSIS installer' },
      { suffix: '_x64-setup.exe.sig', note: 'updater signature' },
      { suffix: '_x64_en-US.msi', note: 'MSI installer' },
      { suffix: '_x64_en-US.msi.sig', note: 'updater signature' },
    ],
  },
];

/** latest.json is the one asset BOTH machines write, via merge-latest-json.mjs. */
export const SHARED_ASSET = 'latest.json';

// --- small helpers -----------------------------------------------------------

/**
 * Value of `--name`, or `fallback` when the flag is absent.
 *
 * A flag that IS present must be followed by a value, and that value may not look
 * like another flag. Without this guard `--notes-file` typed with the filename
 * forgotten yields `undefined`, readNotes() falls through to "no notes given", and
 * `--yes` publishes the release with an empty changelog — permanently, with no
 * error anywhere. `--tag` with the value forgotten is the same shape: it silently
 * falls back to tauri.conf.json and reports on a DIFFERENT release than the one you
 * asked about. Both are cheap to make impossible, so make them impossible.
 */
export const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    return die(`--${name} needs a value (got ${value === undefined ? 'nothing' : `"${value}"`})`);
  }
  return value;
};
export const has = (name) => process.argv.includes(`--${name}`);
export const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(2);
};

/** Human-readable byte size, so "still building" vs "uploaded a stub" is visible. */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

/**
 * The token, found exactly the way scripts/package/release-upload.sh finds one
 * (release-upload.sh:39): $GH_TOKEN, else `git credential fill`. `gh` is NOT
 * installed on either release machine, which is why everything here is raw REST.
 *
 * Never printed, never echoed into an error message.
 */
export function githubToken() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = out.match(/^password=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {
    /* fall through to the instruction below */
  }
  return die('no GitHub token (set GH_TOKEN, or sign in so `git credential` has one)');
}

/** Minimal authenticated REST wrapper. Throws with the response body attached. */
export async function gh(token, url, init = {}) {
  const res = await httpFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res;
}

/** The tag being released, unless overridden: --tag, else $RELEASE_TAG, else tauri.conf.json. */
export function resolveTag(explicit = arg('tag') ?? process.env.RELEASE_TAG) {
  let tag = explicit;
  if (!tag) {
    try {
      tag = `v${JSON.parse(readFileSync(CONF, 'utf8')).version}`;
    } catch (e) {
      return die(`could not read the version from ${CONF} (${e.message}); pass --tag vX.Y.Z`);
    }
  }
  tag = String(tag).trim();
  if (/^\d/.test(tag)) tag = `v${tag}`; // tolerate `--tag 0.9.0`
  if (!/^v\d+\.\d+\.\d+/.test(tag)) return die(`--tag must look like v1.2.3 (got "${tag}")`);
  return tag;
}

/**
 * Download a release asset's CONTENT.
 *
 * THIS IS THE NON-OBVIOUS PART. `GET /releases/assets/:id` with the ordinary
 * `Accept: application/vnd.github+json` returns the asset's METADATA (name, size,
 * a browser_download_url) — not its bytes. You must ask for
 * `Accept: application/octet-stream`, which answers 302 to a signed object-store
 * URL. And it must be the API url: a draft's browser_download_url 404s for
 * everyone, including the owner, because the release is not public yet — which is
 * precisely the case we care about, since we read latest.json off the DRAFT.
 *
 * The 302 is cross-origin (api.github.com -> objects.githubusercontent.com) and
 * undici strips Authorization across origins on its own, so the signed URL is not
 * handed our token. Do not "help" by following the redirect manually with the
 * header attached — the store answers 400 to a request carrying both.
 */
export async function fetchAssetText(token, repo, assetId) {
  const res = await gh(token, `https://api.github.com/repos/${repo}/releases/assets/${assetId}`, {
    headers: { Accept: 'application/octet-stream' },
  });
  return Buffer.from(await res.arrayBuffer()).toString('utf8');
}

// --- the actual status collection -------------------------------------------

/**
 * Gather everything, read-only. Returns a plain object; `render` below turns it
 * into text and `release-publish.mjs` consumes the object directly.
 */
export async function collectStatus({ token, repo, tag }) {
  const api = `https://api.github.com/repos/${repo}`;
  const version = tag.replace(/^v/, '');

  // The list endpoint is the one that can see DRAFTS; /releases/tags/:tag cannot.
  const releases = await (await gh(token, `${api}/releases?per_page=100`)).json();
  const release = releases.find((r) => r.tag_name === tag);

  const status = {
    repo,
    tag,
    version,
    found: Boolean(release),
    releaseId: release?.id ?? null,
    draft: release?.draft ?? null,
    prerelease: release?.prerelease ?? null,
    htmlUrl: release?.html_url ?? null,
    targetCommitish: release?.target_commitish ?? null,
    // The publish script needs the body VERBATIM: it appends the changelog under
    // the download table release-upload.{sh,ps1} seeded, never over it.
    bodyText: release?.body ?? null,
    bodyLength: (release?.body ?? '').length,
    machines: [],
    shared: { name: SHARED_ASSET, present: false, size: 0 },
    latestJson: null,
    outstanding: [],
    ready: false,
  };

  if (!release) {
    status.outstanding.push(`no release exists for ${tag} — nothing has been uploaded yet (release-upload ensure/upload creates the draft)`);
    return status;
  }

  // Assets come back on the release object, but paginate the dedicated endpoint
  // anyway: a release with >30 assets would silently truncate on the embedded list.
  const assets = await (await gh(token, `${api}/releases/${release.id}/assets?per_page=100`)).json();
  const byName = new Map(assets.map((a) => [a.name, a]));

  for (const machine of MACHINES) {
    const rows = machine.assets.map(({ suffix, note }) => {
      const name = `VideoDubber_${version}${suffix}`;
      const asset = byName.get(name);
      return { name, note, present: Boolean(asset), size: asset?.size ?? 0, id: asset?.id ?? null };
    });
    const missing = rows.filter((r) => !r.present);
    status.machines.push({ name: machine.name, detail: machine.detail, rows, complete: missing.length === 0 });
    if (missing.length) {
      status.outstanding.push(`${machine.name}: ${missing.length}/${rows.length} asset(s) missing (${missing.map((r) => r.name).join(', ')})`);
    }
  }

  const sharedAsset = byName.get(SHARED_ASSET);
  status.shared = { name: SHARED_ASSET, present: Boolean(sharedAsset), size: sharedAsset?.size ?? 0 };

  if (!sharedAsset) {
    status.outstanding.push('latest.json is absent — NO platform can auto-update (run merge-latest-json.mjs on each machine)');
  } else {
    // A manifest that parses but lacks a platform entry is the dangerous case: the
    // installer is sitting right there on the release and those users still get
    // told "no update available", forever, silently.
    let manifest = null;
    let parseError = null;
    try {
      manifest = JSON.parse(await fetchAssetText(token, repo, sharedAsset.id));
    } catch (e) {
      parseError = e.message;
    }
    if (!manifest) {
      status.latestJson = { parseError };
      status.outstanding.push(`latest.json could not be read/parsed (${parseError})`);
    } else {
      const platforms = manifest.platforms ?? {};
      const present = PLATFORM_KEYS.filter((k) => platforms[k]?.url && platforms[k]?.signature);
      const missing = PLATFORM_KEYS.filter((k) => !present.includes(k));
      // Every url must point at an asset that is actually ON this release, or the
      // updater downloads a 404 and the failure surfaces to the user as a broken app.
      const dangling = present.filter((k) => {
        const base = decodeURIComponent(platforms[k].url.split('/').pop() ?? '');
        return !byName.has(base);
      });
      status.latestJson = {
        version: manifest.version ?? null,
        versionMatches: manifest.version === version,
        pubDate: manifest.pub_date ?? null,
        present,
        missing,
        dangling,
        extra: Object.keys(platforms).filter((k) => !PLATFORM_KEYS.includes(k)),
        parseError: null,
      };
      if (missing.length) {
        status.outstanding.push(`latest.json is missing platform entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')} — those users would get NO update`);
      }
      if (!status.latestJson.versionMatches) {
        status.outstanding.push(`latest.json says version "${manifest.version}" but the tag is ${tag} — the updater compares this field`);
      }
      for (const k of dangling) {
        status.outstanding.push(`latest.json[${k}].url points at a file that is not on this release — the update would 404`);
      }
    }
  }

  status.ready = status.outstanding.length === 0;
  return status;
}

// --- rendering ---------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);

export function render(status) {
  const out = [];
  out.push(`release status: ${status.tag}   ${dim(`(${status.repo})`)}`);

  if (!status.found) {
    out.push('');
    out.push(`  ${red('no release found for this tag')} — neither machine has uploaded anything yet.`);
    out.push('');
    out.push(`verdict: ${red('NOT READY')} — ${status.outstanding[0]}`);
    return out.join('\n');
  }

  const state = status.draft ? yellow('DRAFT') : green('PUBLISHED');
  out.push(`  release id ${status.releaseId}  state ${state}${status.prerelease ? yellow(' (pre-release)') : ''}  target ${status.targetCommitish ?? '?'}`);
  out.push(`  ${dim(status.htmlUrl ?? '')}`);
  // An unpublished draft has no git tag yet, so GitHub gives it a placeholder
  // `untagged-<sha>` web URL even though tag_name is already correct. Say so, or
  // it reads like the draft was created against the wrong tag.
  if (status.draft && /untagged-/.test(status.htmlUrl ?? '')) {
    out.push(`  ${dim('(the untagged-… url is normal: the git tag is only created when the draft is published)')}`);
  }

  for (const machine of status.machines) {
    const done = machine.rows.filter((r) => r.present).length;
    const head = machine.complete ? green('complete') : yellow(`${done}/${machine.rows.length}`);
    out.push('');
    out.push(`  ${machine.name} (${machine.rows.length} assets) — ${head}   ${dim(machine.detail)}`);
    for (const row of machine.rows) {
      const mark = row.present ? green('[ok]     ') : red('[MISSING]');
      const size = row.present ? humanSize(row.size).padStart(9) : '        -';
      out.push(`    ${mark} ${size}  ${row.name}  ${dim(row.note)}`);
    }
  }

  out.push('');
  const lj = status.latestJson;
  if (!status.shared.present) {
    out.push(`  latest.json — ${red('[MISSING]')} shared manifest; no platform can auto-update`);
  } else if (!lj || lj.parseError) {
    out.push(`  latest.json — ${red('[UNREADABLE]')} ${lj?.parseError ?? ''}`);
  } else {
    const versionMark = lj.versionMatches ? green(lj.version) : red(`${lj.version} != ${status.version}`);
    out.push(`  latest.json (${humanSize(status.shared.size)}) — version ${versionMark}  ${dim(`pub_date ${lj.pubDate ?? '?'}`)}`);
    for (const key of PLATFORM_KEYS) {
      const ok = lj.present.includes(key);
      const flag = lj.dangling.includes(key) ? red('[DANGLING URL]') : ok ? green('[ok]     ') : red('[MISSING]');
      out.push(`    ${flag} ${key}`);
    }
    for (const key of lj.extra) out.push(`    ${yellow('[extra] ')}  ${key} ${dim('(not a key the updater looks up)')}`);
  }

  out.push('');
  if (status.ready) {
    out.push(
      status.draft
        ? `verdict: ${green('READY TO PUBLISH')} — all 8 assets present, latest.json covers all three platforms.`
        : `verdict: ${green('ALREADY PUBLISHED')} and complete — nothing outstanding.`,
    );
  } else {
    out.push(`verdict: ${red('NOT READY')} — ${status.outstanding.length} item(s) outstanding:`);
    for (const item of status.outstanding) out.push(`  - ${item}`);
  }
  return out.join('\n');
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `usage: node scripts/release-status.mjs [--tag vX.Y.Z] [--repo owner/name] [--json]

Read-only. Reports which of the 8 canonical release assets each machine has
uploaded to the draft, and whether latest.json covers all three updater
platforms. Exits 0 when the release is complete, 1 when something is missing.`;

export async function main() {
  if (has('help') || has('h')) {
    console.log(USAGE);
    return 0;
  }
  const repo = arg('repo', process.env.GH_REPO ?? DEFAULT_REPO);
  const tag = resolveTag();
  const status = await collectStatus({ token: githubToken(), repo, tag });
  console.log(has('json') ? JSON.stringify(status, null, 2) : render(status));
  return status.ready ? 0 : 1;
}

// Only run when invoked directly — release-publish.mjs imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
