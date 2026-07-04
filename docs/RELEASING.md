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

## First release (v0.1.0) — quickstart

The repo references are set (`codertapsu/multilingual-dubbed-video`), the
engine-pack URLs are pinned + checksummed, all platforms bundle a **static,
portable** ffmpeg, and v0.1.0 ships with auto-update **off**
(`bundle.createUpdaterArtifacts: false`) — so **no secrets are required** to cut
the first release:

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

### Windows (`.exe` + `.msi`) — on your Windows desktop

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
builds the sidecars (`build-sidecars.ps1`), runs `tauri build` (NSIS `-setup.exe`
+ `.msi`, each with an updater `.sig`), verifies all four artifacts, uploads them
to the tag's draft (`release-upload.ps1`), and merges the `windows-x86_64` entry
into the release's `latest.json` (`merge-latest-json.mjs` — preserves the mac
entry if it's already there). Installers are unsigned (no Authenticode cert), so
first-run shows SmartScreen: **More info → Run anyway**.

### Publish

Both machines upload to the same draft (found by tag) — order doesn't matter;
whichever merges `latest.json` second preserves the other's platform entry.
Before publishing, check on the draft:

1. Assets: mac `.dmg` + `VideoDubber_<ver>_aarch64.app.tar.gz(.sig)`, Windows
   `-setup.exe(.sig)` + `.msi(.sig)`, and `latest.json`.
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

## Per-release steps

### 1. Bump the version

Keep these in sync (they all start at `0.1.0`):

* root `package.json` → `version`
* `apps/desktop/package.json` → `version`
* `apps/desktop/src-tauri/tauri.conf.json` → `version`
* `apps/desktop/src-tauri/Cargo.toml` → `[package].version`

The Tauri **app version** is what the updater compares against `latest.json`.

```bash
# example bump to 0.2.0 — review each file, don't blindly sed.
# Then commit on a release branch (don't push straight to main if protected).
git checkout -b release/v0.2.0
git commit -am "release: v0.2.0"
```

### 2. Sanity-build sidecars locally (optional but recommended)

Catch packaging breakage before CI:

```bash
pnpm package:sidecars     # builds orchestrator + workers + piper + ffmpeg for your host
pnpm app:build            # produces a local installer in apps/desktop/src-tauri/target
```

Verify the local bundle launches, the first-run wizard appears, and a tiny dub
completes. (You need the worker venvs present — `scripts/setup-local-models.sh`.)

> **ffmpeg for local builds.** `package:sidecars` loads `.env`, and
> `fetch-ffmpeg` stages a **local** libass-enabled ffmpeg from
> `FFMPEG_PATH`/`FFPROBE_PATH` (or `FFMPEG_BIN`/`FFPROBE_BIN`) when set —
> no download. On macOS, `brew install ffmpeg-full` and point `.env` at it:
> ```
> FFMPEG_PATH=$(brew --prefix ffmpeg-full)/bin/ffmpeg
> FFPROBE_PATH=$(brew --prefix ffmpeg-full)/bin/ffprobe
> ```
> If neither is set, it auto-tries Homebrew, else needs `FFMPEG_URL`/`FFPROBE_URL`.
> Locally-staged binaries are dynamically linked (run on **your** machine only);
> **distributable** builds must use a STATIC libass ffmpeg (set the URLs in CI).

### 3. Tag and push

Push a `v*` tag for bookkeeping (and to trigger CI **only for any OS you opted
into** via `RELEASE_CI_*`):

```bash
git tag v0.2.0
git push origin v0.2.0
# (and push the release branch / open the PR if you bumped versions there)
```

The `setup` job in `release.yml` reads the `RELEASE_CI_*` variables and builds the
matrix: an OS left at the default (`false`) is **omitted** — no runner is
provisioned, and you build/upload it locally per [Local-first release](#local-first-release-build-locally).
For each OS that **is** opted into CI, the runner:

1. installs Node/pnpm/Python/Rust + (Linux) Tauri system deps,
2. creates the three worker venvs and freezes them with PyInstaller,
3. builds the orchestrator (Node SEA) and fetches libass-enabled ffmpeg,
4. runs `tauri build` (signing + notarizing) and uploads the installers + the
   updater `latest.json` to the same **draft** GitHub Release the local steps target.

(A manual **workflow_dispatch** run builds every OS regardless of the variables.)

### 4. Review the draft release

In GitHub → Releases, find the **draft** for the tag (created by `release-upload`
on first local upload, and/or updated by any opted-in CI runner). Check that:

* Every platform you're shipping uploaded its installers (`.dmg`, `.app.tar.gz` +
  `.app.tar.gz.sig`, `.msi`/`.exe` + `.sig`, `.deb`, `.AppImage` + `.sig`).
* `latest.json` is present and lists every platform with a signature.
* Release notes are accurate (edit the body as needed).

### 5. Publish

Click **Publish release** (remove the draft flag). Publishing is what makes
`releases/latest/download/latest.json` resolve to this version — i.e. it's the
moment existing installs start seeing the update. See
[`AUTOUPDATE.md`](AUTOUPDATE.md).

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

If `WINDOWS_CERTIFICATE` is set, the `.msi`/`.exe` are Authenticode-signed,
which avoids the SmartScreen "unknown publisher" warning. Unsigned builds still
work but show that warning. EV certificates clear SmartScreen reputation fastest.

### Linux

`.deb` and `.AppImage` are not code-signed in the OS sense; integrity comes from
the updater signature on the AppImage and from the HTTPS GitHub download.

---

## How `latest.json` drives the updater

`bundle.createUpdaterArtifacts: true` makes Tauri emit, per platform, an update
archive + a detached `.sig` signed with `TAURI_SIGNING_PRIVATE_KEY`. tauri-action
assembles these into a single `latest.json`:

```jsonc
{
  "version": "0.2.0",
  "notes": "…release notes…",
  "pub_date": "2026-06-10T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "…", "url": "https://github.com/codertapsu/multilingual-dubbed-video/releases/download/v0.2.0/VideoDubber_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "…" },
    "windows-x86_64": { "signature": "…", "url": "…" },
    "linux-x86_64":   { "signature": "…", "url": "…" }
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
