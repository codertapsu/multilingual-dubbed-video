# Desktop app — running the Tauri shell from source

This is the **contributor** guide to the native desktop shell: how to build and run
it from a source checkout, and how it starts and stops the backend for you.

> **Installed the app from a release instead?** You are in the wrong place — this
> page starts by asking you to install Rust. Read
> [**USER_GUIDE.md**](USER_GUIDE.md), which assumes nothing but the installer.
> (This file used to be indexed from the README as the "simple install & use
> guide"; it never was one.)

> Prefer to run the UI in a browser instead (no Rust needed)? See the
> [README "Running the app"](../README.md#running-the-app) section. Everything below is
> for the native desktop shell.

---

## What "the desktop app" does

When you **open** the app, the Tauri shell launches the backend automatically:

- the **Node orchestrator** (the pipeline engine, port 5100), and
- the three **Python workers** — STT (5101), Translation (5102), TTS (5103).

When you **close/quit** the app, all of those are shut down automatically. One window =
the whole stack. Any optional **engine packs** the project uses (accelerated
whisper.cpp, local-LLM translation, neural TTS, separation, alignment) are also
started on demand and stopped on quit by the orchestrator — see
[`PROVIDERS.md`](PROVIDERS.md#engine-packs).

Internally there are two lifecycle paths in
[`apps/desktop/src-tauri/src/sidecar.rs`](../apps/desktop/src-tauri/src/sidecar.rs):

- **Installed/bundled app** — the shell spawns the frozen `externalBin` sidecars
  (orchestrator + 3 workers + the `vd-piper` CLI + ffmpeg/ffprobe) directly and
  tracks them for teardown. Nothing else needs to be installed first.
- **Dev (source checkout)** — the shell runs
  [`scripts/start-services.sh`](../scripts/start-services.sh)
  (`scripts\start-services.ps1` on Windows) in its own process group and terminates
  that group on exit.

---

## 1. Prerequisites

You need the things any local install needs, **plus Rust** (to build the native shell):

| Tool | Install |
|---|---|
| **Node ≥ 22.12 — use Node 24 LTS** (what releases are built with) & **pnpm 11.9.0** | `corepack enable && corepack prepare pnpm@11.9.0 --activate` |
| **Python 3.12** | macOS: `brew install python@3.12` · Windows: `winget install --id Python.Python.3.12 -e` · Linux: distro package. 3.12 is what the engine-pack venvs and the bundled interpreter use — matching it keeps dependency resolution identical to a release. |
| **FFmpeg** (with **libass** for burned-in subs) | macOS: `brew install ffmpeg-full` · Linux: distro `ffmpeg` · Windows: gyan.dev build |
| **Rust** | [rustup.rs](https://rustup.rs) — needed only for the native app |

Full per-OS details: [`LOCAL_SETUP.md`](LOCAL_SETUP.md).

---

## 2. One-time setup

```bash
# from the project root
corepack enable
pnpm install                       # JS/TS dependencies

# create the Python worker venvs, install their deps, and download models
bash scripts/setup-local-models.sh         # Windows: pwsh scripts/setup-local-models.ps1

# (recommended) point the app at your FFmpeg/Python/Piper via .env
cp .env.example .env
#   then edit .env, e.g.:
#   FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
#   FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe
#   PIPER_BINARY_PATH=/path/to/piper
#   PIPER_VOICE_MODEL_PATH=/path/to/voice.onnx

# sanity check
pnpm verify
```

`pnpm verify` prints an OK / MISSING / WARN table for Node, pnpm, Python, FFmpeg, the
workers, and the models, each with a fix hint.

---

## 3. Run the desktop app

```bash
pnpm app
```

That single command:

1. builds/serves the Angular UI,
2. opens the native VideoDubber window,
3. **auto-starts** the orchestrator + workers, and
4. **auto-stops** them when you close the window.

First launch compiles the Rust shell (a few minutes); subsequent launches are fast.

Inside the app: **New Project → pick a video → choose source & target languages →
subtitle mode → Start**. Watch the nine steps run (`probe-video → extract-audio → stt
→ translation → refine → tts → alignment → audio-mix → render`), edit the translation
if you like, then open the finished video from the Export screen. The end-user walk
through of every screen is in [`USER_GUIDE.md`](USER_GUIDE.md).

---

## 4. Build a distributable app (optional)

```bash
# one-time: generate the app icons from a 1024×1024 PNG
pnpm --filter videodubber-desktop tauri icon path/to/icon.png

# build the bundled sidecars (orchestrator + workers + ffmpeg), then the native bundle
pnpm package:sidecars
pnpm app:build         # .app/.dmg (macOS), -setup.exe + .msi (Windows)
```

The bundle lands under `apps/desktop/src-tauri/target/release/bundle/`.

> `bundle.targets` in `tauri.conf.json` is `["app","dmg","nsis","msi"]`. Tauri
> silently intersects that list with the host platform's supported types, so a
> **Linux** `tauri build` matches nothing, exits 0, and produces no package at all.
> Linux is not shippable today — see [`RELEASING.md`](RELEASING.md).

> **Note — standalone installers.** The release bundle is **self-contained**: run
> `pnpm package:sidecars` first, then `pnpm app:build`. The Node orchestrator (Node
> SEA), the three Python workers (PyInstaller) + a bundled CPython, `vd-piper`,
> `vd-uv`, and `ffmpeg`/`ffprobe` all ship — as `bundle.externalBin` and
> `bundle.resources` in `tauri.conf.json` — so end users need nothing pre-installed
> (only the AI **models** download on first run). Skipping `package:sidecars` builds a
> dev bundle that still launches workers from the project layout. For the full release
> runbook see [`RELEASING.md`](RELEASING.md); on **macOS** `tauri build` alone is not
> notarizable (it adhoc-signs the bundled workers/ffmpeg) — a deep-sign + notarize pass
> is mandatory, via `bash scripts/package/release-macos.sh` (see
> [`APPLE_SIGNING.md`](APPLE_SIGNING.md)).

---

## 5. Turning auto-management off

If you want to run the backend yourself (e.g. with `pnpm dev` in a terminal for live
logs) and have the desktop shell just attach to it:

```bash
VIDEODUBBER_MANAGE_SERVICES=0 pnpm app
```

With this set, the app will **not** start or stop services — it assumes they are already
running at `http://127.0.0.1:5100` (and the workers on 5101–5103).

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| App opens but everything is "unavailable" | The shell couldn't find/launch the backend. Confirm you ran `pnpm install` + `setup-local-models.sh`, and that `pnpm dev` works from the same folder. Set `VIDEODUBBER_REPO_DIR` to the project root if running the app from elsewhere. |
| Burned-in subtitles fail (`FFMPEG_FILTER_MISSING`) | Your FFmpeg lacks libass. Install one with it (`brew install ffmpeg-full`) and set `FFMPEG_PATH`/`FFPROBE_PATH` in `.env`, or use the **embedded-soft / srt-file** subtitle modes. See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#ffmpeg_filter_missing). |
| STT/Translation errors about missing models | Run `scripts/setup-local-models.sh`; see [`MODEL_SETUP.md`](MODEL_SETUP.md). |
| Ports already in use after a crash | `pnpm stop` (port-based; clears 1420 + 5100–5103). |
| `pnpm app` fails to compile | Install Rust via [rustup](https://rustup.rs); on Linux install the [Tauri system deps](https://tauri.app/start/prerequisites/). |

More: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
