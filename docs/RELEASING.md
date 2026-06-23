# Releasing VideoDubber

End-to-end runbook for cutting a signed, auto-updatable release. The CI workflow
[`.github/workflows/release.yml`](../.github/workflows/release.yml) does the heavy
lifting; this doc is the human checklist around it.

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
> step is flaky on them). Building on your Mac + Windows desktop is free and
> repeatable. The Release workflow still exists but is **manual-only**
> (`workflow_dispatch`) — a `v*` tag push no longer triggers a build.

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

## Local-first release (build locally, no CI)

Releases are built on your own machines and uploaded straight to the GitHub
release — zero Actions minutes. The Release workflow is kept as a manual escape
hatch (`workflow_dispatch`) but a tag push no longer triggers it.

Both machines follow the same shape: bundle the self-contained sidecars, run
`tauri build`, then upload with `release-upload`. The helper **creates the
`v0.1.0` draft on first use** and **replaces** same-named assets on re-upload, so
both machines push to the *same* draft and re-runs are idempotent. Auth is the
GitHub token from `git credential` (no `gh` needed); override target with
`GH_REPO` / `RELEASE_TAG`.

> Build the tag you're releasing: `git checkout v0.1.0` (or just build current
> `main` — the installer contents are what matter; the tag is bookkeeping).

### macOS (`.dmg`) — on your Mac

```bash
pnpm install --frozen-lockfile
pnpm package:sidecars          # orchestrator + workers + piper + uv + static ffmpeg
pnpm app:build                 # tauri build -> .app + .dmg

# Sign + notarize with your Developer ID. The cert lives in your login keychain
# from the signing setup (see APPLE_SIGNING.md); set these once per shell:
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"   # appleid.apple.com -> App-Specific Passwords
export APPLE_TEAM_ID="<TEAMID>"
bash scripts/package/macos-sign-notarize.sh        # repair frameworks, sign, notarize, staple

# Upload the notarized .dmg to the draft release:
bash scripts/package/release-upload.sh upload \
  apps/desktop/src-tauri/target/release/bundle/dmg/VideoDubber_*_aarch64.dmg
```

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

```powershell
pnpm install --frozen-lockfile
pwsh scripts/package/build-sidecars.ps1     # orchestrator + workers + piper + uv + static ffmpeg
pnpm app:build                              # tauri build -> NSIS .exe + .msi

# Upload to the SAME draft release (unsigned -> SmartScreen: More info -> Run anyway):
pwsh scripts/package/release-upload.ps1 -Upload `
  apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe `
  apps/desktop/src-tauri/target/release/bundle/msi/*_en-US.msi
```

### Publish

Both machines upload to the same `v0.1.0` draft (found by tag). When the
platforms you're shipping are attached, review the draft on the **Releases** page
and **Publish**. Assets can be added after publishing, so publish what you have
and attach the rest later.

> **Intel (x86_64) macOS / Linux** aren't part of the two-machine flow yet — ship
> Apple-Silicon + Windows now and add them later (or run the manual CI workflow
> scoped to just those targets).

> **Re-cutting `v0.1.0`:** the upload helper overwrites same-named assets in
> place, so you do NOT need to delete the draft or move the tag between
> iterations — just rebuild and re-run `release-upload`.

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

CI triggers on a `v*` tag:

```bash
git tag v0.2.0
git push origin v0.2.0
# (and push the release branch / open the PR if you bumped versions there)
```

This starts the **Release** workflow across macOS-arm64, macOS-x64, Windows, and
Linux. Each runner:

1. installs Node/pnpm/Python/Rust + (Linux) Tauri system deps,
2. creates the three worker venvs and freezes them with PyInstaller,
3. builds the orchestrator (Node SEA) and fetches libass-enabled ffmpeg,
4. runs `tauri build` (signing + notarizing) and uploads the installers + the
   updater `latest.json` to a **draft** GitHub Release.

### 4. Review the draft release

In GitHub → Releases, the workflow created/updated a **draft** for the tag.
Check that:

* All four platforms uploaded their installers (`.dmg`, `.app.tar.gz` +
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
