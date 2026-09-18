# Local setup

How to install everything VideoDubber needs and run each piece locally. Everything here
is **offline-first** — once dependencies and models are present, no network is required.

---

## 0. The short version

```bash
corepack enable         # (once) gives you the pnpm version this repo pins

pnpm bootstrap          # set everything up
pnpm dev                # run everything → http://localhost:1420
```

**`pnpm bootstrap` is the same command on macOS, Linux and Windows.** Every task script
in this repo ships as a `.sh` + `.ps1` pair, and `scripts/run.mjs` dispatches to the
right half for your OS — so there is no separate `pwsh scripts/…` invocation to
remember any more.

It runs five numbered phases:

1. **Prerequisites** — Node, pnpm, Python, FFmpeg, and Rust only if you want the native
   desktop window. Anything missing is reported with the **exact install command for
   your OS**, and bootstrap stops. It deliberately does **not** install system
   software, run `sudo`, or change your PATH for you.
2. **`pnpm install`** — the TypeScript/Node workspace dependencies (section 1 below).
3. **`pnpm build`** — the workspace libraries. Not optional: `@videodubber/shared` and
   `@videodubber/media-worker` are consumed through `exports` that point at `dist/`, so
   without this `pnpm dev` dies at `Could not resolve "@videodubber/shared"`.
4. **`setup-local-models`** — a `.venv` per Python worker with its `requirements.txt`,
   a pre-cached faster-whisper model, an Argos language pair, a Piper voice
   (sections 2 and [`MODEL_SETUP.md`](MODEL_SETUP.md)). It resolves a real **Python
   3.12** and passes it as `PYTHON_PATH` rather than letting the ambient interpreter
   decide — see [Choosing the Python version](#choosing-the-python-version) for why
   that matters. Needs the network, but never fails hard offline: it prints the manual
   steps instead.
5. **`pnpm doctor`** — the environment table (section 4).

It is **idempotent**; re-run it whenever you want, and it skips what is already there.

Flags go straight after the task name, with **no `--` separator** —
`pnpm bootstrap --skip-models`. (pnpm 11 forwards a literal `--` to the script
instead of swallowing it, and the script rejects it as an unknown option.)

| macOS / Linux | Windows | Env | Effect |
|---|---|---|---|
| `--skip-deps` | `-SkipDeps` | `SKIP_DEPS=1` | Skip `pnpm install`. |
| `--skip-build` | `-SkipBuild` | `SKIP_BUILD=1` | Skip `pnpm build`. |
| `--skip-python` | `-SkipPython` | `SKIP_PYTHON=1` | No venvs, no models. |
| `--skip-models` | `-SkipModels` | `SKIP_MODELS=1` | Venvs yes, model downloads no. |
| `--strict` | `-Strict` | `STRICT=1` | Treat optional prerequisites as errors. |
| `--help` | `-Help` | — | The flag list. |

**The rest of this page is the by-hand version**: what each of those steps actually
does, how to change it, and what to do when one of them fails.

---

## 1. Node.js + pnpm

The project needs **Node ≥ 22.12**; **use Node 24 LTS** to match what the release was
built with, and **pnpm 11.9.0** (pinned in `package.json`'s `packageManager`).

`package.json` is the single source of truth for both. Node 20 is not an option any
more: it went end-of-life on 2026-04-30, and Angular 22's CLI declares
`engines.node = "^22.22.3 || ^24.15.0 || >=26.0.0"`, so it refuses to run on it.

```bash
# Install Node 24 LTS (nvm shown; or use https://nodejs.org)
nvm install 24
nvm use 24

# Enable the pinned pnpm via Corepack (ships with Node) — preferred:
corepack enable
corepack prepare pnpm@11.9.0 --activate
node --version   # expect v24.x
pnpm --version   # expect 11.9.0

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

**Use Python 3.12.** It is what `UV_PYTHON_VERSION` gives every engine-pack venv and
what the installer's bundled interpreter is, so matching it keeps dependency
resolution identical to a release. 3.11 and 3.13 do run — faster-whisper/ctranslate2,
argostranslate and Piper all ship wheels — but the metadata is marker-sensitive
across that boundary (libretranslate resolves a different numpy on 3.13), so a bug
you hit on 3.13 may not be a bug a user can hit. ⚠️ **Avoid 3.14 for now** — some ML
wheels aren't published for the newest interpreter yet, which forces slow or failing
source builds. See [Choosing the Python version](#choosing-the-python-version).

Each worker has its own `requirements.txt` and gets its own `.venv`. `pnpm bootstrap`
already did this; to run just this step again, on any OS:

```bash
node scripts/run.mjs setup-local-models
```

That creates `workers/<name>/.venv`, installs each `requirements.txt`, then pre-caches
models (see [`MODEL_SETUP.md`](MODEL_SETUP.md)). Individual steps are skippable via env
vars (`SKIP_VENVS=1`, `SKIP_MODELS=1`, `SKIP_WHISPER=1`, `SKIP_ARGOS=1`, `SKIP_PIPER=1`),
which the PowerShell twin also accepts as the switches `-SkipVenvs`, `-SkipModels`,
`-SkipWhisper`, `-SkipArgos`, `-SkipPiper`.

### Choosing the Python version

The project **never uses your system `python3`** for the workers — it builds a `.venv`
per worker from whatever **`PYTHON_PATH`** points at (default `python3`), and the run
scripts prefer those `.venv`s. So to pin a specific interpreter — and you should pin
**3.12**, the version the bundled interpreter and every engine-pack venv use — point
the setup at it:

```bash
# macOS: install a specific Python, then build the worker venvs with it
brew install python@3.12
PYTHON_PATH=/opt/homebrew/bin/python3.12 node scripts/run.mjs setup-local-models
```

```powershell
# Windows: same idea
winget install --id Python.Python.3.12 -e
$env:PYTHON_PATH = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
node scripts/run.mjs setup-local-models
```

This creates `workers/<name>/.venv` on 3.12; `pnpm dev` / `pnpm app` then use them
automatically. (Optionally also set `PYTHON_PATH` in your `.env` as a fallback.) The same
works with `pyenv` — `pyenv install 3.12 && pyenv local 3.12` writes a `.python-version`
so `python3` resolves to 3.12 inside the repo.

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
| macOS | `brew install ffmpeg` (or `brew install ffmpeg-full` for **libass** — see below) |
| Windows | `winget install Gyan.FFmpeg` or `choco install ffmpeg` |
| Debian/Ubuntu | `sudo apt update && sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` (RPM Fusion) |
| Arch | `sudo pacman -S ffmpeg` |

### Burned-in subtitles need libass

The **burned-in** subtitle mode uses FFmpeg's `subtitles` filter, which only exists in
builds compiled **with libass**. The other modes (soft / `.srt` / `.vtt` sidecar) work
with any FFmpeg.

- Check your build: `ffmpeg -filters | grep subtitles` (empty ⇒ no libass).
- **macOS Homebrew's default `ffmpeg` omits libass.** Install a full build and point the
  app at it:
  ```bash
  brew install ffmpeg-full
  export FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
  export FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe   # (or put these in .env)
  ```
- Most Linux distro `ffmpeg` packages already include libass.
- If it's missing, burning fails with the clear error `FFMPEG_FILTER_MISSING` (not a
  cryptic exit code) — see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#ffmpeg_filter_missing).

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
pnpm doctor        # runs scripts/verify-environment.ts  (pnpm verify is the same script)
```

`pnpm bootstrap` ends with this, but run it any time — it is read-only and cheap.

This checks Node, pnpm, Python, ffmpeg/ffprobe, the three worker `/health` endpoints,
the orchestrator `/health`, a faster-whisper model hint, installed Argos languages, and
Piper configuration. It only exits non-zero when a **core** requirement (Node or pnpm) is
missing; everything else is reported with a remediation hint and a docs link.

It is written in TypeScript and runs identically on every OS, which is why there is no
shell "checker" to keep in sync alongside it.

---

## 5. Running the services

### Start & stop everything (single commands)

**One command per goal, identical on every OS** — `scripts/run.mjs` runs the `.sh` on
macOS/Linux and the `.ps1` on Windows:

| Goal | Command |
|---|---|
| Start everything, **foreground** (Ctrl-C stops) | `pnpm dev` |
| Start everything, **detached** (terminal returns) | `pnpm start` |
| **Stop everything** (any start method) | `pnpm stop` |
| Backend only (no UI), foreground | `pnpm services` |
| Native desktop app (auto start/stop) | `pnpm app` |

> The `.ps1` scripts are still there and still runnable directly if you want to pass a
> PowerShell switch such as `-SkipWorkers`; you just no longer *have* to know which file
> to invoke.

URLs printed on startup:

| Service | URL |
|---|---|
| Angular UI | http://localhost:1420 |
| Orchestrator | http://127.0.0.1:5100 |
| STT worker | http://127.0.0.1:5101 |
| Translation worker | http://127.0.0.1:5102 |
| TTS worker | http://127.0.0.1:5103 |

- `pnpm stop` is **port-based**, so it reliably tears down the whole stack however it was
  started (foreground, detached, individual `dev:*` commands, or the desktop app).
- `SKIP_WORKERS=1 pnpm dev` (UI + orchestrator only) and `SKIP_UI=1 pnpm dev` (workers +
  orchestrator only) are available, as is `SKIP_LIB_WATCH=1`. On Windows the same three
  exist as the switches `-SkipWorkers`, `-SkipUi`, `-SkipLibWatch` on `scripts\dev.ps1`.
  Logs land in `.dev-logs/`.
- The start/stop scripts **load `.env`** automatically, so machine paths like
  `FFMPEG_PATH`, `PYTHON_PATH`, and `PIPER_*` are applied to every service.

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

Or start all three with `pnpm dev:workers` (`scripts/dev-workers.sh` on macOS/Linux,
`scripts\dev-workers.ps1` on Windows — `pnpm dev:workers` picks the right one).

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

> **The workspace libraries must be built, even in dev.** `@videodubber/shared`
> and `@videodubber/media-worker` are consumed through their package `exports`,
> which point at `dist/`, not `src/`. `pnpm dev` / `pnpm start` now build them
> first and keep a `tsc --watch` running per library, so this is handled for
> you — but if you start `ng serve` **by itself**, build them yourself first:
>
> ```bash
> pnpm --filter @videodubber/shared --filter @videodubber/media-worker build
> ```
>
> Skipping it fails in two ways that look nothing like the cause:
> *no* `dist` gives `Could not resolve "@videodubber/shared"`, while a **stale**
> `dist` resolves fine but is missing anything added since the last build (e.g.
> `updateNoticeFor is not exported`), which reads like an app bug rather than a
> stale artifact. `pnpm build` builds the libraries as a matter of course, which
> is why production never showed this.
>
> Set `SKIP_LIB_WATCH=1` to skip the watchers if you are not editing the
> libraries — but then your edits to them will not appear until you rebuild.

> **Do not remove `prebundle.exclude` from `apps/desktop/angular.json`.** The
> dev server is Vite-based and pre-bundles dependencies into
> `.angular/cache/**/vite/deps/`. That cache is keyed on dependency *metadata*,
> not on the contents of a linked workspace package, so a rebuilt
> `packages/shared/dist` does **not** invalidate it: the browser keeps loading
> a bundle that can be months old and fails with
> `does not provide an export named 'updateNoticeFor'` even though `dist` is
> perfectly correct. Listing the two workspace libraries under
> `serve.options.prebundle.exclude` keeps them out of that cache so they are
> always read fresh; third-party packages are still pre-bundled, so startup
> stays fast. Add any future first-party `@videodubber/*` library to the list.
>
> If you hit a stale prebundle anyway, clear it with:
>
> ```bash
> rm -rf apps/desktop/.angular/cache
> ```

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

Run the native shell with **one command** — it auto-starts and auto-stops the backend:

```bash
pnpm app           # = pnpm --filter videodubber-desktop tauri dev
```

What happens:

- Tauri's `beforeDevCommand` boots the Angular dev server on **1420** (matches
  `devUrl` in `tauri.conf.json`).
- The Rust shell's **service manager** ([`src/sidecar.rs`](../apps/desktop/src-tauri/src/sidecar.rs))
  launches the orchestrator + the 3 Python workers on startup, and **terminates them on
  quit**. So opening the app starts everything; closing it stops everything.
- It locates the project (for `scripts/`) via `pnpm-workspace.yaml`, or
  `VIDEODUBBER_REPO_DIR` if set.

Already running the backend yourself (e.g. `pnpm dev` in a terminal)? Disable
auto-management so the app just attaches:

```bash
VIDEODUBBER_MANAGE_SERVICES=0 pnpm app
```

See [`DESKTOP_APP.md`](DESKTOP_APP.md) for the end-user install & use guide and the
release-bundle / standalone-installer notes.

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

---

## 8. Next

[`../CONTRIBUTING.md`](../CONTRIBUTING.md) has the full `pnpm` task reference, the repo
layout, how to run every test suite (TypeScript, Python and Rust), the house
conventions, and how to propose a change. [`WINDOWS.md`](WINDOWS.md) is the complete
Windows toolchain walkthrough, including the release path.
