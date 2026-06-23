# Desktop app — install & use guide

This is the **simple guide** to installing and using VideoDubber as a desktop
application. The desktop app opens a native window and **automatically starts and
stops all the background services for you** — you never run `pnpm dev` by hand.

> Prefer to run it in a browser instead (no Rust needed)? See the
> [README "Running the app"](../README.md#running-the-app) section. Everything below is
> for the native desktop experience.

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
| **Node 20.11+ & pnpm 9** | `corepack enable` (pnpm) |
| **Python 3.11–3.13** | macOS: `brew install python@3.13` · Windows: python.org · Linux: distro package |
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
subtitle mode → Start**. Watch the 8 steps run, edit the translation if you like, then
open the finished video from the Export screen.

---

## 4. Build a distributable app (optional)

```bash
# one-time: generate the app icons from a 1024×1024 PNG
pnpm --filter videodubber-desktop tauri icon path/to/icon.png

# build the bundled sidecars (orchestrator + workers + ffmpeg), then the native bundle
pnpm package:sidecars
pnpm app:build         # .app/.dmg (macOS), .msi/.exe (Windows), .deb/AppImage (Linux)
```

The bundle lands under `apps/desktop/src-tauri/target/release/bundle/`.

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
| Burned-in subtitles fail (`FFMPEG_FILTER_MISSING`) | Your FFmpeg lacks libass. Install one with it (`brew install ffmpeg-full`) and set `FFMPEG_PATH`/`FFPROBE_PATH` in `.env`, or use the **embedded-soft / srt-file** subtitle modes. See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#ffmpeg-filter-missing). |
| STT/Translation errors about missing models | Run `scripts/setup-local-models.sh`; see [`MODEL_SETUP.md`](MODEL_SETUP.md). |
| Ports already in use after a crash | `pnpm stop` (port-based; clears 1420 + 5100–5103). |
| `pnpm app` fails to compile | Install Rust via [rustup](https://rustup.rs); on Linux install the [Tauri system deps](https://tauri.app/start/prerequisites/). |

More: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
