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
https://github.com/OWNER/REPO/releases/latest/download/latest.json
```

Replace `OWNER/REPO` with the real GitHub slug (e.g. `videodubber/videodubber`).
`releases/latest/download/...` always resolves to the newest **published**
(non-draft, non-prerelease) release.

### 3. Configure GitHub secrets

Settings → Secrets and variables → Actions. Required / optional:

| Secret | Required | Purpose |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ | Contents of `~/.tauri/videodubber.key`. Signs `latest.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ✅ | Password for that key. |
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
pnpm package:sidecars     # builds orchestrator + 3 workers + ffmpeg for your host
pnpm app:build            # produces a local installer in apps/desktop/src-tauri/target
```

Verify the local bundle launches, the first-run wizard appears, and a tiny dub
completes. (You need the worker venvs present — `scripts/setup-local-models.sh`.)

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
* Universal vs. per-arch: we build **per-arch** (arm64 on macos-14, x64 on
  macos-13) so each `.dmg` is native. Users download the one for their Mac.

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
    "darwin-aarch64": { "signature": "…", "url": "https://github.com/OWNER/REPO/releases/download/v0.2.0/VideoDubber_aarch64.app.tar.gz" },
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
