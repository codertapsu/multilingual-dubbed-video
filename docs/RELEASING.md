# Releasing VideoDubber

End-to-end runbook for cutting a signed, auto-updatable release. Releases are built
**locally by default** on the maintainer's own machines; CI
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) is **opt-in
per OS** via the `RELEASE_CI_*` repo variables. This doc is the human checklist for
both paths.

> Audience: maintainers. For the architecture of *what* is being shipped, read
> [`PRODUCTION.md`](PRODUCTION.md) first. For how updates reach users, read
> [`AUTOUPDATE.md`](AUTOUPDATE.md).

---

## Cut a release — step by step

Every installer is built **locally** — macOS on the Mac, Windows on the Windows
desktop (`D:\development\projects\multilingual-dubbed-video`) — uploaded to one
GitHub **draft**, verified, and then published. CI is off
(`RELEASE_CI_MACOS` / `RELEASE_CI_WINDOWS` = `false`).

This sequence is the one used to ship **v0.4.0**, corrected afterwards against
the scripts themselves. Follow it in order — several steps exist only because
their absence shipped a broken release (see [Hard-won gotchas](#hard-won-gotchas)).

> Honest caveat from that release: gate 6.4 (assets newer than the last fix) was
> knowingly waived for macOS — the Mac artifacts predate `7e73f6f`, a
> Windows-only compile fix with no effect on macOS behaviour. Waiving a gate is
> fine when you can say exactly why; skipping one silently is not.

> **First time on a machine?** Do the one-time setup first: [macOS](#one-time-setup)
> (Developer ID + the updater key) and [Windows](WINDOWS.md#part-a--one-time-machine-setup-install-these-once)
> (pwsh 7, Node 24, Python 3.12, Rust+MSVC, the updater key copied over, a GitHub
> token). Once per machine.

Steps 3 (macOS) and 4 (Windows) are independent — run them in either order, on
either machine first; each preserves the other's `latest.json` entry.

### 0. Pick the version

Semver `X.Y.Z`; the current one is in `apps/desktop/src-tauri/tauri.conf.json`.
Replace every `X.Y.Z` / `vX.Y.Z` below.

### 1. Bump the version + verify + push

The Tauri **app version** is what the updater compares against `latest.json`. Set
the same value in all four manifests, then refresh the lockfile so the build
doesn't dirty the tree mid-release:

* `package.json` → `version`
* `apps/desktop/package.json` → `version`
* `apps/desktop/src-tauri/tauri.conf.json` → `version`
* `apps/desktop/src-tauri/Cargo.toml` → `[package].version`

```bash
# edit the four version fields to X.Y.Z (review each — don't blind-sed)
(cd apps/desktop/src-tauri && cargo check)      # rewrites Cargo.lock to X.Y.Z

pnpm build                # packages/** + media-worker -> dist/; the desktop app and
                          # orchestrator typecheck against EACH OTHER's dist/, and those
                          # dirs are gitignored — skip this and you typecheck stale output
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm lint                 # root script (eslint .). NOTE: `pnpm -r ... lint` matches NOTHING —
                          # -r excludes the workspace root, where the only lint script lives
(cd apps/desktop/src-tauri && cargo test)   # min_macos_matches_config — the ONLY guard on
                          # the updater's OS gate; no other gate runs cargo test

git commit -am "chore(release): X.Y.Z"
git push origin main
```

**Do NOT create the git tag by hand.** Publishing the release (step 7) creates
`vX.Y.Z` from `main` automatically. Tagging early pins the tag to a commit that
later fixes would leave behind.

Make sure BOTH machines are on this commit (`git pull`) before building, so the
installers match. If you push a fix mid-release, **every** platform built before
that fix must be rebuilt — check asset upload times against the commit time.

### 2. Cross-check platform-conditional Rust (only if `src-tauri/src` changed)

`cargo check` on the Mac compiles the `cfg(target_os = "macos")` branches only, so
a symbol referenced from shared code but defined under a macOS `cfg` builds here
and fails on Windows. This has broken a Windows release build:

```bash
rustup target add x86_64-pc-windows-msvc   # once
```

A full `cargo check --target x86_64-pc-windows-msvc` is **not** possible from
macOS (`ring`'s C build needs the Windows SDK headers). Instead, extract the
`cfg`-gated items and their call sites into a standalone file and compile that
for both targets:

```bash
rustc --target x86_64-pc-windows-msvc --emit=metadata --crate-type bin probe.rs -o /tmp/p.rmeta
rustc --target aarch64-apple-darwin    --emit=metadata --crate-type bin probe.rs -o /tmp/p2.rmeta
```

Rule of thumb that avoids the whole class: a `cfg`-gated function should return
the platform-specific *data* (e.g. `Option<String>` describing why), never force
shared code to name a platform-specific symbol.

### 3. Build + upload macOS — on the Mac

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"      # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="<TEAMID>"
export RELEASE_TAG=vX.Y.Z

pnpm install --frozen-lockfile
SIDECARS=1 UPLOAD=1 bash scripts/package/release-macos.sh
```

`TAURI_SIGNING_PRIVATE_KEY` is loaded from `~/.tauri/videodubber.key`
automatically; the key has an **empty password**, which the script also exports.

**`SIDECARS=1` rebuilds the orchestrator (Node SEA), the four PyInstaller
sidecars, static ffmpeg/ffprobe, uv, bundled CPython and `resources/engine-src`
(~25 min) — and it is the only thing that runs the release bundle assertion**
(portable ffmpeg, `minimumSystemVersion` not below any bundled binary's `minos`,
uv + CPython present).

**Omit it ONLY when the change is confined to `src-tauri/src` (the Rust shell)
or `apps/desktop/src` (the Angular UI).** Everything else the app runs is a
SIDECAR built by that step — the Node orchestrator included. Skipping it then
re-bundles the STALE sidecar binaries and produces an installer that looks
correct and does not contain your change. That has happened: a fix to the
orchestrator's engine launch args was "released" twice before anyone noticed the
shipped binary never had it.

For an orchestrator-only change you can rebuild just that sidecar instead of
paying the full ~25 minutes:

```bash
bash scripts/package/build-orchestrator.sh   # ~1 min
UPLOAD=1 RELEASE_TAG=vX.Y.Z bash scripts/package/release-macos.sh
```

Either way, **verify the change reached the assembled app before notarizing** —
grep the bundled binary for a string your change introduced:

```bash
APP=$(find apps/desktop/src-tauri/target -path '*/release/bundle/macos/VideoDubber.app' | head -1)
strings "$APP/Contents/MacOS/videodubber-orchestrator" | grep -c "<a string from your change>"
```

Zero means the sidecar is stale — stop and rebuild it rather than spending a
notarization cycle on an artifact that cannot work.

The script then: runs `tauri build` with the notary creds withheld (so Tauri does
not self-notarize), deep-signs every Mach-O, notarizes, staples, **regenerates**
the signed updater archive from the repaired app, uploads the `.dmg` + updater
artifacts to the `vX.Y.Z` draft, and merges the `darwin-aarch64` entry into
`latest.json`.

> **Expect TWO `Accepted` lines, not one.** The first submission notarizes the
> DMG built from the freshly signed app; the ticket it issues for the nested
> `.app` is stapled to the bundle, and the DMG is rebuilt around the stapled app
> so first launch works offline. Those rebuilt bytes have a cdhash Apple has
> never seen, so `stapler` fails with *"Record not found" / Error 65* — that log
> line is **expected** — and the script resubmits and staples.

### 4. Build + upload Windows — on the Windows desktop

```powershell
git pull origin main
pnpm install --frozen-lockfile
pwsh scripts\package\release-windows.ps1 -Sidecars -Upload
```

The signing key loads from `%USERPROFILE%\.tauri\videodubber.key`; the tag
defaults to `v<version from tauri.conf.json>`. `-Sidecars` follows the same rule
as macOS. This builds a **static** libass ffmpeg (`FFMPEG_PATH`/`FFPROBE_PATH`
are ignored by the build — only `FFMPEG_BIN`/`FFPROBE_BIN` override, and a
non-portable binary is rejected), produces the NSIS `-setup.exe` **and** the
`.msi`, uploads both pairs, and merges **both** `windows-x86_64` and
`windows-x86_64-msi` into `latest.json`.

> **Both Windows installers ship, on purpose.** `tauri-plugin-updater` resolves
> the manifest key as `[{os}-{arch}-{installer}, {os}-{arch}]`, so a machine
> installed from the `.msi` looks for `windows-x86_64-msi` first. Without it,
> those users fall back to the NSIS `.exe`, which uninstalls the MSI through an
> elevated `msiexec` prompt mid-update or leaves two parallel installs. v0.1.0 +
> v0.2.0 have 26 MSI downloads, so this population is real.
>
> Building the `.msi` needs the **WiX toolset** (Tauri fetches it on first use).
> If the build fails there, drop `"msi"` from `bundle.targets` and re-run — the
> MSI merge step is conditional and degrades to NSIS-only.

The installer is unsigned → first launch shows SmartScreen: **More info → Run
anyway**.

### 5. Verify the built artifacts — on the Mac

Before trusting the upload, check the app you just built. Each of these caught a
real shipped defect:

```bash
APP=$(find apps/desktop/src-tauri/target -path '*/release/bundle/macos/VideoDubber.app' | head -1)

# 1. ffmpeg/ffprobe must have NO non-system libraries (v0.3.0 shipped Homebrew-linked
#    binaries that worked only on the build machine — every dub failed elsewhere).
for b in ffmpeg ffprobe; do
  otool -L "$APP/Contents/MacOS/$b" | tail -n +2 | awk '{print $1}' \
    | grep -v -E '^(/usr/lib/|/System/Library/)' && echo "NOT PORTABLE" || echo "$b portable OK"
done

# 2. The .app itself must carry a stapled ticket (offline first launch).
xcrun stapler validate "$APP"
spctl -a -vv "$APP"            # expect: source=Notarized Developer ID

# 3. The declared floor must match reality.
plutil -p "$APP/Contents/Info.plist" | grep -E "LSMinimumSystemVersion|CFBundleShortVersion"
```

If the release contains Rust changes, confirm they are actually in the shipped
binary (a stale build is silent otherwise):

```bash
strings "$APP/Contents/MacOS/videodubber-desktop" | grep -c "<a string from your change>"
```

### 6. Verify the UPLOADED payloads — the last gate

Verify the signatures against the **bytes GitHub is serving**, not the local
files: this catches a wrong key *and* a corrupted upload. A bad signature means
every client rejects the update.

```bash
brew install minisign     # once
cd "$(mktemp -d)"
python3 -c "import base64,json;open('vd.pub','w').write(base64.b64decode(json.load(open('$OLDPWD/apps/desktop/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey']).decode())"
```

Draft assets are not public, so download them through the API with a token:

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
REPO=codertapsu/multilingual-dubbed-video; REL=<RELEASE_ID>
ASSETS=$(curl -sL -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/releases/$REL/assets?per_page=100")
get() { id=$(printf '%s' "$ASSETS" | N="$1" python3 -c "import json,os,sys;print(next(a['id'] for a in json.load(sys.stdin) if a['name']==os.environ['N']))"); \
        curl -sL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" \
             "https://api.github.com/repos/$REPO/releases/assets/$id"; }

for f in VideoDubber_X.Y.Z_aarch64.app.tar.gz VideoDubber_X.Y.Z_x64-setup.exe VideoDubber_X.Y.Z_x64_en-US.msi; do
  get "$f" > "$f"
  get "$f.sig" | python3 -c "import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read().strip()).decode())" > "$f.msig"
  minisign -V -p vd.pub -x "$f.msig" -m "$f"   # expect: Signature and comment signature verified
  rm -f "$f"                                   # ~1.4 GB total — delete as you go
done
```

Note the env var must PREFIX the command (`N="$1" python3 …`); putting it after
passes it as an argument and the lookup silently fails.

Also confirm on the draft:

1. **8 assets when the MSI built** — `.dmg`, `.app.tar.gz` (+`.sig`),
   `-setup.exe` (+`.sig`), `.msi` (+`.sig`), `latest.json`. **6** if you took
   step 4's escape hatch and dropped the `msi` target.
2. **`latest.json`** has `"version": "X.Y.Z"`, always `darwin-aarch64` +
   `windows-x86_64`, plus `windows-x86_64-msi` **iff** the `.msi` shipped.
3. **Tag is `vX.Y.Z`**, not `untagged-<sha>` (else every URL 404s after publish;
   `merge-latest-json.mjs --fix-tag` repairs it automatically).
4. **Every asset's upload time is after** the last fix commit.

### 6.5 Set the release notes

`merge-latest-json.mjs` defaults `notes` to `VideoDubber X.Y.Z`, and that string
is what the **in-app update dialog shows users**. Write something better before
publishing: edit the draft body on GitHub, and re-run the merge once with
`--notes` so the manifest matches.

```bash
node scripts/package/merge-latest-json.mjs --tag vX.Y.Z --platform darwin-aarch64 \
  --artifact <path-to>/VideoDubber_X.Y.Z_aarch64.app.tar.gz \
  --notes "What changed in X.Y.Z…"
```

### 7. Publish

The GitHub UI works (**Publish release**, with *Set as the latest release*
checked), or via the API:

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
REPO=codertapsu/multilingual-dubbed-video
RELEASE_ID=$(curl -sL -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO/releases?per_page=100" \
  | python3 -c "import json,sys;print(next(r['id'] for r in json.load(sys.stdin) if r['tag_name']=='vX.Y.Z'))")

curl -sL -X PATCH -H "Authorization: Bearer $TOKEN" \
  -d '{"draft":false,"prerelease":false,"make_latest":"true"}' \
  "https://api.github.com/repos/$REPO/releases/$RELEASE_ID"
```

`make_latest` is the **string** `"true"`, not a boolean — the API rejects the
boolean form.

> **Publishing creates the `vX.Y.Z` tag from `main`'s HEAD *at publish time*** —
> not from the commit the installers were built from (`ensure_release` sends no
> `target_commitish`). Do not push to `main` between the last platform build and
> Publish, or the tag will point at code that was never built. If `main` did
> advance, either publish first and move the tag afterwards, or rebuild.

### 8. Verify what users actually receive

```bash
# GitHub's 'latest' must be the new tag
curl -sL https://api.github.com/repos/codertapsu/multilingual-dubbed-video/releases/latest | grep '"tag_name"'

# The updater endpoint (public, unauthenticated) must serve the new manifest
curl -sL "https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json"

# Every payload URL must be publicly reachable
for f in VideoDubber_X.Y.Z_aarch64.app.tar.gz VideoDubber_X.Y.Z_x64-setup.exe VideoDubber_X.Y.Z_x64_en-US.msi; do
  curl -sIL -o /dev/null -w "%{http_code} $f\n" -r 0-0 \
    "https://github.com/codertapsu/multilingual-dubbed-video/releases/download/vX.Y.Z/$f"
done     # expect 206 for each
```

Then do the check no amount of manifest inspection replaces: **update a real
machine** from the previous version via Settings → Check for updates. Prioritise
**Windows**, which exercises the pre-install sidecar teardown.

> **Running the upload helpers by hand?** `release-upload.{sh,ps1}` default
> `RELEASE_TAG` to **`v0.1.0`**, not to the current version — a bare
> `bash scripts/package/release-upload.sh upload <file>` uploads into the v0.1.0
> release. Always export `RELEASE_TAG=vX.Y.Z` first. (The release wrappers set it
> for you; this only bites manual recovery.)

### 8.5 Prune old releases — keep only the two newest

Every release carries 0.6-1.9 GB of installers, and old ones serve no purpose:
the updater always reads `releases/latest/download/latest.json`, so a client on
ANY version updates straight to the newest — it never consults the release it is
currently running. Leaving them up just accumulates gigabytes and offers users a
download that is worse than the current one.

Do this AFTER publishing (step 7) and AFTER confirming the endpoint serves the
new version (step 8) — never before, or you delete the fallback while the new
release is still unproven.

```bash
node scripts/package/prune-releases.mjs            # dry run: shows what goes
node scripts/package/prune-releases.mjs --apply    # keeps the 2 newest
```

The script is deliberately conservative:

- **Dry run by default** — deleting a release is irreversible.
- **Never touches drafts** — a draft is usually the next release being
  assembled.
- **Never touches whatever GitHub resolves as `latest`**, even if the date
  ordering disagrees; deleting that breaks auto-update for everyone.
- **Keeps git tags.** The release holds the binaries; the tag is how you check
  out or diff the source a shipped build came from, and it costs nothing. Pass
  `--tags` only if you really want the history gone too.

> A pruned version's installer URLs 404 afterwards. That affects anyone holding
> a direct link to an old download — not existing installs, which keep working,
> and not auto-update, which resolves `latest`.

### 9. Rollback — if the release turns out bad

> **Prune AFTER the release is proven, not before** (step 8.5) — the previous
> release is your only rollback target. If you have already pruned and the new
> release turns out bad, there is nothing to fall back to.

Do **not** delete the release first. Mark it a **pre-release**: the endpoint
resolves to the newest *published, non-prerelease* release, so it falls back to
the previous version immediately, and the bad build stays available for
diagnosis.

```bash
curl -sL -X PATCH -H "Authorization: Bearer $TOKEN" -d '{"prerelease":true}' \
  "https://api.github.com/repos/codertapsu/multilingual-dubbed-video/releases/<RELEASE_ID>"
curl -sL "https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json"
```

Note the endpoint is CDN-cached for a short window — re-check with a cache-buster
before concluding it did not work. Clients on the bad version are **not**
downgraded (the updater only moves forward); they stay put until a newer release
is published.

---

## Hard-won gotchas

Each of these cost a release or a rebuild.

| Gotcha | Why it bites | Guard |
|---|---|---|
| A **runtime** env var steering the **build** | `.env` sets `FFMPEG_PATH` for dev; `fetch-ffmpeg.*` treated it as "stage this binary", so v0.3.0 shipped Homebrew-linked ffmpeg that ran only on the build machine | build-time staging is `FFMPEG_BIN`/`FFPROBE_BIN` only; `assert_portable` + the release gate reject non-portable binaries |
| **Drafts are invisible to the updater** | The endpoint is `releases/latest/…`, i.e. newest *published, non-prerelease* | nothing reaches users until step 7 |
| **A one-sided `latest.json`** | Publishing with only one platform merged makes `check()` error for the other platform's users | step 6.2 |
| **Raising `minimumSystemVersion`** | The updater has no OS gate: it replaces a working app, then the OS refuses to launch it | `unsupported_host_reason()` withholds the offer; a unit test keeps it in sync with `tauri.conf.json` |
| **Sidecars survive the updater's exit** | On Windows they hold `.exe`/`.dll` open, so NSIS fails with "Error opening file for writing" | `on_before_exit` → `sidecar::shutdown_all()` on both update paths |
| **`cfg`-gated symbols in shared code** | Builds on macOS, `E0425` on Windows | step 2 |
| **Rebuilding the DMG invalidates its ticket** | New cdhash ⇒ `stapler` Error 65 | the script resubmits automatically; two `Accepted` lines are normal |
| **Assets built before a mid-release fix** | Silent — the installer looks fine | step 6.4 compares upload time to commit time |
| **A spec/config that PARSES but means something else** | `excludes=["pytest" "av"]` — a missing comma made Python concatenate them into `"pytestav"`, excluding neither, and PyAV shipped anyway. `compile()` proved nothing | read the value back (`ast.literal_eval`) and assert the entries you expect are present |
| **Skipping `-Sidecars` for a non-shell change** | The orchestrator and the Python workers ARE sidecars; without that step the build re-bundles stale binaries and ships an installer missing the fix entirely | step 3's rule, plus grepping the bundled binary for a string the change introduced |

---

The rest of this doc is reference: one-time setup, per-OS detail, signing
internals, and how `latest.json` drives the updater.

---

## One-time setup

### 1. Generate the auto-updater signing key

The Tauri updater verifies every update with a keypair. Generate it **once** and
keep the private key secret forever:

```bash
pnpm tauri signer generate -w ~/.tauri/videodubber.key
# (equivalently: pnpm --filter videodubber-desktop tauri signer generate ...)
```

This prints a **public key** and writes a password-protected **private key**.

* Put the **public key** in `apps/desktop/src-tauri/tauri.conf.json` at
  `plugins.updater.pubkey` (replacing the `REPLACE_WITH_TAURI_UPDATER_PUBKEY`
  placeholder). This is committed.
* Store the **private key** + its password as GitHub secrets (next step). **Never
  commit the private key.**

> Losing the private key means existing installs can no longer verify updates —
> you'd have to ship a new pubkey via a fresh manual install. Back it up securely.

### 2. Set the updater endpoint

In `tauri.conf.json`, `plugins.updater.endpoints` must point at your repo's
`latest.json`:

```
https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json
```

(This is already set to the real repo slug.) `releases/latest/download/...`
always resolves to the newest **published** (non-draft, non-prerelease) release.

### 3. Configure GitHub secrets

Settings → Secrets and variables → Actions. Required / optional:

| Secret | Required | Purpose |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ | Contents of `~/.tauri/videodubber.key`. Signs `latest.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | see note | Password for that key. **The committed key was generated with an *empty* password** — GitHub can't store an empty secret, so instead hardcode `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''` in `release.yml` (or regenerate the key *with* a password and set both this secret and the new pubkey). |
| `APPLE_CERTIFICATE` | macOS | base64 of your Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | Password for the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | macOS | e.g. `Developer ID Application: Name (TEAMID)`. |
| `APPLE_ID` | macOS | Apple ID email for notarization. |
| `APPLE_PASSWORD` | macOS | App-specific password for notarization. |
| `APPLE_TEAM_ID` | macOS | 10-char Apple Team ID. |
| `KEYCHAIN_PASSWORD` | macOS | Throwaway password for the CI temp keychain. |
| `WINDOWS_CERTIFICATE` | Windows (opt) | base64 of your Authenticode `.pfx`. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows (opt) | Password for the `.pfx`. |

`GITHUB_TOKEN` is automatic; the workflow declares `contents: write`.

> To export the macOS cert: in Keychain Access, export the *Developer ID
> Application* identity (cert + private key) as a `.p12`, then
> `base64 -i cert.p12 | pbcopy`. The app-specific password is created at
> <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.

---

## First release (v0.1.0) — historical note

> This documents how the *first* release (v0.1.0) was cut, when auto-update was
> still **off** (`createUpdaterArtifacts: false`) and no signing secrets were
> needed. Since **v0.2.0** auto-update is **on** and releases are signed — follow
> [Cut a release](#cut-a-release--step-by-step) at the top instead. Kept for context.

v0.1.0 shipped with the repo references set, engine-pack URLs pinned +
checksummed, a static portable ffmpeg on all platforms, and auto-update **off** —
so **no secrets were required**:

1. **Build locally + upload** — releases are cut on your own machines (no CI), so
   the 10x-billed macOS runners stay idle. On each machine build the
   self-contained installer and upload it to the shared **draft** release with
   `scripts/package/release-upload.{sh,ps1}`. Full per-OS steps:
   [Local-first release](#local-first-release-build-locally-no-ci).
2. **Review the draft release**, then **Publish** it. Users can now download from
   the Releases page.

> **Why local, not CI?** GitHub's hosted macOS runners bill at 10x (and the DMG
> step is flaky on them). The Release workflow is kept **intact but gated
> per-OS**, so each platform builds either locally or in CI independently — see
> [Per-OS: local build vs CI](#per-os-local-build-vs-ci) below. By default
> **every OS builds locally**; opt an OS into CI by setting its `RELEASE_CI_*`
> variable to `true`.

> **Optional polish (any time):**
> - **Apple notarization / Windows Authenticode** (the secret tables in *One-time
>   setup*). Without them the macOS `.dmg` / Windows installer are unsigned —
>   Gatekeeper / SmartScreen show a first-launch warning (right-click → **Open** on
>   macOS, or `xattr -dr com.apple.quarantine /Applications/VideoDubber.app`).
> - **Auto-update** (a later release): set `createUpdaterArtifacts: true` in
>   `tauri.conf.json`, set `includeUpdaterJson: true` in `release.yml`, and add the
>   `TAURI_SIGNING_PRIVATE_KEY` secret (contents of `~/.tauri/videodubber.key`). That
>   key has an **empty password**, so set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''`
>   directly in `release.yml` (GitHub can't store an empty secret). The pubkey is
>   already committed; regenerate the pair with `pnpm tauri signer generate` if you
>   don't have the private key, or if you'd prefer a password-protected key (safe
>   pre-launch — no installs exist yet; just re-commit the new pubkey).

### Engine-pack assets (one-time, for the macOS Metal whisper.cpp engine)

Only `whisper-cpp-metal` is self-hosted. Build it once and upload it to an
`engine-packs-v1` release on this repo — full recipe in
[`ENGINE_PACKS.md`](ENGINE_PACKS.md#3-self-hosting-the-macos-metal-whispercpp-binary).
Every other engine pack (llama.cpp, neural TTS, separation, alignment) needs no
hosting. Paste the built asset's `shasum -a 256` into the `whisper-cpp-metal`
artifact's `sha256` in `enginePackCatalog.ts`.

---

## Per-OS: local build vs CI

Every target OS has **two** ways to produce a release build, chosen
independently:

- **Local** — run the steps below on that machine and upload with
  `release-upload` (zero Actions minutes).
- **CI** — let `release.yml` build it on a `v*` tag push.

CI is gated **per OS** by repo variables (Settings → Secrets and variables →
Actions → Variables). The `setup` job reads them and builds the matrix; a
disabled OS is omitted, so it provisions **no runner**:

| Variable | Current | Meaning |
|---|---|---|
| `RELEASE_CI_MACOS` | `false` | macOS (arm64) built **locally** on the Mac |
| `RELEASE_CI_WINDOWS` | `false` | Windows built **locally** on the Windows desktop |
| `RELEASE_CI_LINUX` | `false` | Linux not built |

**The project now builds ALL release artifacts locally** — macOS on the Mac,
Windows on the Windows desktop (`D:\development\projects\multilingual-dubbed-video`)
— and uploads them to GitHub with the release scripts below. `RELEASE_CI_WINDOWS`
was set back to `false` after v0.2.0 (the last CI-built Windows release); CI is
kept only as an escape hatch. Set a variable to `true` to build that OS in **CI**
on the next `v*` tag push. **Careful:** a manual **workflow_dispatch** run builds
every OS regardless of the variables — don't trigger one unless you mean to. The
entries + defaults live in `scripts/ci/resolve-release-matrix.py` (runnable
locally to preview the matrix). When CI builds an OS, it uploads to the same
draft the local steps target.

## Local-first release (build locally)

Build any OS on your own machine and upload straight to the GitHub release.

Both machines follow the same shape: bundle the self-contained sidecars, run
`tauri build`, then upload with the release script for that OS
(`release-macos.sh` / `release-windows.ps1`). The upload helper **creates the
tag's draft on first use** and **replaces** same-named assets on re-upload, so
both machines push to the *same* draft and re-runs are idempotent. Auth is the
GitHub token from `git credential` (no `gh` needed); override target with
`GH_REPO` / `RELEASE_TAG` (default: `v<version from tauri.conf.json>`).

> Build the tag you're releasing: `git checkout vX.Y.Z` (or just build current
> `main` — the installer contents are what matter; the tag is bookkeeping).

### macOS (`.dmg`) — on your Mac

Set your Developer ID env once (the cert lives in your login keychain from the
signing setup — see [`APPLE_SIGNING.md`](APPLE_SIGNING.md)):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"   # appleid.apple.com -> App-Specific Passwords
export APPLE_TEAM_ID="<TEAMID>"
```

Then build + sign + notarize + upload with the one-command wrapper:

```bash
pnpm install --frozen-lockfile
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/videodubber.key)"   # updater .sig signing
SIDECARS=1 UPLOAD=1 bash scripts/package/release-macos.sh
```

`release-macos.sh` runs `tauri build` with the notary creds **withheld** (so
`tauri build` signs the shell but does NOT try to notarize — its signing can't
reach the bundled PyInstaller worker `.so` files, which makes an in-build
notarization fail), then `macos-sign-notarize.sh` deep-signs **every** Mach-O +
notarizes + staples. It then **regenerates the auto-update archive from the
repaired app** (`VideoDubber_<ver>_aarch64.app.tar.gz` + `.sig` — the archive
`tauri build` emitted is from the PRE-repair app and must not ship), and with
`UPLOAD=1` uploads the `.dmg` + updater artifacts to the tag's draft and merges
the `darwin-aarch64` entry into the release's `latest.json`
(`merge-latest-json.mjs` — preserves the windows entry if it's already there).

> **Why the deep-sign pass (and how to troubleshoot it):** see
> [`APPLE_SIGNING.md`](APPLE_SIGNING.md) — why `tauri build` alone isn't
> notarizable, what the deep-sign step covers, and how to debug signing /
> notarization failures.

> **Doing the steps by hand?** You MUST keep the notary creds out of the
> `tauri build` environment, or it notarizes itself and fails:
> ```bash
> env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID pnpm app:build
> bash scripts/package/macos-sign-notarize.sh
> bash scripts/package/release-upload.sh upload \
>   apps/desktop/src-tauri/target/release/bundle/dmg/VideoDubber_*_aarch64.dmg
> ```

Verify it's self-contained first (should print `portable` — no `/opt/homebrew`):

```bash
otool -L apps/desktop/src-tauri/target/release/bundle/macos/VideoDubber.app/Contents/MacOS/ffmpeg \
  | grep -E '/opt/|/usr/local|homebrew' && echo "NON-PORTABLE" || echo "portable"
```

> Want an **unsigned** `.dmg` instead? Skip `macos-sign-notarize.sh`, run
> `pnpm dmg:instructions <dmg>` so the Gatekeeper unlock ships inside the image,
> then upload the `tauri build` output from `.../bundle/dmg/`. Notarization is the
> better experience (plain double-click), so prefer it when you can.

### Windows (`.exe`) — on your Windows desktop

Project checkout: `D:\development\projects\multilingual-dubbed-video`.

**One-time machine setup** (mirrors what the CI runner had):

1. **PowerShell 7** (`pwsh`) — the build scripts use PS7-only parameters; do not
   run them in Windows PowerShell 5.1.
2. **Node 24** + `corepack enable` (pnpm 11.9 needs `node:sqlite` → Node ≥ 22.12;
   CI pinned 24).
3. **Rust stable (MSVC)** — `rustup` with the `x86_64-pc-windows-msvc` target +
   Visual Studio Build Tools (C++).
4. **Python 3.12** on PATH, then create the three worker venvs once:
   `pwsh scripts/setup-local-models.ps1` (model downloads are skippable —
   the venvs are what the sidecar build needs).
5. **Updater signing key** — copy `~/.tauri/videodubber.key` from the Mac to
   `~\.tauri\videodubber.key` on the Windows box (it is a **secret**: transfer
   it privately — AirDrop/USB, not chat/email). Without it the build emits no
   `.sig` files and the auto-updater can never install the release.
6. **GitHub token** — sign in once so `git credential` has a token (or set
   `$env:GH_TOKEN`).
7. **FFmpeg: do NOT set `FFMPEG_PATH`.** The sidecar build auto-downloads a
   **static** libass-enabled build (BtbN `win64-gpl` .zip) — that is the one to
   ship. A locally installed ffmpeg like gyan.dev's
   `ffmpeg-release-full-shared` (e.g. in `D:\ffmpeg`) **cannot be bundled**: the
   app ships `ffmpeg.exe` alone as a sidecar, and a *shared* build needs its
   `av*.dll`s next to it — fine for desktop use, broken inside the installed
   app. `fetch-ffmpeg.ps1` now detects and rejects shared builds. If you must
   stage a local copy (offline builds), use a **static single-file** build
   (BtbN `win64-gpl`, or gyan's non-shared `ffmpeg-release-full.7z`).

**Per release** — one command:

```powershell
pnpm install --frozen-lockfile
pwsh scripts/package/release-windows.ps1 -Sidecars -Upload
```

`release-windows.ps1` loads the signing key (env var or `~\.tauri\videodubber.key`),
builds the sidecars (`build-sidecars.ps1`), runs `tauri build` — `bundle.targets`
is `["app","dmg","nsis","msi"]`, so Windows produces **both** the NSIS
`-setup.exe` and (when WiX succeeds) the `.msi`, each with an updater `.sig` —
uploads both pairs to the tag's draft (`release-upload.ps1`), and merges **both**
the `windows-x86_64` and `windows-x86_64-msi` entries into the release's
`latest.json` (`merge-latest-json.mjs` — preserves the mac entry if it's already
there). Both installers ship because the updater looks up
`{os}-{arch}-{installer}` before `{os}-{arch}`, so MSI-installed users need their
own key (see [step 4](#4-build--upload-windows--on-the-windows-desktop)). The installer is unsigned (no
Authenticode cert), so first-run shows SmartScreen: **More info → Run anyway**.

### Publish

Both machines upload to the same draft (found by tag) — order doesn't matter;
whichever merges `latest.json` second preserves the other's platform entry.
Before publishing, check on the draft:

1. Assets: mac `.dmg` + `VideoDubber_<ver>_aarch64.app.tar.gz(.sig)`, Windows
   `-setup.exe(.sig)`, and `latest.json`.
2. `latest.json` contains **both** `darwin-aarch64` and `windows-x86_64` entries
   and `version` matches the tag.
3. The draft's tag is the real `vX.Y.Z` (the merge script's `--fix-tag` repairs
   a stray `untagged-<sha>` draft) — otherwise every download URL in
   `latest.json` 404s after publish.

Then **Publish** on the Releases page — publishing is what makes
`releases/latest/download/latest.json` (the updater endpoint) point at this
version. Assets can still be added after publishing if needed.

> **Intel (x86_64) macOS / Linux** aren't part of the two-machine flow yet — ship
> Apple-Silicon + Windows now and add them later (or run the manual CI workflow
> scoped to just those targets).

> **Re-cutting a draft:** the upload helper overwrites same-named assets in
> place, so you do NOT need to delete the draft or move the tag between
> iterations — just rebuild and re-run the release script.

---

## Per-release steps (reference)

The ordered runbook is **[Cut a release — step by step](#cut-a-release--step-by-step)**
at the top. This section keeps two extra reference details.

### Sanity-build before releasing (optional)

Catch packaging breakage before you build the real release:

```bash
pnpm package:sidecars     # orchestrator + workers + piper + ffmpeg for your host
pnpm app:build            # a local installer under apps/desktop/src-tauri/target
```

Verify it launches, the first-run wizard appears, and a tiny dub completes (needs
the worker venvs — `scripts/setup-local-models.sh`).

> **ffmpeg for a local sanity build.** `package:sidecars` always downloads a
> **static** libass ffmpeg. `FFMPEG_PATH`/`FFPROBE_PATH` are the orchestrator's
> **runtime** vars and are deliberately ignored by every build script — that
> separation is exactly why v0.3.0's bug cannot recur. To stage a local binary
> anyway, set `FFMPEG_BIN`+`FFPROBE_BIN`; it must be a **static** build, or
> `assert_portable` (macOS/Linux) and the shared-build check (Windows) reject
> it.

### CI fallback (normally off)

`RELEASE_CI_MACOS` / `RELEASE_CI_WINDOWS` are `false`, so pushing a `v*` tag builds
nothing — releases are local (§[Cut a release](#cut-a-release--step-by-step)). To
build an OS in **CI** instead, set its variable to `true` before the tag push; CI
then uploads to the same draft the local steps target. A manual
**workflow_dispatch** run builds **every** OS regardless of the variables, so don't
trigger one unintentionally.

---

## Code signing & notarization details

### macOS (notarytool)

`tauri build` (via tauri-action) signs the `.app`/`.dmg` with
`APPLE_SIGNING_IDENTITY`, then submits to Apple's notary service using
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` and staples the ticket. Without
this, Gatekeeper blocks the app on other Macs ("can't be opened because Apple
cannot check it for malicious software").

* The CI imports the `.p12` into a temporary keychain before `tauri build`.
* **Nested binaries:** Tauri does NOT deep-sign Mach-O shipped under
  `bundle.resources` (our bundled CPython + PyInstaller workers), so a dedicated
  CI step signs them (hardened runtime + timestamp + entitlements) **before**
  `tauri-action` bundles + notarizes. Entitlements live in
  `apps/desktop/src-tauri/entitlements.plist` (`bundle.macOS.entitlements`).
* Universal vs. per-arch: we build **per-arch** (arm64 on macos-14, x64 on
  macos-13) so each `.dmg` is native. Users download the one for their Mac.

> **Full step-by-step (cert creation, the 7 secrets, the nested-binary fix,
> verification, troubleshooting):** see **[`APPLE_SIGNING.md`](APPLE_SIGNING.md)**.

### Windows (Authenticode)

If `WINDOWS_CERTIFICATE` is set, the `-setup.exe` is Authenticode-signed, which
avoids the SmartScreen "unknown publisher" warning. Unsigned builds still work but
show that warning. EV certificates clear SmartScreen reputation fastest.

### Linux

`.deb` and `.AppImage` are not code-signed in the OS sense; integrity comes from
the updater signature on the AppImage and from the HTTPS GitHub download.

---

## How `latest.json` drives the updater

`bundle.createUpdaterArtifacts: true` makes Tauri emit, per platform, an update
archive + a detached `.sig` signed with `TAURI_SIGNING_PRIVATE_KEY`.
`merge-latest-json.mjs` assembles these into a single `latest.json`, one platform
per invocation (tauri-action does it only for an OS opted into CI). The real
v0.4.0 manifest:

```jsonc
{
  "version": "0.4.0",
  "notes": "…release notes…",
  "pub_date": "2026-08-01T17:02:24.039Z",
  "platforms": {
    // macOS (Apple Silicon) — the .app.tar.gz, NOT the .dmg
    "darwin-aarch64":     { "signature": "…", "url": ".../v0.4.0/VideoDubber_0.4.0_aarch64.app.tar.gz" },
    // Windows installed from the NSIS setup.exe
    "windows-x86_64":     { "signature": "…", "url": ".../v0.4.0/VideoDubber_0.4.0_x64-setup.exe" },
    // Windows installed from the .msi — looked up FIRST by those clients
    "windows-x86_64-msi": { "signature": "…", "url": ".../v0.4.0/VideoDubber_0.4.0_x64_en-US.msi" }
  }
}
```

The installed app fetches this from the configured endpoint, compares `version`
to its own, downloads the matching platform archive, and **verifies the signature
with the embedded pubkey** before installing. Full flow + the in-app
auto/manual setting: [`AUTOUPDATE.md`](AUTOUPDATE.md).

---

## Troubleshooting releases

| Symptom | Likely cause / fix |
|---|---|
| `latest.json` missing from the release | `bundle.createUpdaterArtifacts` not `true`, or `TAURI_SIGNING_PRIVATE_KEY` unset → no updater artifacts emitted. |
| Update found but install fails with a signature error | App's `plugins.updater.pubkey` doesn't match the private key that signed `latest.json`. Regenerate consistently. |
| macOS "app is damaged / can't be opened" | Notarization failed or wasn't run (missing `APPLE_*` secrets). Check the notarytool log in the job. |
| PyInstaller worker crashes on launch in the bundle | Missing hidden import/data file — add it to the worker's `.spec` `hiddenimports`/`datas` and re-release. Run the frozen binary directly to see the traceback. |
| ffmpeg burned-in subtitles fail in the bundle | The fetched ffmpeg lacks libass. `fetch-ffmpeg` verifies the `subtitles` filter; ensure a `-gpl`/full build is used. |
| Sidecar "not found" at runtime | The binary wasn't named `<base>-<target-triple>` for the build host — see `apps/desktop/src-tauri/binaries/README.md`. |
