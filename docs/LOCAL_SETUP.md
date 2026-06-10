# Local setup

How to install everything VideoDubber needs and run each piece locally. Everything here
is **offline-first** — once dependencies and models are present, no network is required.

> TL;DR: `corepack enable && pnpm install`, then
> `bash scripts/setup-local-models.sh`, then `pnpm verify`, then `pnpm dev`.

---

## 1. Node.js + pnpm

VideoDubber targets **Node 20.11+** (LTS) and **pnpm 9.x**.

```bash
# Install Node 20+ (nvm shown; or use https://nodejs.org)
nvm install 20
nvm use 20

# Enable pnpm via Corepack (ships with Node) — preferred:
corepack enable
# ...or install globally:
npm i -g pnpm

# Install all TypeScript/Node workspace dependencies from the repo root:
pnpm install
```

`pnpm install` installs `@videodubber/shared`, `@videodubber/media-worker`,
`@videodubber/node-orchestrator`, and `videodubber-desktop`, wiring up the
`workspace:*` links between them.

> The three Python workers are **not** part of the pnpm workspace; set them up
> separately (next section).

---

## 2. Python workers (per-worker venvs)

**Recommended Python: 3.11 or 3.12.** 3.10 works. ⚠️ **Avoid 3.14 for now** — some ML
wheels (faster-whisper / ctranslate2, numpy) may not yet ship prebuilt wheels for the
newest interpreters, which forces slow or failing source builds.

Each worker has its own `requirements.txt` and gets its own `.venv`. The setup script
does this for all three at once:

```bash
bash scripts/setup-local-models.sh        # Windows: pwsh scripts/setup-local-models.ps1
```

That creates `workers/<name>/.venv`, installs each `requirements.txt`, then pre-caches
models (see [`MODEL_SETUP.md`](MODEL_SETUP.md)). Individual steps are skippable via env
vars (`SKIP_VENVS=1`, `SKIP_MODELS=1`, `SKIP_WHISPER=1`, `SKIP_ARGOS=1`, `SKIP_PIPER=1`).

### Manual per-worker setup (if you prefer)

```bash
# STT worker (faster-whisper)
python3 -m venv workers/stt-worker/.venv
source workers/stt-worker/.venv/bin/activate         # Windows: workers\stt-worker\.venv\Scripts\activate
pip install -r workers/stt-worker/requirements.txt
deactivate

# Translation worker (Argos Translate)
python3 -m venv workers/translation-worker/.venv
source workers/translation-worker/.venv/bin/activate
pip install -r workers/translation-worker/requirements.txt
deactivate

# TTS worker (Piper / system / fallback)
python3 -m venv workers/tts-worker/.venv
source workers/tts-worker/.venv/bin/activate
pip install -r workers/tts-worker/requirements.txt
deactivate
```

### Alternative: `uv`

If you use [`uv`](https://github.com/astral-sh/uv), it's a faster drop-in:

```bash
cd workers/stt-worker
uv venv .venv
uv pip install -r requirements.txt
```

Repeat for `translation-worker` and `tts-worker`. The dev launch scripts look for
`workers/<name>/.venv/bin/python` regardless of how the venv was created.

> Each worker also has a `requirements-dev.txt` (pytest/httpx) and a `pyproject.toml`
> mirroring the runtime deps, if you prefer `pip install ".[dev]"`.

---

## 3. FFmpeg + ffprobe

FFmpeg (with `ffprobe`) is required at run time for probe / extract-audio / audio-mix /
render. Install per OS:

| OS | Command |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` or `choco install ffmpeg` |
| Debian/Ubuntu | `sudo apt update && sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` (RPM Fusion) |
| Arch | `sudo pacman -S ffmpeg` |

If FFmpeg is not on your `PATH`, point the app at the binaries explicitly:

```bash
export FFMPEG_PATH=/absolute/path/to/ffmpeg
export FFPROBE_PATH=/absolute/path/to/ffprobe
```

Verify:

```bash
ffmpeg -version
ffprobe -version
```

Missing FFmpeg surfaces as `FFMPEG_NOT_FOUND` / `FFPROBE_NOT_FOUND` — see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#ffmpeg_not_found).

---

## 4. Verify your environment

```bash
pnpm verify        # runs scripts/verify-environment.ts
```

This checks Node, pnpm, Python, ffmpeg/ffprobe, the three worker `/health` endpoints,
the orchestrator `/health`, a faster-whisper model hint, installed Argos languages, and
Piper configuration. It only exits non-zero when a **core** requirement (Node or pnpm) is
missing; everything else is reported with a remediation hint and a docs link.

---

## 5. Running the services

### Everything at once

```bash
pnpm dev        # scripts/dev.sh — workers + orchestrator + Angular UI
```

URLs printed on startup:

| Service | URL |
|---|---|
| Angular UI | http://localhost:1420 |
| Orchestrator | http://127.0.0.1:5100 |
| STT worker | http://127.0.0.1:5101 |
| Translation worker | http://127.0.0.1:5102 |
| TTS worker | http://127.0.0.1:5103 |

`SKIP_WORKERS=1 pnpm dev` (UI + orchestrator only) and `SKIP_UI=1 pnpm dev`
(workers + orchestrator only) are available. Logs land in `.dev-logs/`.

### Each Python worker individually (exact uvicorn commands)

Activate the worker's venv (or use its `.venv/bin/python -m uvicorn`), then run from
inside the worker directory so `app.main:app` resolves:

```bash
# STT worker  — port 5101
cd workers/stt-worker
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 5101 --reload

# Translation worker — port 5102
cd workers/translation-worker
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 5102 --reload

# TTS worker — port 5103
cd workers/tts-worker
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 5103 --reload
```

Or start all three with `pnpm dev:workers` (`scripts/dev-workers.sh`).

Each `/health` returns `{ "status":"ok", ... }` plus capability hints:

```bash
curl -s http://127.0.0.1:5101/health
curl -s http://127.0.0.1:5102/health
curl -s http://127.0.0.1:5103/health
```

### Orchestrator individually

```bash
pnpm dev:orchestrator        # tsx watch src/server.ts — port 5100
curl -s http://127.0.0.1:5100/health          # { "status":"ok" }
curl -s http://127.0.0.1:5100/workers/health  # availability of stt/translation/tts/ffmpeg/ffprobe
```

### Desktop UI

**Browser dev mode (no Rust):**

```bash
pnpm dev:desktop        # ng serve --port 1420
# open http://localhost:1420
```

The Angular UI talks to the orchestrator at `http://127.0.0.1:5100` over HTTP and
subscribes to SSE for progress. Native-only features (file dialog, "open folder")
degrade gracefully outside Tauri.

**Full Tauri desktop app (needs Rust):** see next section.

---

## 6. Rust + Tauri (only for the native desktop app)

The browser dev mode needs **no Rust**. To build/run the native Tauri 2 shell you need
the Rust toolchain.

```bash
# Install Rust (stable; Tauri 2 needs rustc >= 1.77.2)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # https://rustup.rs
rustup default stable
```

Platform build prerequisites (see [Tauri's prerequisites guide](https://tauri.app)):

| OS | Extra packages |
|---|---|
| macOS | Xcode Command Line Tools (`xcode-select --install`) |
| Windows | Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11) |
| Linux | `webkit2gtk`, `libappindicator`, `librsvg`, `patchelf`, build essentials |

Run the native shell (start the backend separately first):

```bash
# Terminal 1: backend only
SKIP_UI=1 pnpm dev

# Terminal 2: native window (loads the Angular dev server on :1420)
pnpm --filter videodubber-desktop tauri dev
```

`tauri.conf.json` sets `devUrl` to `http://localhost:1420`, so the Angular dev server
**must** be serving on **1420** for `tauri dev` (the desktop `dev` script already uses
`--port 1420`). `beforeDevCommand` is intentionally empty so Tauri doesn't try to boot a
second Angular server.

### App icons (`pnpm tauri icon`)

A release **bundle** requires generated icon files. From a single source PNG (1024×1024
recommended):

```bash
pnpm --filter videodubber-desktop tauri icon path/to/source.png
```

This populates `apps/desktop/src-tauri/icons/` with the `32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.icns`, and `icon.ico` referenced in `tauri.conf.json`.
`tauri dev` does not strictly require all icons, but `tauri build` does.

---

## 7. Configuration recap

Copy `.env.example` to `.env` and adjust as needed. All values have safe defaults; the
app runs fully offline with none set.

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_URL` | `http://127.0.0.1:5100` | Orchestrator engine. |
| `STT_WORKER_URL` / `TRANSLATION_WORKER_URL` / `TTS_WORKER_URL` | 5101 / 5102 / 5103 | Worker URLs. |
| `VIDEODUBBER_PROJECTS_DIR` | `~/VideoDubber/projects` | Per-project workspaces. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | PATH lookup | FFmpeg binaries. |
| `PYTHON_PATH` | `python3` | Interpreter the dev scripts use. |
| `FASTER_WHISPER_MODEL` | `small` | Whisper model size. |
| `PIPER_BINARY_PATH` / `PIPER_VOICE_MODEL_PATH` | (unset) | Enable Piper TTS. |

For models (Whisper / Argos / Piper) see [`MODEL_SETUP.md`](MODEL_SETUP.md). For
problems, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
