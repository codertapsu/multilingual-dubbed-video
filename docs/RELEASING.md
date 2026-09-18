# Releasing VideoDubber

A release is **two machines building in parallel into one GitHub draft**, then one
human review, then one publish.

- The **Mac** (Apple Silicon) builds, deep-signs, notarizes and uploads the macOS
  half: 3 assets.
- The **Windows desktop** (`D:\development\projects\multilingual-dubbed-video`)
  builds and uploads the Windows half: 4 assets.
- Both push to the **same draft release** `vX.Y.Z`, and each merges **its own**
  platform entry into the shared `latest.json` without disturbing the other's.
- Nothing reaches a user until the draft is **published** — which is also what
  creates the git tag.

Everything is built **locally**. There is no CI build path in use; see
[CI — opt-in, effectively dead](#ci--opt-in-effectively-dead).

> Audience: maintainers. For *what* is being shipped, read [`PRODUCTION.md`](PRODUCTION.md).
> For how updates reach users, read [`AUTOUPDATE.md`](AUTOUPDATE.md).

---

## The whole release on one page

Read left to right, top to bottom. The **SYNC** rows are the only places the two
machines have to wait for each other; everything between them runs independently
and in either order.

| | On the **Mac** | On the **Windows desktop** |
|---|---|---|
| **SYNC 1 — one machine only** | `pnpm release:version 0.10.0` → review → `pnpm release:version 0.10.0 --yes`<br>`pnpm check`<br>`git commit -am "chore(release): 0.10.0"` && `git push origin main` | *(wait)* |
| **Both machines get the commit** | `git pull origin main`<br>`pnpm install --frozen-lockfile` | `git pull origin main`<br>`pnpm install --frozen-lockfile` |
| **Preflight — seconds, builds nothing** | `pnpm release:check` | `pnpm release:check` |
| **Build + sign + upload** *(~25 min each, in parallel)* | export the four `APPLE_*` vars, then<br>`pnpm release --sidecars --upload` | `pnpm release -Sidecars -Upload` |
| **SYNC 2 — after BOTH finish** | `pnpm release:status` → must exit 0 *(read-only; runs on either machine)* | *(done; nothing left to do here)* |
| **Write the notes** | edit the draft body on GitHub **under** the download table, or write `notes.md` | |
| **Publish — one machine only** | `pnpm release:publish` → review the dry run → `pnpm release:publish --yes --notes-file notes.md` | |
| **After publish** | verify the endpoint, update a real machine, then `node scripts/package/prune-releases.mjs --apply` | |

Flag syntax, both machines:

```bash
pnpm release --sidecars --upload     # macOS: POSIX spellings
pnpm release -Sidecars -Upload       # Windows: PowerShell spellings
```

> **Never write `pnpm <task> -- <flag>`.** pnpm 11 forwards the literal `--` to
> the script as its own argument, and the script exits 2 on an unknown option
> (measured: `pnpm release -- --check` hands the script `["--", "--check"]`). There is
> no separator — `pnpm release --check`, `pnpm release -Check`.
>
> `scripts/release.sh` accepts the PowerShell spellings too, so a single
> package.json entry can pass one flag both twins understand. Write the native
> spelling for the machine you are on anyway; it is what the `--help` says.

---

## SYNC 1 — bump the version, on one machine

The Tauri **app version** is what the updater compares against `latest.json`, and
it lives in five places that must agree:

```
package.json
apps/desktop/package.json
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/Cargo.lock      (the videodubber-desktop entry)
```

```bash
pnpm release:version 0.10.0          # DRY RUN by default: prints the table, writes nothing
pnpm release:version 0.10.0 --yes    # actually writes all five
pnpm release:version minor --yes     # or compute the next version from the current one
```

It takes `X.Y.Z` or `major` / `minor` / `patch`. Flags: `--yes`, `--allow-dirty`
(bump on top of other uncommitted changes), `--allow-downgrade`, `--help`. It
snapshots all five files, writes, re-runs the full consistency check, and
**restores every snapshot if any step fails** — so a partially-bumped tree is not
a state you can end up in. `Cargo.lock` is updated through
`cargo update --workspace --offline`, not hand-edited. It does not commit, tag or
build.

Then prove the tree is releasable and push:

```bash
pnpm check        # lint + typecheck + tests + check-versions + check-tasks
git commit -am "chore(release): 0.10.0"
git push origin main
```

`pnpm check` runs `node scripts/check-versions.mjs`, the smoke alarm that catches
a half-done bump; `release:version` is the fire prevention. Running the writes
through `check-versions.mjs --set` is deliberate — it already knows each file's
shape and verifies every write by reading it back.

**Do NOT create the git tag by hand.** Publishing creates `vX.Y.Z` from `main`
automatically. A hand-made tag pins to a commit that later fixes leave behind.

**Both machines must then be on this commit** before building. If you push a fix
mid-release, **every platform built before that fix must be rebuilt** — nothing
checks this for you, so compare each asset's upload time on the draft against the
commit time yourself before publishing.

### If `src-tauri/src` changed: cross-check the platform-conditional Rust

`cargo check` on the Mac compiles only the `cfg(target_os = "macos")` branches, so
a symbol referenced from shared code but defined under a macOS `cfg` builds here
and fails the Windows build ~20 minutes into someone else's afternoon. A full
`cargo check --target x86_64-pc-windows-msvc` is not possible from macOS (`ring`'s
C build needs the Windows SDK headers); extract the `cfg`-gated items and their
call sites into a standalone file and `rustc --emit=metadata` it for both targets.

The rule that avoids the whole class: a `cfg`-gated function returns the
platform-specific **data** (e.g. `Option<String>` explaining why), and never makes
shared code name a platform-specific symbol.

---

## Preflight — `pnpm release:check`

Runs on either machine, builds nothing, takes seconds. It exists because the
expensive failures are all discovered *after* a 20-minute build otherwise — a
missing `APPLE_TEAM_ID` is found by Apple's notary service, and a missing updater
key is found by `tauri build` at the end.

It gates on: the toolchain (`node`, `pnpm`, `cargo`, `xcrun`; on Windows also WiX,
which is a warning), version consistency across the four manifests, the Python
worker suites run **strictly** (`REQUIRE_ALL=1` — without it they report "skipped"
and exit 0 on a box with no venvs, i.e. a green gate that ran nothing), a clean git
tree, the updater signing key, the Developer ID identity **in the keychain**, the
notary credentials, and a GitHub token.

Escape hatch: `ALLOW_DIRTY=1` downgrades the dirty-tree gate to a warning. Use it
for a deliberate local experiment, never for a release you intend to ship — a
dirty build corresponds to no commit, so "which build is this?" has no answer
afterwards.

`pnpm release --sidecars --upload` re-runs the environment half of this preflight
before it builds, so a missing credential still stops you in seconds.

---

## macOS — on the Mac

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"   # appleid.apple.com -> App-Specific Passwords
export APPLE_TEAM_ID="<TEAMID>"

pnpm install --frozen-lockfile
pnpm release --sidecars --upload
```

`TAURI_SIGNING_PRIVATE_KEY` is loaded from `~/.tauri/videodubber.key`
automatically; that key has an **empty password**, which the script also exports so
the build does not stop to prompt.

Other flags (`scripts/release.sh --help`): `--check`, `--sidecars`, `--upload`,
`--tag v0.10.1`, `--help`.

What `pnpm release` hands off to (`scripts/package/release-macos.sh`):

1. `check-versions.mjs` + the Python worker suites.
2. `--sidecars` → `pnpm package:sidecars`.
3. `tauri build` with the **notary creds withheld** (`env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID`).
4. `macos-sign-notarize.sh` — deep-sign every Mach-O, notarize, staple.
5. **Regenerate** the updater archive from the repaired app, and sign it.
6. `--upload` → upload the `.dmg` + updater archive + `.sig` to the `vX.Y.Z` draft,
   then merge the `darwin-aarch64` entry into `latest.json`.

### `--sidecars`: when you may skip it, and what it costs when you shouldn't

`--sidecars` rebuilds the orchestrator (Node SEA), the four PyInstaller sidecars,
static ffmpeg/ffprobe, uv, bundled CPython and `resources/engine-src` — about 25
minutes — **and it is the only thing that runs the release bundle assertion**
(portable ffmpeg, `minimumSystemVersion` not below any bundled binary's `minos`,
uv + CPython present).

**Skip it only when the change is confined to `src-tauri/src` (the Rust shell) or
`apps/desktop/src` (the Angular UI).** Everything else the app runs is a sidecar —
the Node orchestrator included. Skipping it then re-bundles the **stale** sidecar
binaries into an installer that looks completely correct and does not contain your
change. That has shipped twice: a fix to the orchestrator's engine launch args was
"released" two releases running before anyone noticed the binary never had it.

For an orchestrator-only change, rebuild just that sidecar instead of paying the
full 25 minutes:

```bash
bash scripts/package/build-orchestrator.sh          # ~1 min
UPLOAD=1 RELEASE_TAG=v0.10.0 bash scripts/package/release-macos.sh
```

Either way, **verify the change is in the assembled app before notarizing**:

```bash
APP=$(find apps/desktop/src-tauri/target -path '*/release/bundle/macos/VideoDubber.app' | head -1)
strings "$APP/Contents/MacOS/videodubber-orchestrator" | grep -c "<a string from your change>"
```

Zero means the sidecar is stale — stop, rather than spend a notarization cycle on
an artifact that cannot work.

> This does **not** work for an Angular change: Tauri **brotli-compresses** the
> embedded frontend, so a shipped UI string is never greppable and zero hits looks
> identical to a stale build. Decompress the staged asset instead
> (`zlib.brotliDecompressSync` over
> `target/release/build/videodubber-desktop-*/out/tauri-codegen-assets/*`).

### Why the deep-sign + notarize dance

`tauri build` will try to notarize the app itself if `APPLE_ID` / `APPLE_PASSWORD` /
`APPLE_TEAM_ID` are in its environment — and **Tauri's signing does not reach the
bundled PyInstaller worker `.so` files**, so that in-build notarization fails with
"not signed with a valid Developer ID certificate". So the build runs with the
notary creds withheld (Tauri signs the shell only) and `macos-sign-notarize.sh`
deep-signs **every** Mach-O, then notarizes and staples. Entitlements live in
`apps/desktop/src-tauri/entitlements.plist`.

The updater archive is **always regenerated from the repaired, notarized app** —
the `.app.tar.gz` that `tauri build` emitted is from the PRE-repair app and must
not ship.

> **Expect TWO `Accepted` lines, not one.** The first submission notarizes the DMG
> built from the freshly signed app; the ticket it issues for the nested `.app` is
> stapled to the bundle, and the DMG is rebuilt around the stapled app so first
> launch works offline. Those rebuilt bytes have a cdhash Apple has never seen, so
> `stapler` fails with *"Record not found" / Error 65* — **that log line is
> expected** — and the script resubmits and staples.

Full cert creation, verification and troubleshooting: [`APPLE_SIGNING.md`](APPLE_SIGNING.md).

### Spot-check the built app (optional, ~30 seconds)

Each of these caught a real shipped defect:

```bash
APP=$(find apps/desktop/src-tauri/target -path '*/release/bundle/macos/VideoDubber.app' | head -1)

# 1. ffmpeg/ffprobe must link NOTHING outside /usr/lib + /System/Library.
#    v0.3.0 shipped Homebrew-linked binaries that worked only on the build machine.
for b in ffmpeg ffprobe; do
  otool -L "$APP/Contents/MacOS/$b" | tail -n +2 | awk '{print $1}' \
    | grep -v -E '^(/usr/lib/|/System/Library/)' && echo "NOT PORTABLE" || echo "$b portable OK"
done

# 2. A stapled ticket, so first launch works offline.
xcrun stapler validate "$APP"
spctl -a -vv "$APP"            # expect: source=Notarized Developer ID

# 3. The declared floor matches reality.
plutil -p "$APP/Contents/Info.plist" | grep -E "LSMinimumSystemVersion|CFBundleShortVersion"
```

---

## Windows — on the Windows desktop

```powershell
git pull origin main
pnpm install --frozen-lockfile
pnpm release -Sidecars -Upload
```

First time on this machine? Do [`WINDOWS.md` Part A](WINDOWS.md#part-a--one-time-machine-setup-install-these-once)
first: pwsh 7, Node 24, Python 3.12 + the worker venvs, Rust/MSVC, a GitHub token,
and — the one most often missed — `~\.tauri\videodubber.key` **copied from the
Mac** (it is a secret: AirDrop/USB, not chat). Without it the build emits no `.sig`
files and the auto-updater can never install the release.

Flags mirror macOS: `-Check`, `-Sidecars`, `-Upload`, `-Tag v0.10.1`. `-Sidecars`
follows exactly the same rule as macOS above.

`scripts/package/release-windows.ps1` builds a **static** libass ffmpeg,
produces the NSIS `-setup.exe` **and** the `.msi`, uploads both pairs, and merges
**both** `windows-x86_64` and `windows-x86_64-msi` into `latest.json`.

> **ffmpeg: do not set `FFMPEG_PATH`.** The sidecar build downloads a static
> BtbN `win64-gpl` build, which is the one to ship. A shared build (gyan.dev's
> `ffmpeg-release-full-shared`, e.g. the one in `D:\ffmpeg`) **cannot be bundled**
> — the app ships `ffmpeg.exe` alone, and a shared build needs its `av*.dll`s next
> to it. `fetch-ffmpeg.ps1` detects and rejects shared builds. Only `FFMPEG_BIN` /
> `FFPROBE_BIN` stage a local binary at build time; `FFMPEG_PATH`/`FFPROBE_PATH`
> are **runtime** vars and are deliberately ignored by every build script. That
> separation is why v0.3.0's bug cannot recur.

> **Both Windows installers ship, on purpose** — see
> [the `latest.json` platform keys](#platform-keys-and-why-there-are-three).
> Building the `.msi` needs the **WiX toolset** (Tauri fetches it on first use). A
> missing `.msi` is a warning, not a failure: the run degrades to NSIS-only and the
> `windows-x86_64-msi` merge is skipped. If WiX fails outright you can drop `"msi"`
> from `bundle.targets` and re-run, but you are then stranding the MSI population.

The installer is **unsigned by standing decision** — see
[Windows code signing — deliberately not configured](#windows-code-signing--deliberately-not-configured).
First launch shows SmartScreen: **More info → Run anyway**.

---

## SYNC 2 — is the draft complete?

Run on either machine, after **both** builds have finished:

```bash
pnpm release:status
```

**Read-only — it performs GETs and nothing else.** It lists the canonical assets
grouped by the **machine** that produces them (3 from the Mac, 4 from Windows,
`latest.json` shared), marks each present or `[MISSING]`, and then checks
`latest.json` itself: that its `version` matches the tag, that all three platform
keys are there, and that none of their URLs is dangling. **Exit 0 means READY TO
PUBLISH.** Anything else lists what is outstanding — usually one machine has not
finished, or has uploaded installers without merging its manifest entry.

```bash
pnpm release:status                    # the tag from tauri.conf.json
node scripts/release-status.mjs --tag v0.8.1     # audit an older release
node scripts/release-status.mjs --json           # machine-readable
```

Flags: `--tag`, `--repo`, `--json`, `--help`. Auth is `GH_TOKEN` or the token
`git credential` holds — the same two places `release-upload.sh` looks, so if
uploading works, this works.

> An unpublished draft's web URL contains `untagged-<sha>` even when its
> `tag_name` is already correct — the git tag only exists once you publish.
> `release:status` says so explicitly; it is not the broken-tag bug.

### The canonical asset set — exactly 8

Confirmed against the live v0.9.0 draft and every published release back to
v0.7.0:

| Asset | From | Notes |
|---|---|---|
| `latest.json` | **shared** | merged by whichever machine finishes each half |
| `VideoDubber_<ver>_aarch64.app.tar.gz` | Mac | the updater payload |
| `VideoDubber_<ver>_aarch64.app.tar.gz.sig` | Mac | |
| `VideoDubber_<ver>_aarch64.dmg` | Mac | the macOS **installer** — **no `.sig`, and that is correct** |
| `VideoDubber_<ver>_x64-setup.exe` | Windows | NSIS installer |
| `VideoDubber_<ver>_x64-setup.exe.sig` | Windows | |
| `VideoDubber_<ver>_x64_en-US.msi` | Windows | |
| `VideoDubber_<ver>_x64_en-US.msi.sig` | Windows | |

The `.dmg` has no signature because the updater never installs it — it installs the
`.app.tar.gz`. Only the three updater payloads are signed.

### Optionally: verify the signatures against the bytes GitHub is serving

The strongest check there is — it catches a wrong key *and* a corrupted upload, and
a bad signature means every client rejects the update. Draft assets are not public,
so fetch them through the API with a token:

```bash
brew install minisign     # once
cd "$(mktemp -d)"
python3 -c "import base64,json;open('vd.pub','w').write(base64.b64decode(json.load(open('$OLDPWD/apps/desktop/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey']).decode())"

TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
REPO=codertapsu/multilingual-dubbed-video; REL=<RELEASE_ID>
ASSETS=$(curl -sL -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/releases/$REL/assets?per_page=100")
get() { id=$(printf '%s' "$ASSETS" | N="$1" python3 -c "import json,os,sys;print(next(a['id'] for a in json.load(sys.stdin) if a['name']==os.environ['N']))"); \
        curl -sL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" \
             "https://api.github.com/repos/$REPO/releases/assets/$id"; }

for f in VideoDubber_0.10.0_aarch64.app.tar.gz VideoDubber_0.10.0_x64-setup.exe VideoDubber_0.10.0_x64_en-US.msi; do
  get "$f" > "$f"
  get "$f.sig" | python3 -c "import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read().strip()).decode())" > "$f.msig"
  minisign -V -p vd.pub -x "$f.msig" -m "$f"   # expect: Signature and comment signature verified
  rm -f "$f"                                   # ~1.4 GB total — delete as you go
done
```

The env var must **prefix** the command (`N="$1" python3 …`); after it, it is just
an argument and the lookup silently fails.

---

## Write the notes, then publish

`merge-latest-json.mjs` defaults `notes` to `VideoDubber X.Y.Z`, and **that string
is what the in-app update dialog shows users**. Write something better.

The draft body is seeded automatically from
[`scripts/package/release-body-header.md`](../scripts/package/release-body-header.md)
(`{{VERSION}}` and `{{MIN_MACOS}}` substituted at upload time) — a bilingual
download table. **Write the changelog underneath it; never replace it.** It matters
because the assets list shows `…_aarch64.app.tar.gz` — the updater payload, not an
installer — next to the `.dmg` at a similar size, and a Mac user who picks it gets a
loose `.app` in `~/Downloads` that is signed, opens fine, and is never installed or
updatable. That failure looks exactly like success.

```bash
pnpm release:publish                              # DRY RUN: says what it would do
pnpm release:publish --yes --notes-file notes.md  # append notes + publish
```

`release:publish` re-runs `release-status.mjs` first and **refuses to publish
anything it reports as incomplete** — that refusal is the whole point; publishing
itself is one `PATCH`. Notes are **appended under** the download table, never
replacing it (`composeBody()`).

Flags: `--tag`, `--repo`, `--notes-file PATH`, `--notes "…"`, `--prerelease`
(publish without GitHub marking it "Latest"), `--yes`. **Without `--yes` nothing
is written.**

Also update the manifest's own `notes` if you want the in-app dialog to say
something better than the default — `merge-latest-json.mjs --notes` (below) is
what writes it, and it is a separate string from the release body.

> **Publishing creates the `vX.Y.Z` tag from `main`'s HEAD *at publish time*** — not
> from the commit the installers were built from. Do not push to `main` between the
> last platform build and publishing, or the tag points at code that was never
> built. If `main` did advance: publish first and move the tag afterwards, or
> rebuild.

---

## After publishing

```bash
# GitHub's 'latest' must be the new tag
curl -sL https://api.github.com/repos/codertapsu/multilingual-dubbed-video/releases/latest | grep '"tag_name"'

# The updater endpoint (public, unauthenticated) must serve the new manifest
curl -sL "https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json"

# Every payload URL must be publicly reachable
for f in VideoDubber_0.10.0_aarch64.app.tar.gz VideoDubber_0.10.0_x64-setup.exe VideoDubber_0.10.0_x64_en-US.msi; do
  curl -sIL -o /dev/null -w "%{http_code} $f\n" -r 0-0 \
    "https://github.com/codertapsu/multilingual-dubbed-video/releases/download/v0.10.0/$f"
done     # expect 206 for each
```

Then do the check no amount of manifest inspection replaces: **update a real
machine** from the previous version via Settings → Check for updates. Prioritise
**Windows**, which exercises the pre-install sidecar teardown.

### Prune old releases

Only **after** the endpoint is confirmed serving the new version — the previous
release is your only rollback target, so pruning early destroys it.

```bash
node scripts/package/prune-releases.mjs                  # dry run: shows what goes
node scripts/package/prune-releases.mjs --apply          # keeps the 2 newest published
node scripts/package/prune-releases.mjs --keep 3 --apply
```

Each release carries 0.6–1.9 GB of installers and old ones serve no purpose: the
updater always reads `releases/latest/download/latest.json`, so a client on *any*
version updates straight to the newest and never consults the release it is
currently running. The script is deliberately conservative — dry run by default,
never touches drafts, never touches whatever GitHub resolves as `latest` even if
the date ordering disagrees, and **keeps git tags** (pass `--tags` to drop those
too, if you really want the history gone). A pruned version's download URLs 404
afterwards; existing installs and auto-update are unaffected.

### Rollback, if the release turns out bad

Do **not** delete it. Mark it a **pre-release** — the endpoint resolves to the
newest *published, non-prerelease* release, so it falls back to the previous
version immediately and the bad build stays available for diagnosis:

```bash
curl -sL -X PATCH -H "Authorization: Bearer $TOKEN" -d '{"prerelease":true}' \
  "https://api.github.com/repos/codertapsu/multilingual-dubbed-video/releases/<RELEASE_ID>"
```

The endpoint is CDN-cached briefly — re-check with a cache-buster before concluding
it did not work. Clients already on the bad version are **not** downgraded (the
updater only moves forward); they stay put until a newer release is published.

---

## What can go wrong

These four are the ones that have actually happened here. Each has a cheap guard.

**A stale sidecar ships without your change.** You skipped `--sidecars` for a change
that lives in the orchestrator or a Python worker. The installer builds, signs,
notarizes and installs perfectly — and behaves like the previous version. Nothing
in the pipeline notices, because every artifact is valid.
→ *Guard:* `--sidecars` unless the change is purely `src-tauri/src` or
`apps/desktop/src`, and `strings` the bundled binary for a string your change
introduced before notarizing (brotli caveat for UI changes above).

**A half-done version bump uploads into the previous release.** Only some manifests
were bumped, so the artifact filenames and the tag derived from
`tauri.conf.json` disagree with what you think you are shipping — and a bare
`release-upload.sh` run defaults its tag to `v<version from tauri.conf.json>`,
which is the *old* version if that file is the one you missed. Assets land in the
wrong release, quietly.
→ *Guard:* `pnpm release:version` writes all five at once; `check-versions.mjs`
runs inside `pnpm check`, `pnpm release:check` and both release scripts.

**`latest.json` is missing a platform, so those users silently get no update.** The
manifest is merged one platform at a time from two machines. If the Windows half
never ran, or its MSI merge was skipped, `check()` errors for that platform's users
— and it is invisible from the Mac, where everything looks complete.
→ *Guard:* `pnpm release:status` lists the platform keys; `release:publish` refuses
on an incomplete draft.

**Publishing before the second machine finished.** The draft looks plausible with
four or five assets on it. Publishing makes it `latest` immediately, so every user
who checks for updates in the next few minutes sees a manifest pointing at assets
that may not exist yet.
→ *Guard:* SYNC 2. `release:status` exits 0 only on the full 8-asset set, and
`release:publish` will not act without it.

Plus the smaller ones that have each cost a rebuild:

| Gotcha | Why it bites | Guard |
|---|---|---|
| A **runtime** env var steering the **build** | `.env` sets `FFMPEG_PATH` for dev; `fetch-ffmpeg.*` once read it as "stage this binary", so v0.3.0 shipped Homebrew-linked ffmpeg that ran only on the build machine | build-time staging is `FFMPEG_BIN`/`FFPROBE_BIN` only; `assert_portable` + the release bundle assertion reject non-portable binaries |
| **Raising `minimumSystemVersion`** | The updater has no OS gate: it replaces a working app, then the OS refuses to launch it | `unsupported_host_reason()` withholds the offer; `cargo test`'s `min_macos_matches_config` keeps it in sync with `tauri.conf.json` |
| **Sidecars survive the updater's exit** | On Windows they hold `.exe`/`.dll` open, so NSIS fails with "Error opening file for writing" | `on_before_exit` → `sidecar::shutdown_all()` on both update paths |
| **`cfg`-gated symbols in shared code** | Builds on macOS, `E0425` on Windows | the cross-check above |
| **Rebuilding the DMG invalidates its ticket** | New cdhash ⇒ `stapler` Error 65 | the script resubmits automatically; two `Accepted` lines are normal |
| **A spec/config that PARSES but means something else** | `excludes=["pytest" "av"]` — a missing comma concatenated them into `"pytestav"`, excluding neither, and PyAV shipped anyway. `compile()` proved nothing | read the value back (`ast.literal_eval`) and assert the entries you expect |
| **`PATCH`ing a draft without `tag_name`** | The API resets the tag to `untagged-<sha>`, and every URL in `latest.json` then 404s after publish. Setting the release *body* is the usual trigger | always send `tag_name` alongside `body`/`name`; `merge-latest-json.mjs --fix-tag` repairs it |
| **Drafts are invisible to the updater** | The endpoint is `releases/latest/…` — newest *published, non-prerelease* | nothing reaches users until publish; that is the design, not a bug |

---

## Reference

### How `latest.json` drives the updater

`bundle.createUpdaterArtifacts: true` makes Tauri emit, per platform, an update
archive plus a detached `.sig` signed with `TAURI_SIGNING_PRIVATE_KEY`. The
installed app fetches `latest.json` from the configured endpoint, compares
`version` to its own, downloads the matching platform entry, and **verifies the
signature with the embedded pubkey** before installing. Full flow:
[`AUTOUPDATE.md`](AUTOUPDATE.md).

The live v0.9.0 manifest, trimmed:

```jsonc
{
  "version": "0.9.0",
  "notes": "Download source videos from Bilibili and Douyin…",   // what the update dialog SHOWS
  "pub_date": "2026-08-06T04:16:30.844Z",
  "platforms": {
    // macOS (Apple Silicon) — the .app.tar.gz, NOT the .dmg
    "darwin-aarch64":     { "signature": "…", "url": ".../v0.9.0/VideoDubber_0.9.0_aarch64.app.tar.gz" },
    // Windows installed from the NSIS setup.exe
    "windows-x86_64":     { "signature": "…", "url": ".../v0.9.0/VideoDubber_0.9.0_x64-setup.exe" },
    // Windows installed from the .msi — looked up FIRST by those clients
    "windows-x86_64-msi": { "signature": "…", "url": ".../v0.9.0/VideoDubber_0.9.0_x64_en-US.msi" }
  }
}
```

### Merge semantics

`merge-latest-json.mjs` writes **one platform per invocation** and preserves
everything else, which is what lets two machines share one manifest:

1. Finds the release for `--tag` (drafts included). `--fix-tag` repairs a stray
   `untagged-<sha>` draft tag first.
2. Downloads the release's current `latest.json` and **merges** into it — other
   platforms' entries survive.
3. Sets `platforms[--platform] = { signature: <contents of <artifact>.sig>, url: … }`.
4. Sets `version` (tag minus the `v`), `pub_date`, and `notes` (`--notes` wins;
   otherwise existing notes survive).
5. Replaces the asset. Idempotent — re-running is safe.

```bash
node scripts/package/merge-latest-json.mjs --tag v0.10.0 --platform darwin-aarch64 \
  --artifact <path>/VideoDubber_0.10.0_aarch64.app.tar.gz --notes "What changed…"
```

Flags: `--repo`, `--tag`, `--platform`, `--artifact`, `--sig`, `--notes`,
`--fix-tag`, `--dry-run`.

It does **not** validate `--platform` — it writes whatever string you pass, which
is how `release-windows.ps1` adds the third key. Do not read "no Linux key" as a
guard.

### Platform keys, and why there are three

`tauri-plugin-updater` resolves the manifest key as
`[{os}-{arch}-{installer}, {os}-{arch}]`. A machine installed from the `.msi`
therefore looks for **`windows-x86_64-msi` first**. Without that key those users
fall back to the NSIS `.exe`, which mid-update either uninstalls the MSI through an
elevated `msiexec` prompt or leaves two parallel installs. v0.1.0 + v0.2.0 alone
have 26 MSI downloads, so this population is real — that is the entire reason the
`.msi` is built, signed, uploaded and given its own key.

| Key | Payload |
|---|---|
| `darwin-aarch64` | the notarize-repaired `.app.tar.gz` |
| `windows-x86_64` | the NSIS `-setup.exe` |
| `windows-x86_64-msi` | the `.msi` |

### The updater signing key

Generated **once**, kept secret forever:

```bash
pnpm --filter videodubber-desktop exec tauri signer generate -w ~/.tauri/videodubber.key
```

The **public** key lives in `tauri.conf.json` at `plugins.updater.pubkey` and is
committed. The **private** key is on the Mac at `~/.tauri/videodubber.key` and
copied to `~\.tauri\videodubber.key` on the Windows box. It has an **empty
password**, which the release scripts export so builds do not prompt.

> Losing it means existing installs can no longer verify updates — every user would
> need a fresh manual install carrying a new pubkey. Back it up securely.

The endpoint, already configured:

```
https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json
```

### Windows code signing — deliberately not configured

**Every Windows artifact this project has ever published is unsigned.**
`tauri.conf.json`'s `bundle.windows` block carries only `webviewInstallMode` and
`nsis.installMode` — **none** of the signing fields (`certificateThumbprint`,
`signCommand`, `digestAlgorithm`, `timestampUrl`). `tauri build` has nothing to
sign with, and `release-windows.ps1` never signs anything: a repo-wide grep for
`signtool` / `osslsigncode` finds nothing outside the (dead) CI workflow.

**DECIDED 2026-09-18: Windows builds stay unsigned.** A standing choice, not an
omission and not a pending task — do not re-open it at release time. Accepted
consequences:

* Every hand-downloaded install and update shows the full-screen "Windows protected
  your PC — Unknown publisher" panel whose default button is *Don't run*, with *Run
  anyway* behind *More info*. This is the single largest install-funnel loss.
  `README.md` and `docs/USER_GUIDE.md` both tell users exactly what they will see
  and which link to click; keep that wording accurate — it is the only mitigation
  there is.
* In-app auto-updates are **not** affected: those are verified by the updater's own
  minisign signature, which is configured and working.
* Some corporate/managed Windows images block unsigned installers outright, with no
  "Run anyway". Those users cannot install VideoDubber at all.

If it is ever revisited, a certificate has to be bought — a maintainer decision, not
a code change. Two notes for whoever makes it: Azure Artifact Signing (ex-Trusted
Signing) restricts *individual* sign-up to the USA and Canada; and "EV clears
SmartScreen reputation instantly" has not been true since the 2023 FIPS key-storage
change made OV and EV equally hardware-bound — reputation accrues across releases
signed by the **same identity**, so keep the identity stable. Wire it in as
`bundle.windows.signCommand` (Tauri 2 supports a `%1` placeholder, which is how
cloud signing tools integrate) so `tauri build` signs the NSIS exe, the MSI **and**
the sidecar exes, and make `release-windows.ps1` fail when signing is configured but
produced no signature — mirroring the existing `.sig` hard-fail.

### Linux and Intel macOS produce nothing

Not "not yet": `release-macos.sh` hardcodes `aarch64`, `bundle.targets` contains no
Linux package type (a Linux `tauri build` exits 0 having bundled nothing), there is
no `release-linux.sh`, and nothing merges a Linux entry into `latest.json` — so even
a hand-built `.AppImage` would never be offered as an update. Ship Apple Silicon +
Windows, and say so in the README rather than advertising files that have never
existed.

### Running the helpers by hand (recovery)

The release scripts call these for you; this is for repairing a half-finished
release.

```bash
export RELEASE_TAG=v0.10.0    # override; defaults to v<version from tauri.conf.json>
bash scripts/package/release-upload.sh ensure                  # create/find the draft, print its id
bash scripts/package/release-upload.sh upload <file> [file…]   # ensure + upload, replacing same-named assets
```

Auth is `GH_TOKEN`, else the OAuth token `git credential` already holds (no `gh`
CLI needed). Override the repo with `GH_REPO`. Because uploads **replace**
same-named assets, re-cutting a draft needs no deletion and no tag move — rebuild
and re-run the release script.

> Older runbooks warned that `release-upload` defaulted its tag to `v0.1.0`. It no
> longer does — the default is `v<version from tauri.conf.json>`. Exporting
> `RELEASE_TAG` explicitly is still the safe habit.

Doing the macOS steps entirely by hand? You **must** keep the notary creds out of
the `tauri build` environment:

```bash
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID pnpm app:build
bash scripts/package/macos-sign-notarize.sh
```

### Sanity-build before a release (optional)

```bash
pnpm package:sidecars     # orchestrator + workers + piper + ffmpeg for your host
pnpm app:build            # a local installer under apps/desktop/src-tauri/target
```

Verify it launches, the first-run wizard appears, and a tiny dub completes (needs
the worker venvs — `scripts/setup-local-models.sh`).

### CI — opt-in, effectively dead

`.github/workflows/release.yml` still exists and still builds on a `v*` tag push,
but **every OS is opted out**: `RELEASE_CI_MACOS` / `RELEASE_CI_WINDOWS` /
`RELEASE_CI_LINUX` are all `false`, so a tag push builds nothing. Releases have been
local-only since 2026-07-04 (GitHub's hosted macOS runners bill at 10x and the DMG
step is flaky on them). CI is kept only as an escape hatch: set a variable to `true`
to build that OS in CI on the next tag push, and it uploads to the same draft the
local flow targets. The matrix logic lives in
`scripts/ci/resolve-release-matrix.py` (runnable locally to preview it).

**Careful:** a manual **workflow_dispatch** run builds **every** OS regardless of
the variables — and its Intel-mac job still names the retired `macos-13` runner
image, so it would fail there. Do not trigger one unintentionally.

The `WINDOWS_CERTIFICATE` / `APPLE_CERTIFICATE` / `KEYCHAIN_PASSWORD` repo secrets
are consumed **only** by that workflow. In the local flow this project actually
uses, setting them does nothing.

### Engine packs — nothing to host

No engine pack is self-hosted: every native pack points at an upstream ggml-org
release and the Python packs have no URLs at all. What does need maintenance is the
seven GGUF model packs, which pin community requants on HuggingFace by URL +
sha256 — if an uploader deletes or re-quantizes one, every install of that pack
fails at once. Re-pin procedure:
[`ENGINE_PACKS.md` §3](ENGINE_PACKS.md#3-re-pinning-a-model-pack-whose-upstream-vanished).

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `latest.json` missing from the release | `bundle.createUpdaterArtifacts` not `true`, or `TAURI_SIGNING_PRIVATE_KEY` unset → no updater artifacts emitted |
| Update found, install fails with a signature error | The app's `plugins.updater.pubkey` does not match the private key that signed the payload. Regenerate consistently |
| Every `latest.json` URL 404s after publish | The draft's tag was reset to `untagged-<sha>` by a `PATCH` without `tag_name`. Re-run the merge with `--fix-tag` |
| macOS "app is damaged / can't be opened" | Notarization failed or was skipped. Check the notarytool log; `xcrun stapler validate` the `.app` |
| PyInstaller worker crashes on launch in the bundle | Missing hidden import/data file — add it to the worker's `.spec` `hiddenimports`/`datas` and re-release. Run the frozen binary directly to see the traceback |
| ffmpeg burned-in subtitles fail in the bundle | The fetched ffmpeg lacks libass. `fetch-ffmpeg` verifies the `subtitles` filter; ensure a `-gpl`/full build is used |
| Sidecar "not found" at runtime | The binary was not named `<base>-<target-triple>` for the build host — see `apps/desktop/src-tauri/binaries/README.md` |
