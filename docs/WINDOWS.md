# VideoDubber on Windows — dev, build, release, publish

A complete, copy-paste walkthrough for your Windows desktop. Assumes the repo
lives at `D:\development\projects\multilingual-dubbed-video`. Companion to
[`LOCAL_SETUP.md`](LOCAL_SETUP.md) (cross-platform setup) and
[`RELEASING.md`](RELEASING.md) (the release runbook).

There are **two things** you can do:

- **Run in dev mode** — hot-reloading workers + orchestrator + Angular UI, either
  in the browser or in the native Tauri window. Needs the Python worker venvs and
  models, but **not** the release toolchain (signing key etc.).
- **Build → release → publish** — produce the `.exe`/`.msi` installers and upload
  them to the GitHub draft release. Needs the updater signing key + a GitHub token
  on top of the dev prerequisites.

If you are doing the second one — or setting this machine up from scratch — read
**[Part F](#part-f--the-verified-end-to-end-pass)** first. It is the exact order a
full verification pass on this box proved correct, including the five things that
only go wrong on Windows.

---

## The short version

Once the toolchain in **Part A** is installed and you have the repo cloned:

```powershell
corepack enable         # (once) gives you the pnpm version this repo pins

pnpm bootstrap          # set everything up  (Parts B + C, in one command)
pnpm dev                # run everything  -> http://localhost:1420
```

**These are the same commands the Mac uses.** Every task script in this repo ships
as a `.sh` + `.ps1` pair and `scripts/run.mjs` runs the `.ps1` half on Windows, so
`pnpm dev`, `pnpm start`, `pnpm stop`, `pnpm services`, `pnpm dev:workers`,
`pnpm test:workers`, `pnpm package:sidecars` and `pnpm release` all work here —
there is no `pwsh scripts\...` form you have to remember any more. (The `.ps1`
files are still there, and still worth invoking directly when you want to pass a
switch such as `-SkipWorkers`.)

`pnpm bootstrap` runs five numbered phases — prerequisites → `pnpm install` →
`pnpm build` → Python venvs + models → `pnpm doctor`.

> **`pnpm bootstrap` is not a read-only checker.** Only **phase 1** never installs:
> it *checks* the Part A prerequisites and, for anything missing, prints the exact
> `winget` line to run, then stops. It will not install system software for you —
> that is your decision, not a setup script's. **Phases 2–4 genuinely install
> things**: workspace dependencies, the built libraries, a `.venv` per Python
> worker, and roughly **1.5–2 GB of models**. Budget **20+ minutes** on a first
> run, and a working network connection.

So if bootstrap stops and points at Part A, come back here, install that one tool,
reopen `pwsh`, and run bootstrap again. It is idempotent.

Switches: `-SkipDeps`, `-SkipBuild`, `-SkipPython`, `-SkipModels`, `-Strict`,
`-Help` — each also available as an env var (`$env:SKIP_MODELS='1'`, …), which is
the form the macOS twin uses. Through pnpm, with **no `--` separator**:
`pnpm bootstrap -SkipModels`. (pnpm 11 forwards a literal `--` to the script,
which then stops with `[bootstrap][error] unrecognised argument(s): --` and
exit 2. The bash twin says `Unknown option: --`; same outcome, different wording.)

Parts B and C below are what bootstrap does, by hand, for when you want to
understand a step or one of them fails.

---

## Part A — One-time machine setup (install these once)

Run each install from an **Administrator PowerShell** window. Every tool below is
available via `winget` (ships with Windows 10/11); the manual download link is
given too. **After installing, close and reopen the terminal** so PATH updates
take effect.

> You do not have to guess which of these you are missing: run `pnpm bootstrap`
> (or `pnpm doctor`, which is read-only) and it will name each one and print the
> command for it.

### 1. PowerShell 7 (`pwsh`) — required, and not optional

`scripts\bootstrap.ps1`, `scripts\release.ps1` and
`scripts\package\release-windows.ps1` all carry `#requires -Version 7.0`. They do
not degrade in "Windows PowerShell 5.1" from the Start menu — they **hard-fail on
the `#requires` line** before running a single statement.

`scripts/run.mjs` only *warns* when the PowerShell it finds is 5.1 (see its
`resolvePwsh`), so `pnpm bootstrap` in a 5.1 window prints a warning and
then dies on the `#requires` anyway. Use `pwsh`.

```powershell
winget install --id Microsoft.PowerShell -e
```
Manual: <https://github.com/PowerShell/PowerShell/releases> (the `*-win-x64.msi`).
From here on, **open a `pwsh` window**, not "Windows PowerShell". Confirm with:

```powershell
$PSVersionTable.PSVersion   # expect 7.x
```

### 2. Long paths — enable them once, in an ELEVATED `pwsh`

Do this even though nothing will tell you to. `bootstrap.ps1` only advises it when
the checkout path is **60 characters or longer** (`if ($RootDir.Length -ge 60)`),
and `D:\development\projects\multilingual-dubbed-video` is **49** — so the advice
never fires on this box. Meanwhile `pnpm install` alone creates nested
`node_modules` chains around **256 characters relative** to the repo root, i.e.
~306 absolute, against a 260-character `MAX_PATH`. The failures that follow look
like random missing files, not like a path-length problem.

```powershell
# elevated pwsh, once per machine:
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
git config --global core.longpaths true
```

(The app itself is already covered: `src-tauri/build.rs` embeds
`windows-app-manifest.xml`, which opts `VideoDubber.exe` out of `MAX_PATH`. That
manifest does nothing for `pnpm`, `git` or `cargo` — hence the registry key.)

### 3. Git

```powershell
winget install --id Git.Git -e
```
Manual: <https://git-scm.com/download/win>. Accept defaults.

### 4. Node.js 24 LTS + pnpm

The root `package.json` says `engines.node >= 22.12.0`, and **that is looser than
what actually runs**. Angular 22 declares `node: ^22.22.3 || ^24.15.0 || >=26.0.0`
(`@angular/core` and `@angular/build`), so on the Node 24 line the real floor is
**v24.15.0**. Below it the UI build fails with an engine error that names Angular,
not this repo. Use a current **Node 24 LTS**.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
# reopen pwsh, then enable the pinned pnpm via Corepack (bundled with Node):
corepack enable
corepack prepare pnpm@11.9.0 --activate
node --version   # expect v24.15.0 or newer
pnpm --version   # expect 11.9.0
```
Manual: <https://nodejs.org/en/download> (LTS, Windows Installer `.msi`).

### 5. Python 3.12

Used for the Python workers. **3.12 specifically** — it is the interpreter the
installer bundles and what every engine-pack venv is created from. **Check "Add
python.exe to PATH"** in the installer (or use winget, which does it for you).

```powershell
winget install --id Python.Python.3.12 -e
# reopen pwsh, then verify with the LAUNCHER, not with `python`:
py -3.12 --version   # expect Python 3.12.x
```

> **Verify with `py -3.12`, not `python --version`.** A bare `python` on a stock
> Windows can resolve to the Microsoft Store **alias stub**, which prints nothing
> useful and opens the Store instead — and if you have several Pythons installed,
> `python` tells you about the wrong one. `bootstrap.ps1` probes `py -3.12` for
> exactly this reason, and hands the resolved interpreter down to phase 4 as
> `PYTHON_PATH` so the venvs are built from the 3.12 it validated. If you keep
> another Python as your default, point the scripts at 3.12 explicitly:
> `$env:PYTHON_PATH = 'C:\Path\To\Python312\python.exe'`.

Manual: <https://www.python.org/downloads/windows/> (Windows installer, 64-bit).

### 6. Rust (rustup) + the MSVC C++ build tools

Needed to compile the native Tauri desktop shell (`pnpm app` in dev, and every
build). Rust on Windows uses the **MSVC** toolchain, which requires Microsoft's
C++ build tools.

```powershell
# Rust toolchain (choose the default "stable-msvc" when prompted):
winget install --id Rustlang.Rustup -e

# Microsoft C++ Build Tools with the "Desktop development with C++" workload:
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```
Manual: rustup <https://rustup.rs> (`rustup-init.exe`); Build Tools
<https://visualstudio.microsoft.com/downloads/> → "Tools for Visual Studio" →
**Build Tools for Visual Studio 2022** → in the installer tick **Desktop
development with C++**.

After both, reopen pwsh and confirm:
```powershell
rustc --version   # expect 1.77+ (Tauri 2 minimum)
```

> **`rustc` must be on PATH even for `pnpm package:sidecars`,** which does not
> compile any Rust. `build-sidecars.ps1` derives the target triple by parsing
> `rustc -Vv` for its `host:` line, and throws
> `"rustc not found and TargetTriple not set."` without it. The escape hatch is
> `-TargetTriple x86_64-pc-windows-msvc` (or `$env:TARGET_TRIPLE`).

### 7. WebView2 runtime

The Tauri window renders in WebView2. It's **preinstalled on Windows 10/11** — you
almost certainly already have it. If a build/run complains, install the
"Evergreen Standalone" runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

### 8. FFmpeg — you already have it at `D:\ffmpeg`

You extracted **gyan.dev `ffmpeg-release-full-shared`** to `D:\ffmpeg`. That build
is perfect for **dev** (it runs with its DLLs beside it). It is **not** usable for
**building the installer** — the bundled sidecar ships `ffmpeg.exe` *alone*, and a
"shared" build needs its `av*.dll`s next to it, so the release build deliberately
ignores it and downloads a pinned, **sha256-verified static** build instead.

**Do this: add the folder that contains `ffmpeg.exe` to your PATH** — that makes
dev find it, while the release build still auto-downloads the correct static
build. **Do NOT set `FFMPEG_BIN`/`FFPROBE_BIN` to anything under `D:\ffmpeg`**, and
do not put `FFMPEG_PATH` in `.env`:

- `fetch-ffmpeg.ps1` deliberately ignores `FFMPEG_PATH`/`FFPROBE_PATH` (those are
  the *runtime* variables that make dev runs find ffmpeg). Only the explicit
  `FFMPEG_BIN`/`FFPROBE_BIN` pair selects a local build for bundling.
- If you do point `FFMPEG_BIN` at the shared build, it **throws**: the shared-build
  trap detects the `av*.dll`s sitting beside the exe and refuses, because a shared
  build passes the libass check here and then breaks at app runtime, where the
  DLLs are not shipped.

First find `ffmpeg.exe`:
```powershell
Get-ChildItem D:\ffmpeg -Recurse -Filter ffmpeg.exe | Select-Object FullName
```
It's usually `D:\ffmpeg\bin\ffmpeg.exe`. Add that `bin` folder to your **user**
PATH (adjust if the recurse above showed a nested folder):
```powershell
[Environment]::SetEnvironmentVariable(
  'Path',
  ([Environment]::GetEnvironmentVariable('Path','User') + ';D:\ffmpeg\bin'),
  'User')
# reopen pwsh, then verify BOTH resolve:
ffmpeg -version
ffprobe -version
```
> If `ffprobe.exe` isn't next to `ffmpeg.exe`, re-extract the full-shared archive
> (it includes both) so `D:\ffmpeg\bin` has `ffmpeg.exe`, `ffprobe.exe`, and the
> `*.dll`s.

### 9. (Optional, dev only) Piper TTS binary — for real Vietnamese voice in dev

In dev the TTS worker calls the **Piper binary** if you point it at one; otherwise
it falls back to system TTS or a silent placeholder WAV. (The *release* build
freezes its own Piper, so this is a dev-only convenience.) To get real Piper
voice while developing:

1. Download a Windows release from
   <https://github.com/OHF-Voice/piper1-gpl/releases> and extract it, e.g. to
   `D:\piper` (so you have `D:\piper\piper.exe`). The old `rhasspy/piper` repo
   was archived read-only on 2025-10-06 and its last binaries predate what the
   packaged app ships (`vd-piper` freezes `piper1-gpl`), so don't use it.
2. The setup step in Part C downloads the Vietnamese voice into
   `%USERPROFILE%\VideoDubber-dev\models\piper` (the **dev** model home —
   `VIDEODUBBER_DEV_HOME`, which `dev.ps1` points the workers at; the installed
   app uses `%USERPROFILE%\VideoDubber`).
3. Set these in your dev session (see Part D) — `PIPER_BINARY_PATH` and
   `PIPER_VOICE_MODEL_PATH`.

---

## Part B — Get the code and install JS dependencies

```powershell
cd D:\development\projects
git clone https://github.com/codertapsu/multilingual-dubbed-video.git   # (skip if already cloned)
cd multilingual-dubbed-video

pnpm bootstrap          # does this part AND Part C
```

If you would rather run the JS half on its own — for example to reinstall
dependencies after a lockfile change:

```powershell
pnpm install --frozen-lockfile
```

> **Frozen vs. not, and why it matters before a release.** Bootstrap's phase 2
> runs a plain `pnpm install` (it only adds `--frozen-lockfile` when `CI` is set
> to something other than `0`/`false`). A non-frozen install is free to **rewrite
> `pnpm-lock.yaml`**, which dirties the working tree — and `pnpm release`'s
> preflight has a **clean-tree gate** that then reports `MISSING  git tree`. On a
> release box, install frozen yourself and tell bootstrap to skip phase 2:
> `pnpm install --frozen-lockfile` then `$env:SKIP_DEPS = '1'; pnpm bootstrap`.

---

## Part C — Set up the Python workers + local models (one-time)

`pnpm bootstrap` already did this. This is the same step on its own, for when
you want to re-run it with different options.

It creates a `.venv` in **each of the five Python suites** —
`stt-worker`, `translation-worker`, `tts-worker`, `tts-engine-neural`,
`tts-engine-omnivoice` — installs each one's dependencies (including
`requirements-dev.txt` / the `dev` extra, so `pytest` is present), and downloads
the default models (faster-whisper `small`, Argos `en→vi`, the `vi` Piper voice).
It never fails hard if you're offline — it prints manual steps instead.

> It used to create venvs for **three** of the five. `scripts\test-workers.ps1`
> counts five suites, and `pnpm release` runs it with `-RequireAll`, which treats
> a suite it cannot execute as a **failure** — so a machine set up entirely by our
> own script could not pass our own release gate. Fixed in `3d03c03`; if you see
> `tts-engine-neural` or `tts-engine-omnivoice` reported as missing a venv, you
> are on an older checkout.

```powershell
node scripts/run.mjs setup-local-models      # or, to pass switches:
pwsh scripts\setup-local-models.ps1 -SkipModels
```

Useful switches: `-SkipVenvs`, `-SkipModels` (venvs only), `-SkipWhisper`,
`-SkipArgos`, `-SkipPiper`. Each also works as an env var (`$env:SKIP_MODELS='1'`,
…), which is the form the `.sh` twin uses. Override the defaults with
`$env:FASTER_WHISPER_MODEL='small'`, `$env:ARGOS_FROM='en'`, `$env:ARGOS_TO='vi'`,
`$env:PIPER_VOICE`, `$env:PYTHON_PATH`, `$env:VIDEODUBBER_DEV_HOME`.
See [`MODEL_SETUP.md`](MODEL_SETUP.md) for other languages (note: a non-English
pair like `zh→vi` needs **both** `zh→en` and `en→vi` — Argos pivots through
English).

Sanity-check the whole environment:
```powershell
pnpm doctor          # = scripts/verify-environment.ts  (`pnpm verify` is the same script)
```

---

## Part D — Run in DEV mode

Two ways. Both hot-reload on code changes. Stop with **Ctrl-C**.

### Option 1 — Browser dev (fastest inner loop)

Starts the 3 workers + orchestrator + Angular dev server; you use the app in your
browser. No Rust/Tauri needed.

```powershell
# (recommended) point the TTS worker at your Piper binary + voice for real audio:
$env:PIPER_BINARY_PATH      = 'D:\piper\piper.exe'
$env:PIPER_VOICE_MODEL_PATH = "$env:USERPROFILE\VideoDubber-dev\models\piper\vi_VN-vais1000-medium.onnx"

pnpm dev
```
Then open **<http://127.0.0.1:1420>**. Logs stream to `.dev-logs\`. Other ports:
orchestrator 5100, STT 5101, translation 5102, TTS 5103.

Variants — all cross-platform `pnpm` names now:

| Goal | Command |
|---|---|
| Start everything, foreground (Ctrl-C stops) | `pnpm dev` |
| Start everything, **detached** (terminal returns) | `pnpm start` |
| **Stop** the stack, however it was started | `pnpm stop` |
| Backend only (no UI) | `pnpm services` |
| Just the 3 Python workers | `pnpm dev:workers` |

To skip a piece of the stack, invoke the `.ps1` directly with its switch — e.g.
`pwsh scripts\dev.ps1 -SkipWorkers` to reuse already-running workers, or
`-SkipUi` / `-SkipLibWatch`. Unlike `setup-local-models.ps1`, only
`-SkipLibWatch` has an env-var default here: `$env:SKIP_WORKERS='1'` and
`$env:SKIP_UI='1'` are **not** read by `dev.ps1`, so the switch is the form that
works on Windows.

### Option 2 — Native desktop app (the real Tauri window)

Builds and runs the native shell; it **auto-starts the backend** for you (it runs
`scripts\start-services.ps1` under the hood) and stops it on quit.

```powershell
pnpm app
```
First launch compiles the Rust shell (a few minutes); subsequent launches are
fast. This is the mode to use when testing anything shell-specific (auto-update,
window behavior, the bundled-service lifecycle).

> FFmpeg in dev: because you added `D:\ffmpeg\bin` to PATH (Part A.8), both modes
> find `ffmpeg`/`ffprobe` automatically — no env var needed. If a render step
> ever can't find it, set `$env:FFMPEG_PATH` and `$env:FFPROBE_PATH` **in the dev
> session only** (never in `.env`).

---

## Part E — Build, release, and publish

This produces the Windows installers and uploads them to the GitHub **draft**
release. They are **not Authenticode-signed** — that is a standing decision, not
an oversight; see the note at the end of this part. The `.sig` files the build
does produce are the **updater** signatures, which is a different thing.

### How a release is actually cut: two machines, one draft

CI is **off** — since 2026-07-04 every release is built locally, on two machines,
**in parallel**:

| | macOS (the Mac, arm64) | Windows (this box) |
|---|---|---|
| Command | `pnpm release --sidecars --upload` | `pnpm release -Sidecars -Upload` |
| Script | `scripts/package/release-macos.sh` | `scripts\package\release-windows.ps1` |
| Steps | build → deep-sign → notarize → staple → updater archive → upload | build → verify → upload |
| Signing | Developer ID + Apple notarization | **unsigned installers, by decision** |

Both machines upload to the **same GitHub draft release tagged `vX.Y.Z`**, and
`pnpm release:status` (read-only, from either machine) tells you how far the other
one has got.
Whichever machine gets there first **creates** the draft —
`release-upload.{sh,ps1}` has an "ensure" step that creates it on demand (seeding
the body from `release-body-header.md`) and an "upload" step that adds assets — so
the two runs do not have to be coordinated beyond agreeing on the tag.

Neither machine overwrites the other's `latest.json`: each merges **its own**
entry with `merge-latest-json.mjs --platform <key>`, preserving what is already
there. Three keys are written in total:

| Key | Asset it points at | Written by |
|---|---|---|
| `darwin-aarch64` | the notarize-repaired `.app.tar.gz` | macOS |
| `windows-x86_64` | the NSIS `-setup.exe` | Windows |
| `windows-x86_64-msi` | the `.msi` | Windows |

`windows-x86_64-msi` exists so MSI-installed users get an MSI update instead of
being pushed through an elevated `msiexec` uninstall mid-update (or ending up with
two installs). `release-windows.ps1` merges it only when the `.msi` **and its
updater `.sig`** are both present (`Test-Path "$($msi.FullName).sig"`); otherwise
it warns and MSI users fall back to the NSIS setup. "Signed" here means the Tauri
updater signature, never Authenticode — the installers are unsigned either way.

### The canonical asset set — 8 files, every release

This is what a complete draft looks like (confirmed against v0.7.0, v0.7.1,
v0.8.0, v0.8.1 and the v0.9.0 draft — all eight, every time):

```
latest.json                                  <- shared, merged by both machines
VideoDubber_<ver>_aarch64.app.tar.gz         <- macOS updater payload
VideoDubber_<ver>_aarch64.app.tar.gz.sig
VideoDubber_<ver>_aarch64.dmg                <- macOS installer   (NO .sig -- correct)
VideoDubber_<ver>_x64-setup.exe              <- Windows NSIS installer
VideoDubber_<ver>_x64-setup.exe.sig
VideoDubber_<ver>_x64_en-US.msi              <- Windows MSI
VideoDubber_<ver>_x64_en-US.msi.sig
```

macOS contributes **3**, Windows contributes **4**, and `latest.json` is the
shared one. **The `.dmg` has no `.sig`, and that is correct** — the updater never
installs a `.dmg`; it installs the `.app.tar.gz`, which is the file the signature
covers. A missing `.dmg.sig` is not a bug to fix.

### One-time release setup

1. **Updater signing key.** Copy `~/.tauri/videodubber.key` from the Mac to
   `%USERPROFILE%\.tauri\videodubber.key` on this Windows box. It is a **secret** —
   transfer it privately (USB / a secure channel), not email/chat. Without it the
   build produces no `.sig` files and the auto-updater can never install the
   release. (Its password is empty — the scripts handle that.) This is the single
   most likely thing to be missing on a fresh Windows release box, because it is
   **copied**, never generated here.
2. **GitHub token.** Sign in once so `git credential` has a token (any `git push`
   or `git fetch` over HTTPS to the repo will prompt and cache it), or set
   `$env:GH_TOKEN` to a token with `repo` scope. The upload scripts look at
   `GH_TOKEN` first, then fall back to `git credential fill` for `github.com`.
3. Make sure the checkout is on the commit you're releasing and the tree is
   **clean**. The version bump itself is one command, run **once, on either
   machine**, then committed and pushed before both machines build:

   ```powershell
   pnpm release:version 0.9.1          # DRY RUN: the before/after table
   pnpm release:version minor --yes    # or an explicit X.Y.Z; --yes writes
   ```

   It rewrites the four manifests (through `check-versions.mjs --set`) plus
   `Cargo.lock`, restores every one of them if any step fails, and refuses on a
   dirty tree. `node scripts\check-versions.mjs` verifies the result. See
   [`RELEASING.md`](RELEASING.md#sync-1--bump-the-version-on-one-machine).

### Cut the Windows release — one command

```powershell
pnpm release:check      # preflight only: nothing is built or uploaded
pnpm release -Sidecars -Upload
```

`pnpm release` runs `scripts\release.ps1` here and the macOS twin on the Mac, so
the release command is the same on both machines. It is a thin wrapper over
`release-windows.ps1` and reimplements none of the build, verification, upload or
`latest.json` merge — it adds the single entry point and the fast preflight.

`pnpm release:check` gates on: version consistency across the manifests, the
Python suites run **strictly** (`test-workers.ps1 -RequireAll`), a clean git tree
(`$env:ALLOW_DIRTY='1'` downgrades that to a warning), the updater signing key,
and a GitHub token. It builds nothing and takes seconds. Run it every time — a
Windows release build is long, and discovering afterwards that the updater key
was never copied from the Mac is the expensive way to learn it.

The switches are forwarded straight through, with **no `--` separator**:

```powershell
pnpm release -Sidecars -Upload
# -Sidecars  rebuild the bundled sidecars first
# -Upload    upload to the draft release and merge latest.json
# -Tag       override the tag (default v<tauri.conf.json version>)
```

Or invoke the underlying script directly, which is equivalent:

```powershell
pwsh scripts\package\release-windows.ps1 -Sidecars -Upload
```

What it does, in order:

1. **`-Sidecars`** → `build-sidecars.ps1`: builds the orchestrator (Node SEA), the
   three PyInstaller workers, `vd-piper`, a **static** libass ffmpeg (auto-download
   — see Part A.8), `vd-uv` + bundled CPython, and stages the engine-pack source.
2. `pnpm app:build` → Tauri build. `bundle.targets` is
   `["app","dmg","nsis","msi"]`, so Windows produces **both** the NSIS
   `…_x64-setup.exe` and the WiX `…_x64_en-US.msi`, each with an updater `.sig`
   (the signing key from step 1). The `-setup.exe` is the one to hand to users:
   it installs per-user into `%LOCALAPPDATA%` with no prompts. The `.msi` is a
   per-machine install into *Program Files* that requires elevation; it exists for
   IT-managed/GPO deployment.
3. Verifies the artifacts: the `-setup.exe` + its `.sig` are **required** (missing
   = error). A missing `.msi` is a **warning**, not a failure.
4. **`-Upload`** → uploads them to the tag's **draft** release
   (`release-upload.ps1`) and merges `windows-x86_64` — and, when the `.msi` and
   its updater `.sig` are there, `windows-x86_64-msi` — into the release's `latest.json`
   (`merge-latest-json.mjs`, preserving the mac entry if it's already there;
   `--fix-tag` repairs a stray `untagged-<sha>` draft tag).

Build only (inspect before uploading): drop `-Upload`. Upload later by re-running
with `-Upload`, or manually per [`RELEASING.md`](RELEASING.md).

The installers are **unsigned** (no Authenticode certificate, and none is
planned), so first launch shows Windows SmartScreen — **More info → Run anyway**.
That is expected behavior, documented in `README.md` and the user guide, and it
does not affect auto-updates: the updater verifies the Tauri `.sig`, not
Authenticode.

### Publish — the one step that is not a build

Neither machine can see the other's progress, so **ask**, from either one:

```powershell
pnpm release:status                 # = node scripts\release-status.mjs
pnpm release:status --tag v0.9.1
pnpm release:status --json          # machine-readable
```

It is **read-only** (GETs only) and answers in a couple of seconds: which of the
8 assets each machine has uploaded, their sizes, whether `latest.json` carries all
three platform keys at the right version, and a verdict. Exit code 0 means
complete. An `untagged-…` URL on a draft is **normal** — the git tag is only
created when the draft is published — and it says so rather than letting you
misread it.

```
  Windows (4 assets) - complete   the Windows box - installer is UNSIGNED by standing decision
    [ok]       246.2 MB  VideoDubber_0.9.0_x64-setup.exe  NSIS installer
    ...
  latest.json (2.1 kB) - version 0.9.0
    [ok]      darwin-aarch64
    [ok]      windows-x86_64
    [ok]      windows-x86_64-msi

verdict: READY TO PUBLISH - all 8 assets present, latest.json covers all three platforms.
```

When it says ready, write the notes and publish:

```powershell
pnpm release:publish --notes-file NOTES.md            # DRY RUN (the default)
pnpm release:publish --notes-file NOTES.md --yes      # actually publishes
```

Three things worth knowing about it:

- **It re-runs the status check first and refuses to publish an incomplete draft.**
  That refusal is the whole point. Publishing a draft whose `latest.json` is
  missing `windows-x86_64` looks fine — the `.exe` is right there in the asset
  list — and those users simply never see an update again. It cannot be taken
  back: clients resolve `releases/latest` the moment you publish.
- **It is a dry run unless you pass `--yes`.** Nothing is written without it.
- **Your notes are appended under the download table**, never over it. The body
  starts with the bilingual table `release-upload` seeded from
  `release-body-header.md`, which is the only thing stopping a Mac user
  downloading the `.app.tar.gz` instead of the `.dmg`. Re-running with corrected
  notes replaces the changelog and leaves the table alone.

`--tag`, `--repo`, `--notes "..."` and `--prerelease` are also accepted.

Publishing is what makes the updater endpoint
(`releases/latest/download/latest.json`) point at this version, so users on the
previous version get the auto-update. Full runbook, including what to verify
*after* publishing and how to roll back:
[`RELEASING.md`](RELEASING.md#write-the-notes-then-publish).

Afterwards, old releases are pure storage cost (~600 MB–1.5 GB each) and nothing
needs them — the updater always reads `releases/latest/download/latest.json`:

```powershell
node scripts\package\prune-releases.mjs                 # DRY RUN, keeps the 2 newest
node scripts\package\prune-releases.mjs --keep 2 --apply
```

It is **dry-run by default** and requires `--apply` to delete anything. Drafts,
the `latest` release and all git tags are never touched.

---

## Part F — The verified end-to-end pass

This is the order a full verification pass on this Windows box proved correct, in
2026-09. Follow it top to bottom on a fresh machine, or before cutting a release.
Every correction in it was learned the expensive way — see
[why these steps exist](#why-these-steps-exist) at the end.

**0. Open a `pwsh` 7 window.** Not "Windows PowerShell" from the Start menu. See
Part A.1. If you have not enabled long paths on this machine yet, do Part A.2
first, in an **elevated** `pwsh`.

**1. Get the code up to date.**
```powershell
cd D:\development\projects\multilingual-dubbed-video
git pull
```

**2. Parse every `.ps1` — BEFORE running any of them.** Parsing a script *after*
you have already run it proves nothing; the point is to catch a script that the
host cannot even read.
```powershell
Get-ChildItem -Path .\scripts -Filter *.ps1 -Recurse | ForEach-Object {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors) { Write-Host "PARSE FAIL: $($_.FullName)" -ForegroundColor Red; $errors | ForEach-Object { Write-Host "  $_" } }
  else { Write-Host "ok: $($_.Name)" }
}
```
Three things that are easy to get wrong here:
- `ParseFile` takes **two `[ref]` arguments** (`[ref]$tokens, [ref]$errors`) after
  the path. Call it with one and you get a method-not-found error that reads like
  a parse failure.
- It does **not** resolve a relative path against PowerShell's current location —
  pass `$_.FullName`, as above.
- Use **`-Recurse`**: `scripts\package\` holds more `.ps1` files than `scripts\`
  does, and they are the ones a release runs.

`node scripts\check-tasks.mjs` (step 5) enforces the underlying rule — every
`.ps1` must be pure ASCII — but this loop is what tells you *now*, in this
checkout, with this host codepage.

**3. Check the toolchain.**
```powershell
$PSVersionTable.PSVersion   # 7.x            (Part A.1)
node --version              # >= v24.15.0    (Angular 22's real floor -- Part A.4)
py -3.12 --version          # Python 3.12.x  NOT `python --version` -- Part A.5
rustc --version             # must be on PATH even for package:sidecars -- Part A.6
git --version

corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm --version              # 11.9.0
```

**4. Install and bootstrap — frozen, so the tree stays clean.**
```powershell
pnpm install --frozen-lockfile
$env:SKIP_DEPS = '1'
pnpm bootstrap
```
`SKIP_DEPS=1` skips bootstrap's **phase 2**, which runs a **non-frozen**
`pnpm install`. That install can rewrite `pnpm-lock.yaml`, dirtying the working
tree — and `pnpm release:check`'s clean-tree gate then fails on a change you did
not make. Installing frozen yourself first gets you the same dependencies without
that risk.

Remember what the remaining phases do: **phases 2–4 install**. Venvs for five
Python suites and ~1.5–2 GB of models. **20+ minutes** on a first run.

**5. Run every check.**
```powershell
pnpm lint
pnpm typecheck
pnpm test
pwsh scripts\test-workers.ps1 -RequireAll   # all FIVE pytest suites, strictly
node scripts\check-versions.mjs             # the four manifests agree
node scripts\check-tasks.mjs                # .sh/.ps1 twins exist; every .ps1 is ASCII
```
`-RequireAll` is what `pnpm release` passes, so it is what you want to see green
here: without it, a suite with no venv is reported as *skipped* and the run exits
0 — a gate that reads green having run nothing.

**6. Build the sidecars.**
```powershell
pnpm package:sidecars
```
Two things to watch for in the output:
- **No** `Falling back to the DEV venvs` warning. That means the frozen workers
  were built from whatever happens to be in `workers\*\.venv` instead of from
  `requirements.txt` — not reproducible, and not what you want to ship.
- The **bundle assertion passes** at the end
  (`OK bundle assertion passed: default models + uv + CPython are all bundled.`).
  It includes an orchestrator size check: if
  `videodubber-orchestrator-<triple>.exe` is no larger than `node.exe`, the SEA
  blob was never injected and the "orchestrator" you shipped would start a Node
  REPL.

And do **not** point `FFMPEG_BIN`/`FFPROBE_BIN` at `D:\ffmpeg` — it is a *shared*
build and `fetch-ffmpeg.ps1` throws on it. The build downloads a pinned,
sha256-verified static build instead. (Part A.8.)

**7. Then the Rust — and not before.**
```powershell
Push-Location .\apps\desktop\src-tauri
cargo check; if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cargo check failed' }
cargo test          # 16 tests
Pop-Location
```
`cargo check` **fails on a fresh clone** if you run it earlier, and the error does
not say why: `build.rs` copies the five `externalBin` sidecars, and
`generate_context!` needs the built Angular output in `apps/desktop/dist`. All of
that is gitignored and only exists **after step 6**. The `$LASTEXITCODE` check is
not decoration — `$ErrorActionPreference = 'Stop'` does not trap a native
program's exit code, so without it a failed `cargo check` falls straight through
into `cargo test`.

**8. Preflight, then release.**
```powershell
pnpm release:check
pnpm release -Sidecars -Upload
```
See Part E for what each gate means and what lands in the draft.

**9. Smoke-test the installed `.exe`.** Install from the built
`VideoDubber_<ver>_x64-setup.exe` and check all four:

- **SmartScreen** appears → *More info* → *Run anyway*. Expected: the installer is
  unsigned by decision.
- **No console windows flash** at any point during a dub. Every sidecar and every
  cleanup call is spawned with `CREATE_NO_WINDOW`; a flash means one was missed.
- **On quit, Task Manager shows no orphaned `python`, `node` or `llama-server`.**
  The shell assigns its children to a Windows **Job Object** with
  kill-on-job-close, so the whole tree dies with the app even if it is killed
  ungracefully. An orphan means the job assignment failed.
- **A second launch focuses the first window** instead of starting a second copy
  (`tauri-plugin-single-instance`). The failure mode this guards against is the
  second instance tearing down the *first* instance's backend on its own exit.

### Why these steps exist

The pass above is not a generic checklist — every unusual instruction in it is a
bug that shipped and was found on this box. Five of them, all Windows-only, all
invisible on macOS, all now fixed:

| What broke | Why only on Windows |
|---|---|
| **Five `.ps1` files could not be parsed at all** (`673c77f`) | 123 UTF-8 em dashes across 15 scripts. PowerShell decodes a **BOM-less `.ps1` in the host's ANSI codepage**, so `E2 80 94` arrives as three Windows-1252 characters; where that lands inside a quoted string the parser loses the terminator and cascades. macOS and Linux decode UTF-8 fine and never notice. `check-tasks.mjs` now enforces pure ASCII — and ASCII rather than a BOM, because a BOM fixes *parsing* but these scripts also *print* that text to a console on codepage 437/850. |
| **A media-worker test asserted a POSIX path** (`e5bbea8`, `3d03c03`) | `test_output_not_writable_raises` used `/dev/null/cannot/create/here`, which only fails because `/dev/null` is a **file**. On Windows that is just `\dev\null\...` on the current drive and `mkdir` happily creates every level — so the test reported `DID NOT RAISE` against a guard that was working perfectly. |
| **`bootstrapUv` ignored its own platform override** (`81b27d3`) | It resolved `platform = deps.platform ?? process.platform` and then called `managedUvInstalled()`, which used `process.platform` internally. The managed binary is `uv` on POSIX and `uv.exe` on Windows, so whenever the two disagreed the "already installed, skip the download" check looked for the wrong filename and re-downloaded. |
| **Two tests asserted POSIX permission bits** | Windows does not implement them, so the assertions could never hold there — and nobody running the suites on macOS would ever see it. |
| **`setup-local-models` covered 3 of the 5 pytest suites** (`3d03c03`) | `test-workers` counts five, and `pnpm release` runs it with `-RequireAll`, which fails on a suite it cannot execute. `tts-engine-neural` and `tts-engine-omnivoice` only ever had venvs where someone had made one by hand — which is exactly why macOS looked fine and a **freshly set-up Windows box could never pass our own release gate**. |

The pattern is worth naming: four of the five were **authoring-machine blind
spots** — code, tests or text that is correct on macOS and cannot be correct on
Windows. That is the argument for running the whole of Part F on the real box
before every release, and for `check-tasks.mjs` existing at all.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Script errors with weird parameter/parse errors, or `#requires` complaints | You're in **Windows PowerShell 5.1**. Use **`pwsh`** (PowerShell 7) — Part A.1. |
| Random "file not found" / truncated `node_modules` after install | Long paths. Enable them once, elevated — Part A.2. |
| `pnpm` not found after installing Node | Reopen the terminal; run `corepack enable`. |
| Angular build fails citing `engines` / an unsupported Node | Node below **v24.15.0**. The repo's `>=22.12.0` is looser than Angular 22 accepts — Part A.4. |
| `python --version` opens the Microsoft Store | That's the Store alias stub. Use `py -3.12 --version`, and set `$env:PYTHON_PATH` if you keep another Python as the default — Part A.5. |
| `rustc not found and TargetTriple not set.` from `pnpm package:sidecars` | `rustc` must be on PATH even though this step compiles no Rust; or pass `-TargetTriple x86_64-pc-windows-msvc` — Part A.6. |
| `cargo check` fails on a fresh clone | Run `pnpm package:sidecars` first: `build.rs` needs the sidecars and `generate_context!` needs `apps/desktop/dist`, both gitignored — Part F.7. |
| Not sure what's missing | `pnpm doctor` — read-only, prints an OK/WARN/MISSING row per prerequisite with the fix for each. |
| `run.mjs: no .ps1 implementation for task "…"` | That task has a `.sh` but no Windows twin yet. The message says so explicitly; report it, or write the `.ps1` half. |
| Rust/Tauri build fails with "link.exe not found" / MSVC errors | The **C++ Build Tools** workload isn't installed (Part A.6). |
| A worker window says "no `.venv`" | Run `pnpm bootstrap` (or just the Part C step). |
| `pnpm release:check` says `MISSING  git tree` and you changed nothing | `pnpm-lock.yaml` was rewritten by a non-frozen install. Install frozen and skip bootstrap's phase 2 — Part F.4. Or `$env:ALLOW_DIRTY='1'` for a deliberate local-only build. |
| `test-workers -RequireAll` fails on `tts-engine-neural` / `tts-engine-omnivoice` | Pre-`3d03c03` checkout, or those venvs were never created. Re-run `pwsh scripts\setup-local-models.ps1` — Part C. |
| Installing a Python engine pack says **"`uv` is required … but was not found"** | Only possible on an old build. Current builds download a pinned uv themselves on first install. To skip that download, stage the sidecar once with `pwsh scripts\package\fetch-uv.ps1` (needs `rustc` for the target triple, or pass `-TargetTriple x86_64-pc-windows-msvc`) — `scripts\dev.ps1` then picks it up. A system-wide uv also works: `winget install --id=astral-sh.uv -e`, then reopen the terminal. |
| Rendered video fails / "ffmpeg not found" in dev | Confirm `ffmpeg -version` works in a fresh `pwsh` (PATH from Part A.8). |
| Release build fails on ffmpeg with a "SHARED build" error | You set `FFMPEG_BIN` to something under `D:\ffmpeg` (a shared build). Unset it — the build downloads a pinned static one. Only add `D:\ffmpeg\bin` to **PATH**. |
| Build has no `.sig` files / updater can't install | `TAURI_SIGNING_PRIVATE_KEY` isn't set and `%USERPROFILE%\.tauri\videodubber.key` is missing (release setup step 1). |
| The `.dmg` in the draft has no `.sig` | Correct, not a bug. The updater installs the `.app.tar.gz`, which is what the signature covers — Part E. |
| TTS produces silence in dev | Set `PIPER_BINARY_PATH` + `PIPER_VOICE_MODEL_PATH` (Part A.9 / D), or accept the silent dev fallback. |
| Auto-update didn't offer the new version | Check that the release is **published** (not draft) and `latest.json` has your platform entry with the right download URL. MSI-installed users need `windows-x86_64-msi`. |

More detail: [`../CONTRIBUTING.md`](../CONTRIBUTING.md) (the full `pnpm` task
reference, repo layout, tests and house conventions),
[`LOCAL_SETUP.md`](LOCAL_SETUP.md) (setup internals),
[`RELEASING.md`](RELEASING.md) (release runbook + signing),
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
