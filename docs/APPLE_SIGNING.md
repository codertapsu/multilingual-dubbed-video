# Apple Developer ID signing & notarization (macOS)

This is the end-to-end runbook for making VideoDubber's macOS `.dmg` open with a
**plain double-click** — no `xattr` unlock, no right-click → Open, no "Apple
cannot check it for malicious software." Any developer with the project's Apple
Developer account can follow this.

It requires two things from Apple, which the CI does in one `tauri build`:

1. **Code signing** with a *Developer ID Application* certificate, and
2. **Notarization** — Apple scans the build and issues a ticket that gets
   **stapled** into the `.dmg` (so Gatekeeper trusts it, even offline).

> **The repo is already wired.** [`.github/workflows/release.yml`](../.github/workflows/release.yml)
> imports the `.p12` into a temporary keychain, deep-signs the bundled resource
> binaries (see Phase 5), and hands `tauri-action` the `APPLE_*` env vars so it
> signs + notarizes + staples + uploads. **Everything is gated behind
> `HAS_APPLE_CERT = (secrets.APPLE_CERTIFICATE != '')`** — with the secrets unset,
> macOS builds are simply unsigned (and carry the one-time `xattr` note). The
> moment the 7 secrets exist, signing turns on. The only ongoing work is keeping
> the cert valid and the secrets in place.

## The 7 GitHub secrets (the contract)

Repo → **Settings → Secrets and variables → Actions**. The workflow expects
exactly these names:

| Secret | What it is | Where it comes from |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application **`.p12`** | Phase 2 |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` | Phase 2 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)` | Phase 3 |
| `APPLE_ID` | the Apple Account email (notarization) | Phase 1 |
| `APPLE_PASSWORD` | an **app-specific password** (notarization) | Phase 3 |
| `APPLE_TEAM_ID` | the 10-char Team ID | Phase 3 |
| `KEYCHAIN_PASSWORD` | any random throwaway string (locks the temp CI keychain) | invent one |

---

## Phase 1 — Apple Developer Program ($99/year)

- A **Mac** with **Xcode** (or `xcode-select --install`) — you need it to create
  the certificate's private key (can't be done in a browser) and to run
  `notarytool` (Xcode 14+; `altool` was discontinued 2023-11-01).
- **Apple Developer Program — USD $99/year.** Same price for **Individual**
  (fastest, ~24–48 h, ships under your legal name) or **Organization** (needs a
  **D-U-N-S number** + verification, ~days–2 weeks). Do **not** buy the $299
  "Enterprise" program. Enroll: <https://developer.apple.com/programs/enroll/>.
  A *free* Apple account **cannot** create a Developer ID certificate.
- **Two-factor authentication** must be on for the Apple Account used.

## Phase 2 — Create the Developer ID Application certificate

**2a. Generate a CSR** (creates the private key in *this* Mac's login keychain —
do 2a–2d on the same machine):
- **Keychain Access → Certificate Assistant → Request a Certificate from a
  Certificate Authority…**
- *User Email Address* = your email (just a label, not validated, never appears
  in the cert). *Common Name* = e.g. `Khanh Dev Key`. *CA Email Address* = **empty**.
  Select **Saved to disk**. → writes `CertificateSigningRequest.certSigningRequest`.

**2b. Create the cert** at <https://developer.apple.com/account/resources> →
**Certificates** → **+** → **Software → Developer ID** → **Developer ID
Application** ("A certificate used to sign a Mac app").
- ⚠️ **Not** *Apple Distribution* / *Mac App Distribution* — those are App-Store
  only and Gatekeeper rejects them for direct download.
- Upload the `.certSigningRequest` → **Download** the `.cer`.

**2c. Install:** double-click the `.cer` → **login keychain → My Certificates**,
paired with the private key.

**2d. Export `.p12`:** Keychain Access → login → My Certificates → find
**`Developer ID Application: NAME (TEAMID)`** → confirm a private key is nested
under it → right-click → **Export** → **Personal Information Exchange (.p12)** →
set a strong password (→ `APPLE_CERTIFICATE_PASSWORD`).

**2e. Base64-encode** (GitHub secrets are text, the `.p12` is binary):
```bash
base64 -i Certificates.p12 | pbcopy     # clipboard → APPLE_CERTIFICATE ; then delete the .p12
```

## Phase 3 — The other credentials

- **App-specific password** (`notarytool` can't use your normal password):
  <https://account.apple.com> → **Sign-In and Security → App-Specific Passwords**
  → Generate → label `notarytool` → copy `abcd-efgh-ijkl-mnop` (shown once) →
  **`APPLE_PASSWORD`**.
- **Team ID:** <https://developer.apple.com/account> → **Membership** → 10-char
  Team ID → **`APPLE_TEAM_ID`**.
- **Signing identity string:** `security find-identity -v -p codesigning` → copy
  the quoted `Developer ID Application: NAME (TEAMID)` → **`APPLE_SIGNING_IDENTITY`**.
- **`APPLE_ID`** = your Apple Account email. **`KEYCHAIN_PASSWORD`** = any random
  string (e.g. `openssl rand -base64 24`).

## Phase 4 — Add the 7 secrets

Paste each into **Settings → Secrets and variables → Actions → New repository
secret**, using the exact names in the table above. No workflow edits are needed
to turn signing on.

## Phase 5 — Nested binaries (already handled in this repo — here's why)

**The catch for this app:** notarization requires that **every** Mach-O inside
the `.app` (executables, `.dylib`, `.so`) is Developer-ID-signed, with the
**hardened runtime** and a **secure timestamp**. `tauri-action` auto-signs the
app's main binary **and the `externalBin` sidecars** (`videodubber-orchestrator`,
`vd-piper`, `vd-uv`, `ffmpeg`, `ffprobe`) — but it does **NOT** deep-sign Mach-O
shipped under **`bundle.resources`**. VideoDubber ships a lot there: a standalone
**CPython** (`resources/python`) and the **PyInstaller** worker trees
(`resources/workers`, full of `.so`/`.dylib`/executables). Unsigned, the notary
service rejects the build.

Three pieces handle this (already committed):

1. **[`apps/desktop/src-tauri/entitlements.plist`](../apps/desktop/src-tauri/entitlements.plist)** —
   the hardened-runtime exceptions a bundled Node (V8 JIT) + CPython need:
   `com.apple.security.cs.allow-jit`,
   `com.apple.security.cs.allow-unsigned-executable-memory`,
   `com.apple.security.cs.disable-library-validation`. The last is load-bearing:
   the bundled Python `dlopen`s many third-party `.so`/`.dylib` (numpy,
   onnxruntime, ctranslate2, …) that don't share our Team ID — Library Validation
   would block them.
2. **`tauri.conf.json` → `bundle.macOS.entitlements`** points Tauri at that file
   so it applies the entitlements when it signs the app + sidecars. (Hardened
   runtime is on by default in Tauri — no need to set it.)
3. **A post-build notarization pipeline.** There's a second, subtler problem:
   Tauri's resource copy **dereferences symlinks**, which flattens PyInstaller's
   bundled `Python.framework` into a *malformed* framework — its binaries then
   fail notarization with *"The signature of the binary is invalid."* Pre-signing
   can't survive that, and `tauri-action` signs **and** notarizes in one step with
   no hook in between. So the CI:
   - hands `tauri-action` only the **certificate** vars (it signs the app but
     does **not** notarize — we withhold `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`),
     then
   - runs **`scripts/package/macos-sign-notarize.sh`** ("Sign + notarize (macOS)")
     against the built `.app`: it **repairs** each framework's symlink structure,
     re-signs it as a bundle, signs the loose resource Mach-O (entitlements on the
     executables), re-seals the `.app`, **rebuilds the `.dmg`** from the repaired
     app, and finally `notarytool submit --wait` + `stapler staple` + replaces the
     release's `.dmg` asset.

   (The in-DMG "Open Me First" step is skipped for notarized builds — a notarized
   `.dmg` needs no unlock, and editing it would break the staple.)

> **First-run reality check (important).** The exact set of nested binaries can
> shift with the bundled CPython / PyInstaller output. If notarization fails,
> open the macOS job and read the `notarytool` log (it lists the offending
> paths), or locally:
> `xcrun notarytool log <submission-id> --apple-id … --team-id … --password …`.
> Then make sure those paths are covered by the deep-sign step. Don't guess —
> the log is ground truth.

## Phase 6 — Re-cut the release & verify

1. Push the tag (CI triggers on `v*`). Per project convention the version stays
   pinned at **v0.1.0** (see [`RELEASING.md`](RELEASING.md)) — move the tag and
   replace the draft rather than bumping:
   ```bash
   git tag -f v0.1.0 && git push -f origin v0.1.0
   ```
2. Watch **Actions → Release**. On failure, read the `notarytool` log (Phase 5).
3. Verify the produced `.dmg` (download it from the draft, or check on the
   runner / locally):
   ```bash
   spctl -a -t open -vvv --context context:primary-signature VideoDubber_*.dmg
   #   PASS:  accepted   source=Notarized Developer ID
   xcrun stapler validate VideoDubber_*.dmg          # "The validate action worked!"
   ```
   **Gold test:** on a *different* Mac, download the `.dmg` via Safari (so it gets
   quarantined), turn **networking off**, and double-click — it must open with no
   warning.
4. **Publish** the draft (Releases → the tag's draft → **Publish release**). Once
   notarization works you can delete the `xattr` first-launch note from the
   README / release body and stop running `pnpm dmg:instructions` — notarization
   removes the need entirely.

## Phase 7 — Common errors → fixes

| `notarytool` / Gatekeeper message | Cause → fix |
|---|---|
| "The code object is not signed at all" / "not signed with a valid Developer ID" | a nested `resources/python`/`resources/workers` Mach-O slipped past the deep-sign step → confirm the path is under `apps/desktop/src-tauri/resources/` and re-run |
| "The signature of the binary is invalid" on a `*.framework/…` path (e.g. PyInstaller's `Python.framework/Python`) | a framework's inner binary was signed directly instead of the **framework bundle** → sign the `*.framework` directory itself (`codesign … Python.framework`); the deep-sign step does this and excludes framework internals from the loose-file pass |
| "The signature does not include a secure timestamp" | signed without `--timestamp` (network blip on the TSA?) → re-run; the step always passes `--timestamp` |
| "The executable does not have the hardened runtime enabled" | signed without `--options runtime` → the step always passes it; check a manual/local sign |
| "library load disallowed by system policy" (at **runtime**, after install) | missing `disable-library-validation`, or the interpreter wasn't signed with `--entitlements` → both are in place; verify with `codesign -d --entitlements - <interpreter>` |
| app killed with **CODESIGNING** on launch | Python/Node need writable+executable memory → ensure `allow-jit` + `allow-unsigned-executable-memory` are applied to those binaries |
| "app is damaged / can't be opened" on another Mac | notarization didn't run or the `.dmg` wasn't stapled → confirm the `APPLE_*` notarization secrets are set; tauri-action staples automatically |
| `SecKeychainItemImport … parameters … not valid` in the CI cert-import step | `APPLE_CERTIFICATE` is empty/garbled → re-paste the base64 from Phase 2e |
| first-open blocked only when **offline** | `.dmg` not stapled → tauri-action staples; if signing locally, `xcrun stapler staple` the exact `.dmg` you ship |
| **local build:** notarization `Invalid`, "not signed with a valid Developer ID certificate" on `Contents/MacOS/{ffmpeg,ffprobe,vd-uv,vd-piper,videodubber-orchestrator}` | a local `tauri build` only **adhoc**-signs the externalBin (CI's tauri-action Developer-ID-signs them) → `macos-sign-notarize.sh` now signs `Contents/MacOS` too; just run it |
| **local build:** notarization `Invalid` on `resources/workers/**/_internal/*.so` during `pnpm app:build` | the notary creds were in the env, so `tauri build` notarized **itself** (its signing misses the worker `.so`) → build with `env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID pnpm app:build`, or just use `release-macos.sh` |
| **local build:** `failed to bundle project: failed to run xattr` | the static `ffmpeg`/`ffprobe` ship read-only (0555) and carry the restricted `com.apple.provenance` xattr; Tauri's `xattr -cr` needs write permission → `fetch-ffmpeg.sh` now installs them `0755` (re-run `pnpm package:sidecars`, or `chmod u+w` the two binaries) |

## Signing + notarizing a locally-built `.dmg`

This is the path when macOS is built **locally** (the `RELEASE_CI_MACOS` flag is
off — see [`RELEASING.md`](RELEASING.md#per-os-local-build-vs-ci)). The cert must
be in your login keychain (Phase 2). Export the four vars and use the
one-command wrapper:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id>"; export APPLE_PASSWORD="<app-specific-pw>"; export APPLE_TEAM_ID="<TEAMID>"
SIDECARS=1 UPLOAD=1 bash scripts/package/release-macos.sh
```

### Why it's not just `tauri build` — the deep-sign pass is mandatory

VideoDubber bundles **hundreds** of third-party/generated Mach-O binaries that
Tauri's own signing does NOT cover: the PyInstaller workers (a full CPython +
dozens of `.so`), the static ffmpeg/ffprobe, and the Node-SEA orchestrator. A
plain `tauri build` signs only the app shell (and, in CI, the externalBin) and
**adhoc-signs the rest**, which notarization rejects. So macOS packaging is a
**separate, exhaustive deep-sign pass** done *after* the build by
[`scripts/package/macos-sign-notarize.sh`](../scripts/package/macos-sign-notarize.sh):
repair each PyInstaller framework's symlinks → re-sign it as a bundle →
Developer-ID-sign **every** loose Mach-O across `Contents/MacOS` +
`Contents/Resources` (hardened runtime + secure timestamp + entitlements) →
re-seal the `.app` → build a fresh `.dmg` → `notarytool` + `stapler` (+ optional
upload). `release-macos.sh` just wires the build + this pass together safely.

### Two rules for a by-hand build

`release-macos.sh` enforces both; if you run the steps manually you must too:

1. **Keep the notary creds OUT of `tauri build`.** If `APPLE_ID` /
   `APPLE_PASSWORD` / `APPLE_TEAM_ID` are in the environment, `tauri build`
   tries to notarize itself — and fails, because its signing never reaches the
   bundled worker `.so` files. Build with them withheld (keeping
   `APPLE_SIGNING_IDENTITY` is fine):
   ```bash
   env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID pnpm app:build
   bash scripts/package/macos-sign-notarize.sh
   bash scripts/package/release-upload.sh upload \
     apps/desktop/src-tauri/target/release/bundle/dmg/VideoDubber_*_aarch64.dmg
   ```
2. **Always run `macos-sign-notarize.sh` after the build** — `tauri build` alone
   never yields a notarizable app for this project.

---

### Files involved
- [`apps/desktop/src-tauri/entitlements.plist`](../apps/desktop/src-tauri/entitlements.plist) — hardened-runtime exceptions.
- [`apps/desktop/src-tauri/tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json) — `bundle.macOS.entitlements`.
- [`scripts/package/macos-sign-notarize.sh`](../scripts/package/macos-sign-notarize.sh) — the deep-sign + notarize + staple pass (local **and** CI).
- [`scripts/package/release-macos.sh`](../scripts/package/release-macos.sh) — one-command local build → deep-sign → notarize → upload (handles the `env -u` notary-creds rule).
- [`scripts/package/fetch-ffmpeg.sh`](../scripts/package/fetch-ffmpeg.sh) — fetches ffmpeg/ffprobe and installs them `0755` so the bundler's `xattr` step works.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — CI cert import + the `APPLE_*` env handoff (notary creds withheld from `tauri-action`).
- [`RELEASING.md`](RELEASING.md) — the overall release runbook.
