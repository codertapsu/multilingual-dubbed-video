# VideoDubber on Windows — dev, build, release, publish

A complete, copy-paste walkthrough for your Windows desktop. Assumes the repo
lives at `D:\development\projects\multilingual-dubbed-video`. Companion to
[`LOCAL_SETUP.md`](LOCAL_SETUP.md) (cross-platform setup) and
[`RELEASING.md`](RELEASING.md) (the release runbook).

There are **two things** you can do:

- **Run in dev mode** — hot-reloading workers + orchestrator + Angular UI, either
  in the browser or in the native Tauri window. Needs the Python worker venvs and
  models, but **not** the release toolchain (signing key etc.).
- **Build → release → publish** — produce the signed `.exe`/`.msi` installers and
  upload them to the GitHub release. Needs the updater signing key + a GitHub
  token on top of the dev prerequisites.

---

## Part A — One-time machine setup (install these once)

Run each install from an **Administrator PowerShell** window. Every tool below is
available via `winget` (ships with Windows 10/11); the manual download link is
given too. **After installing, close and reopen the terminal** so PATH updates
take effect.

### 1. PowerShell 7 (`pwsh`) — required

Our scripts use PowerShell 7 features and will misbehave in the old "Windows
PowerShell 5.1". Install PS7 and use it (`pwsh`) for everything below.

```powershell
winget install --id Microsoft.PowerShell -e
```
Manual: <https://github.com/PowerShell/PowerShell/releases> (the `*-win-x64.msi`).
From here on, **open a `pwsh` window**, not "Windows PowerShell".

### 2. Git

```powershell
winget install --id Git.Git -e
```
Manual: <https://git-scm.com/download/win>. Accept defaults.

### 3. Node.js 24 LTS + pnpm

The project needs Node ≥ 22.12; **use Node 24 LTS** to match what the release was
built with.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
# reopen pwsh, then enable the pinned pnpm via Corepack (bundled with Node):
corepack enable
corepack prepare pnpm@11.9.0 --activate
node --version   # expect v24.x
pnpm --version   # expect 11.9.0
```
Manual: <https://nodejs.org/en/download> (LTS, Windows Installer `.msi`).

### 4. Python 3.12

Used for the three Python workers. **Check "Add python.exe to PATH"** in the
installer (or use winget, which does it for you).

```powershell
winget install --id Python.Python.3.12 -e
# reopen pwsh:
python --version   # expect Python 3.12.x
```
Manual: <https://www.python.org/downloads/windows/> (Windows installer, 64-bit).

### 5. Rust (rustup) + the MSVC C++ build tools

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

### 6. WebView2 runtime

The Tauri window renders in WebView2. It's **preinstalled on Windows 10/11** — you
almost certainly already have it. If a build/run complains, install the
"Evergreen Standalone" runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

### 7. FFmpeg — you already have it at `D:\ffmpeg`

You extracted **gyan.dev `ffmpeg-release-full-shared`** to `D:\ffmpeg`. That build
is perfect for **dev** (it runs with its DLLs beside it). It is **not** usable for
**building the installer** — the bundled sidecar ships `ffmpeg.exe` *alone*, and a
"shared" build needs its `av*.dll`s next to it, so the release build deliberately
ignores it and downloads a **static** build instead.

**Do this: add the folder that contains `ffmpeg.exe` to your PATH** — that makes
dev find it, while the release build (which only looks at the `FFMPEG_PATH` env
var, never PATH) still auto-downloads the correct static build. **Do NOT put
`FFMPEG_PATH` in `.env`** — the build reads `.env` too and would reject the shared
build.

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

### 8. (Optional, dev only) Piper TTS binary — for real Vietnamese voice in dev

In dev the TTS worker calls the **Piper binary** if you point it at one; otherwise
it falls back to system TTS or a silent placeholder WAV. (The *release* build
freezes its own Piper, so this is a dev-only convenience.) To get real Piper
voice while developing:

1. Download `piper_windows_amd64.zip` from
   <https://github.com/rhasspy/piper/releases> and extract it, e.g. to
   `D:\piper` (so you have `D:\piper\piper.exe`).
2. The `setup-local-models.ps1` step below downloads the Vietnamese voice into
   `%USERPROFILE%\VideoDubber\models\piper`.
3. Set these in your dev session (see Part E) — `PIPER_BINARY_PATH` and
   `PIPER_VOICE_MODEL_PATH`.

---

## Part B — Get the code and install JS dependencies

```powershell
cd D:\development\projects
git clone https://github.com/codertapsu/multilingual-dubbed-video.git   # (skip if already cloned)
cd multilingual-dubbed-video

pnpm install --frozen-lockfile
```

---

## Part C — Set up the Python workers + local models (one-time)

This creates a `.venv` in each worker, installs its dependencies, and downloads
the default models (faster-whisper `small`, Argos `en→vi`, the `vi` Piper voice).
It never fails hard if you're offline — it prints manual steps instead.

```powershell
pwsh scripts\setup-local-models.ps1
```

Useful switches: `-SkipModels` (venvs only), `-SkipPiper`, or override with
`$env:FASTER_WHISPER_MODEL='small'`, `$env:ARGOS_FROM='en'`, `$env:ARGOS_TO='vi'`.
See [`MODEL_SETUP.md`](MODEL_SETUP.md) for other languages (note: a non-English
pair like `zh→vi` needs **both** `zh→en` and `en→vi` — Argos pivots through
English).

Sanity-check the whole environment:
```powershell
pnpm verify
```

---

## Part D — Run in DEV mode

Two ways. Both hot-reload on code changes. Stop with **Ctrl-C**.

### Option 1 — Browser dev (fastest inner loop)

Starts the 3 workers + orchestrator + Angular dev server; you use the app in your
browser. No Rust/Tauri needed.

```powershell
# (recommended) point the TTS worker at your Piper binary + voice for real audio:
$env:PIPER_BINARY_PATH     = 'D:\piper\piper.exe'
$env:PIPER_VOICE_MODEL_PATH = "$env:USERPROFILE\VideoDubber\models\piper\vi_VN-vais1000-medium.onnx"

pwsh scripts\dev.ps1
```
Then open **<http://127.0.0.1:1420>**. Logs stream to `.dev-logs\`. Other ports:
orchestrator 5100, STT 5101, translation 5102, TTS 5103.

Variants: `pwsh scripts\dev.ps1 -SkipWorkers` (reuse already-running workers),
`pwsh scripts\start.ps1` (detached — terminal returns), `pwsh scripts\stop.ps1`
(stop a detached stack).

### Option 2 — Native desktop app (the real Tauri window)

Builds and runs the native shell; it **auto-starts the backend** for you (it runs
`scripts\start-services.ps1` under the hood) and stops it on quit.

```powershell
pnpm app
```
First launch compiles the Rust shell (a few minutes); subsequent launches are
fast. This is the mode to use when testing anything shell-specific (auto-update,
window behavior, the bundled-service lifecycle).

> FFmpeg in dev: because you added `D:\ffmpeg\bin` to PATH (Part A.7), both modes
> find `ffmpeg`/`ffprobe` automatically — no env var needed. If a render step
> ever can't find it, set `$env:FFMPEG_PATH` and `$env:FFPROBE_PATH` **in the dev
> session only** (never in `.env`).

---

## Part E — Build, release, and publish

This produces the signed Windows installers and uploads them to the GitHub
release. macOS is built separately on the Mac; both machines upload to the **same**
draft and the updater manifest (`latest.json`) is merged so auto-update sees both
platforms. CI is **off** (`RELEASE_CI_WINDOWS=false`) — everything is local.

### One-time release setup

1. **Updater signing key.** Copy `~/.tauri/videodubber.key` from the Mac to
   `%USERPROFILE%\.tauri\videodubber.key` on this Windows box. It is a **secret** —
   transfer it privately (USB / a secure channel), not email/chat. Without it the
   build produces no `.sig` files and the auto-updater can never install the
   release. (Its password is empty — the scripts handle that.)
2. **GitHub token.** Sign in once so `git credential` has a token (any `git push`
   or `git fetch` over HTTPS to the repo will prompt and cache it), or set
   `$env:GH_TOKEN` to a token with `repo` scope.
3. Make sure the checkout is on the commit/tag you're releasing and version is
   bumped (`apps/desktop/src-tauri/tauri.conf.json` + `package.json`s — see
   [`RELEASING.md`](RELEASING.md#per-release-steps)).

### Cut the Windows release — one command

```powershell
pnpm install --frozen-lockfile
pwsh scripts\package\release-windows.ps1 -Sidecars -Upload
```

What it does, in order:

1. **`-Sidecars`** → `build-sidecars.ps1`: builds the orchestrator (Node SEA), the
   three PyInstaller workers, `vd-piper`, a **static** libass ffmpeg (auto-download
   — see Part A.7), `vd-uv` + bundled CPython, and stages the engine-pack source.
2. `pnpm app:build` → Tauri build → the NSIS `…_x64-setup.exe` and MSI
   `…_x64_en-US.msi`, each with an updater `.sig` (the signing key from step 1).
3. Verifies all four artifacts exist.
4. **`-Upload`** → uploads the four files to the tag's **draft** release
   (`release-upload.ps1`) and merges the `windows-x86_64` entry into the release's
   `latest.json` (`merge-latest-json.mjs`, preserving the mac entry if it's already
   there; `--fix-tag` repairs a stray `untagged-<sha>` draft tag).

Build only (inspect before uploading): drop `-Upload`. Upload later by re-running
with `-Upload`, or manually per [`RELEASING.md`](RELEASING.md).

The installers are **unsigned** (no Authenticode certificate), so first launch
shows Windows SmartScreen — **More info → Run anyway**.

### Publish

The Mac and Windows both upload to the same draft (found by tag). On the GitHub
**Releases** page, open the draft and confirm before publishing:

1. Assets present: Windows `…-setup.exe(.sig)` + `…_en-US.msi(.sig)`, macOS `.dmg`
   + `VideoDubber_<ver>_aarch64.app.tar.gz(.sig)`, and `latest.json`.
2. `latest.json` has **both** `windows-x86_64` and `darwin-aarch64` entries and its
   `version` matches the tag.
3. The draft's tag is the real `vX.Y.Z` (not `untagged-<sha>`).

Then **Publish**. Publishing is what makes the updater endpoint
(`releases/latest/download/latest.json`) point at this version, so users on the
previous version get the auto-update.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Script errors with weird parameter/parse errors | You're in **Windows PowerShell 5.1**. Use **`pwsh`** (PowerShell 7). |
| `pnpm` not found after installing Node | Reopen the terminal; run `corepack enable`. |
| Rust/Tauri build fails with "link.exe not found" / MSVC errors | The **C++ Build Tools** workload isn't installed (Part A.5). |
| A worker window says "no `.venv`" | Run `pwsh scripts\setup-local-models.ps1` (Part C). |
| Rendered video fails / "ffmpeg not found" in dev | Confirm `ffmpeg -version` works in a fresh `pwsh` (PATH from Part A.7). |
| Release build fails on ffmpeg with a "SHARED build" error | You set `FFMPEG_PATH` to `D:\ffmpeg` (a shared build). Unset it — the build auto-downloads a static one. Only add `D:\ffmpeg\bin` to **PATH**, not to `FFMPEG_PATH`. |
| Build has no `.sig` files / updater can't install | `TAURI_SIGNING_PRIVATE_KEY` isn't set and `%USERPROFILE%\.tauri\videodubber.key` is missing (release setup step 1). |
| TTS produces silence in dev | Set `PIPER_BINARY_PATH` + `PIPER_VOICE_MODEL_PATH` (Part A.8 / D), or accept the silent dev fallback. |
| Auto-update didn't offer the new version | Check that the release is **published** (not draft) and `latest.json` has your platform entry with the right download URL. |

More detail: [`LOCAL_SETUP.md`](LOCAL_SETUP.md) (setup internals),
[`RELEASING.md`](RELEASING.md) (release runbook + signing),
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
