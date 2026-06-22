# VideoDubber

**Dub any video into another language — locally, offline, and for free.**

VideoDubber is a local/offline-first desktop app that transcribes a video, translates
the transcript, re-voices it with text-to-speech, time-aligns the new audio to the
original timing, mixes it back over the (optionally ducked) background, and renders a
finished dubbed video — with optional soft, burned-in, or sidecar subtitles.

Everything runs on your machine by default. No cloud account, no API keys, no
per-minute billing. Cloud providers are an **opt-in** future enhancement, never a
requirement.

---

## Download & install (desktop app)

**Just want to use VideoDubber?** Head to the
[**Releases**](https://github.com/codertapsu/multilingual-dubbed-video/releases) page and
grab the installer for your OS — no Python, Node, or FFmpeg required. Each build is
**fully self-contained**: it bundles the app, the pipeline engine, all three AI
workers, and FFmpeg.

| Your machine | File to download | First launch |
|---|---|---|
| **Mac — Apple Silicon** (M1/M2/M3/M4) | `VideoDubber_<ver>_aarch64.dmg` | One-time unlock — see **[macOS first launch](#macos-first-launch)** below. |
| **Windows (64-bit)** | `VideoDubber_<ver>_x64-setup.exe` (or `_x64_en-US.msi`) | SmartScreen → **More info → Run anyway**. |
| **Linux (64-bit)** | `VideoDubber_<ver>_amd64.AppImage` / `.deb` | `chmod +x *.AppImage && ./VideoDubber*.AppImage`, or `sudo dpkg -i *.deb`. |
| **Mac — Intel** | `VideoDubber_<ver>_x64.dmg` | Same one-time unlock — see **[macOS first launch](#macos-first-launch)** below. |

> **Which Mac do I have?**  → **About This Mac**: "Apple M…" = Apple Silicon, "Intel" = Intel.

### macOS first launch

This build is **not yet notarized by Apple**, so macOS quarantines it and shows
*"VideoDubber cannot be opened because Apple cannot check it for malicious
software."* Clearing this is a **one-time** step:

1. Open the `.dmg` and drag **VideoDubber** into your **Applications** folder.
2. Open **Terminal** (press **⌘ Space**, type `Terminal`, press **Return**).
3. Paste this line exactly and press **Return**:
   ```sh
   xattr -dr com.apple.quarantine /Applications/VideoDubber.app
   ```
4. Open **VideoDubber** from Applications as usual. You won't need to do this again.

> **Heads up:** the old "right-click → Open" trick **no longer works** on macOS
> Sequoia (15) and later — Apple removed it. A GUI route (try to open it, then
> **System Settings → Privacy & Security → Open Anyway**) sometimes appears, but
> the Terminal command above is the reliable one. Once we ship a **signed +
> notarized** build, this step goes away entirely and the app opens with a
> double-click.

Not every platform is necessarily attached to a given release — builds are added as
they're ready, so check the Releases page for the installers currently available.

**First launch** runs a one-time wizard that downloads the AI **models** for the
languages you choose (the only thing not in the installer); after that the app works
fully **offline**. To update, download a newer release from the Releases page —
in-app auto-update arrives in a later version (then toggleable in **Settings →
Updates**).

> Bundle internals: [`docs/PRODUCTION.md`](docs/PRODUCTION.md) · auto-update design:
> [`docs/AUTOUPDATE.md`](docs/AUTOUPDATE.md).

**Building the installers / cutting a release?** See
[`docs/RELEASING.md`](docs/RELEASING.md) (`pnpm package:sidecars` + `pnpm app:build`;
macOS is built locally — the hybrid CI/local model is documented there). The rest of
this README covers **developing from source**.

---

## Why local-first? (the cost-first pitch)

Commercial dubbing services and cloud STT/MT/TTS APIs charge per minute of audio and
per character translated. For long videos, batches, or iterative editing, that adds up
fast — and your media leaves your machine.

VideoDubber flips that model:

- **$0 marginal cost.** Local engines (faster-whisper, Argos Translate, Piper) run on
  your CPU/GPU. Dub as much as you want.
- **Private by default.** Your video, audio, and transcripts never leave your computer
  unless *you* explicitly enable a cloud provider.
- **Offline-capable.** Once models are downloaded, no network is required.
- **Cloud is optional.** A future `cloud-enhanced` mode lets you opt specific steps into
  higher-quality cloud providers (per-key, per-step), but the default is always local.
  See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

---

## Features

- 8-step dubbing pipeline: **probe → extract-audio → STT → translation → TTS →
  alignment → audio-mix → render**.
- Local speech-to-text via **faster-whisper** (word timestamps, language auto-detect).
- Local machine translation via **Argos Translate** (offline neural MT).
- Local text-to-speech via **Piper**, with graceful fallbacks to **system TTS**
  (macOS `say`, Linux `espeak-ng`) and a **dev silent/sine** generator so the pipeline
  always completes.
- Optional higher-quality **Vietnamese neural voice** (VieNeu‑TTS v3‑Turbo) as a
  downloadable engine pack — see the [VieNeu setup guide](docs/VIENEU_TTS_SETUP.md).
- Smart **time alignment**: stretches/compresses TTS within configurable speed/overflow
  limits and flags segments that need review.
- **Audio mixing** with optional original background audio, ducking, and TTS gain.
- **Subtitles**: none, `.srt` sidecar, `.vtt` sidecar, embedded soft subtitles, or
  burned-in (with style controls).
- **Resumable pipeline**: steps are skipped if their output artifacts already exist;
  retry a single step to re-run it and everything downstream.
- **Editable transcript**: review and correct translated segments, re-synthesize a
  single segment without re-running the whole job.
- **Dual mode**: run the Angular UI in a plain browser (no Rust needed), or build the
  full **Tauri 2** native desktop app.
- Live progress over **Server-Sent Events (SSE)**.

---

## Architecture at a glance

```
                          ┌──────────────────────────────────────────┐
                          │  videodubber-desktop                       │
                          │  Angular 18 UI  ──(SSE + HTTP)──┐           │
                          │   in a browser  OR  in Tauri 2  │           │
                          └─────────────┬───────────────────┘          │
                                        │ HTTP / SSE                    │
                                        ▼                               │
                          ┌──────────────────────────────────────────┐ │
                          │  @videodubber/node-orchestrator  :5100     │ │ Tauri commands
                          │  resumable pipeline · provider registry ·  │◄┘ (reqwest proxy)
                          │  workspace store · SSE events              │
                          └───┬─────────┬─────────┬──────────┬────────┘
                              │         │         │          │
              FFmpeg (argv)   │   HTTP  │   HTTP  │   HTTP    │  (in-process)
                              ▼         ▼         ▼          ▼
                  ┌───────────────┐ ┌────────┐ ┌────────┐ ┌────────┐
                  │ media-worker  │ │  STT   │ │ Transl │ │  TTS   │
                  │ FFmpeg/ffprobe│ │ :5101  │ │ :5102  │ │ :5103  │
                  │ (Node TS)     │ │whisper │ │ Argos  │ │ Piper  │
                  └───────────────┘ └────────┘ └────────┘ └────────┘
```

- **`@videodubber/shared`** — TypeScript types + subtitle/language/pipeline utilities,
  imported by every TS component.
- **`@videodubber/media-worker`** — Node FFmpeg/ffprobe wrapper implementing
  `MediaService` (probe, extract audio, render). Used in-process by the orchestrator.
- **`@videodubber/node-orchestrator`** (port **5100**) — the brain. HTTP engine that
  drives the pipeline, talks to the three Python workers, manages per-project
  workspaces, and streams progress via SSE.
- **Python workers** (FastAPI + uvicorn): STT **5101**, Translation **5102**, TTS
  **5103**.
- **`videodubber-desktop`** — Angular 18 standalone UI inside a Tauri 2 shell.

Full details, the 8-step flow, and the data model are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## System requirements

| Requirement | Version / notes |
|---|---|
| **OS** | macOS 12+, Windows 10/11, or a modern Linux. (Validated end-to-end on macOS arm64.) |
| **Node.js** | 20.11+ (LTS). Provides global `fetch` and ES2022. |
| **pnpm** | 9.x. Enable via `corepack enable` or `npm i -g pnpm`. |
| **Python** | **3.11–3.13** (3.13 verified working — faster-whisper/ctranslate2, argostranslate, Piper all have wheels). 3.10 works. ⚠️ **Avoid 3.14 for now** — some ML wheels aren't published yet, forcing slow/failing source builds. On macOS: `brew install python@3.13` (or `@3.12`). The project uses a **per-project** interpreter (a `.venv` or `PYTHON_PATH`), so your system `python3` version doesn't matter — see [switching Python](docs/LOCAL_SETUP.md#choosing-the-python-version). |
| **FFmpeg + ffprobe** | Required at run time for probe / extract / mix / render. Install per OS — see [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md#3-ffmpeg). **For burned-in subtitles** you need an FFmpeg built **with libass** (the `subtitles` filter). macOS Homebrew's default `ffmpeg` omits it — use `brew install ffmpeg-full` and set `FFMPEG_PATH`/`FFPROBE_PATH`. The other subtitle modes (soft / sidecar) work with any FFmpeg. |
| **Disk** | ~1–2 GB for Node deps + Python venvs + models (a small/base Whisper model, one Argos pair, one Piper voice). |
| **Rust (optional)** | Only needed to build/run the **native Tauri desktop app** (`pnpm app`). Install via [rustup](https://rustup.rs). The browser dev mode does **not** need Rust. |

Local models (downloaded by the setup script): a faster-whisper model (default
`small`; `base` is a fast CPU choice), an Argos language package (default `en → vi`),
and optionally a Piper voice for high-quality TTS. See
[`docs/MODEL_SETUP.md`](docs/MODEL_SETUP.md).

---

## Quick start

```bash
# 0. Clone, then enable pnpm
corepack enable

# 1. Install all TypeScript/Node workspace deps
pnpm install

# 2. One-time local setup: create Python venvs, install worker deps,
#    pre-cache the whisper model, install an Argos pair, fetch a Piper voice.
#    (Network step. Everything is individually skippable — see the script header.)
bash scripts/setup-local-models.sh        # Windows: pwsh scripts/setup-local-models.ps1

# 3. Verify your environment (Node, pnpm, Python, ffmpeg, workers, models)
pnpm verify

# 4. Run EVERYTHING with ONE command, then open http://localhost:1420
pnpm dev          # foreground (Ctrl-C stops everything)
#   ...or detached, so your terminal returns:
pnpm start        # start the whole stack in the background
pnpm stop         # stop the whole stack (single command)
```

Then open **http://localhost:1420** in your browser, pick a video, choose source/target
languages, and run the pipeline.

> Prefer a **native desktop window**? Run `pnpm app` (needs Rust) — it opens the app and
> **auto-starts/stops all backend services for you**. See
> [Running the app](#running-the-app) below.

> First run is slower if models still need to download. Re-runs are fully offline.

---

## Running the app

VideoDubber's UI is plain Angular 18 talking to the orchestrator over HTTP/SSE, so you
can run it two ways. **Either way, "everything" = the 3 Python workers + the Node
orchestrator + the UI.**

### A. Native desktop app — `pnpm app` (auto-manages services)

```bash
pnpm app          # needs Rust (rustup). Opens the VideoDubber window.
```

This is the intended end-user experience. The Tauri 2 shell:

- **On open:** automatically starts the backend (orchestrator + STT/translation/TTS
  workers) — you do **not** run `pnpm dev`.
- **On quit:** automatically stops all of them. Close the window → everything shuts down.

It also adds real native commands (`pick_video_file`, "open output folder", …) that proxy
to the orchestrator. Auto-management is controlled by `VIDEODUBBER_MANAGE_SERVICES`
(default on; set to `0` if you'd rather run the backend yourself). Implementation:
[`apps/desktop/src-tauri/src/sidecar.rs`](apps/desktop/src-tauri/src/sidecar.rs). See
[`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md) for the simple install & use guide.

### B. Browser dev mode (no Rust required)

```bash
pnpm dev          # foreground: workers + orchestrator + Angular UI. Ctrl-C stops all.
```

`ng serve` hosts the UI on **http://localhost:1420**; it calls the orchestrator at
`http://127.0.0.1:5100` and subscribes to SSE for progress. Native-only conveniences
degrade gracefully outside Tauri. **No Rust toolchain needed** — great for development.

### Start & stop everything (single commands)

| Goal | Command |
|---|---|
| Start everything, **foreground** (Ctrl-C to stop) | `pnpm dev` |
| Start everything, **detached** (terminal returns) | `pnpm start` |
| **Stop everything** (any start method) | `pnpm stop` |
| Open the **native desktop app** (auto start/stop) | `pnpm app` |
| Backend only (no UI), foreground | `pnpm services` |

- `pnpm stop` is **port-based** — it reliably stops the whole stack (UI 1420, orchestrator
  5100, workers 5101–5103) however it was started.
- **Windows:** use the PowerShell equivalents — `pwsh scripts/start.ps1`,
  `pwsh scripts/stop.ps1`, `pwsh scripts/dev.ps1`.
- Put machine-specific paths in a `.env` (copy from `.env.example`) — `FFMPEG_PATH`,
  `PYTHON_PATH`, `PIPER_*`, ports, etc. The start scripts load it automatically.

> Building a release **installer** (`pnpm app:build`) additionally needs app icons
> (`pnpm tauri icon …`) and, for a fully standalone installer, bundling the Python
> workers — see [`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md) and
> [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Dev command reference

| Command | What it does |
|---|---|
| `pnpm install` | Install all TS/Node workspace dependencies. |
| `bash scripts/setup-local-models.sh` | Create Python venvs + install worker deps + download models. (`.ps1` on Windows.) |
| `pnpm verify` | Run `scripts/verify-environment.ts`: checks Node/pnpm/Python/ffmpeg/workers/models. |
| `pnpm dev` | Start the **full** stack (3 workers + orchestrator + Angular UI), foreground. |
| `pnpm start` | Start the full stack **detached** (background); terminal returns. |
| `pnpm stop` | **Stop everything** (port-based; works for any start method). |
| `pnpm app` | Open the **native desktop app** (Tauri; auto starts/stops services). Needs Rust. |
| `pnpm app:build` | Build a native desktop **installer/bundle** (needs Rust + app icons). |
| `pnpm services` | Start only the backend (workers + orchestrator), no UI. |
| `pnpm dev:workers` | Start only the 3 Python workers (5101/5102/5103). |
| `pnpm dev:orchestrator` | Start only the Node orchestrator (5100). |
| `pnpm dev:desktop` | Start only the Angular UI (`ng serve`, port 1420). |
| `pnpm build` | Build the TS packages + media-worker. |
| `pnpm typecheck` | Type-check every workspace package. |
| `pnpm test` | Run unit tests (shared utils, media-worker, orchestrator). |
| `pnpm lint` | ESLint over the TypeScript sources. |

> Environment overrides for `scripts/dev.sh`: `SKIP_WORKERS=1`, `SKIP_UI=1`. For
> `scripts/setup-local-models.sh`: `SKIP_VENVS=1`, `SKIP_MODELS=1`, `SKIP_WHISPER=1`,
> `SKIP_ARGOS=1`, `SKIP_PIPER=1`, plus `FASTER_WHISPER_MODEL`, `ARGOS_FROM`/`ARGOS_TO`,
> `PIPER_VOICE`.

Copy `.env.example` to `.env` and adjust ports, binary paths, and model settings as
needed. All values have sensible defaults; the app runs fully offline with none set.

---

## Configuration

Key environment variables (see `.env.example` for the full list):

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_URL` | `http://127.0.0.1:5100` | Node orchestrator HTTP engine. |
| `STT_WORKER_URL` | `http://127.0.0.1:5101` | faster-whisper STT worker. |
| `TRANSLATION_WORKER_URL` | `http://127.0.0.1:5102` | Argos Translate worker. |
| `TTS_WORKER_URL` | `http://127.0.0.1:5103` | Piper/system/fallback TTS worker. |
| `VIDEODUBBER_PROJECTS_DIR` | `~/VideoDubber/projects` | Per-project workspaces. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | PATH lookup | FFmpeg binaries. |
| `PYTHON_PATH` | `python3` | Interpreter for the workers. |
| `FASTER_WHISPER_MODEL` | `small` | Whisper model size. |
| `PIPER_BINARY_PATH` / `PIPER_VOICE_MODEL_PATH` | (unset) | Enable the Piper TTS engine. |

Optional cloud keys (`OPENAI_API_KEY`, `DEEPL_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`,
`ELEVENLABS_API_KEY`) are **only** used by the future cloud-enhanced mode and are never
required. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

---

## Documentation

| Doc | Contents |
|---|---|
| [`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md) | **Simple install & use guide for the desktop app** + auto start/stop of services. |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) | The fully self-contained installer: what's bundled vs. downloaded on first run, the first-run wizard, prod sidecar lifecycle, storage & sizes. |
| [`docs/RELEASING.md`](docs/RELEASING.md) | Release runbook: version bump, updater keys, code signing/notarization, tag → CI → draft Release → publish. |
| [`docs/AUTOUPDATE.md`](docs/AUTOUPDATE.md) | How auto-update works (endpoint, pubkey, signature verification), the auto/manual setting, manual checks, rollback. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, pipeline flow, data model, workspace layout, HTTP API, Tauri commands, SSE model, service lifecycle. |
| [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) | Node/pnpm/Python/FFmpeg/Rust setup; running, starting & stopping each service. |
| [`docs/MODEL_SETUP.md`](docs/MODEL_SETUP.md) | Whisper / Argos / Piper models: download, storage, troubleshooting. |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | Local defaults, provider interfaces, optional cloud adapters + data flow. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Every error code, common failures, and fixes. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Planned features (diarization, source separation, voice cloning, packaging…). |

---

## Known limitations

- TTS quality depends on the chosen Piper voice; without a Piper binary/voice the worker
  falls back to system TTS or a silent/sine placeholder.
- No speaker diarization yet — all segments use a single voice.
- No source separation (music/voice) yet; ducking is a volume reduction, not stem
  isolation.
- Argos language coverage and quality vary by pair; some pairs are not available.
- Alignment uses time-stretching within limits; very dense speech may overflow and get
  flagged for review.
- Voice cloning is intentionally **excluded** (see disclaimer + roadmap).

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's planned.

---

## Legal & usage disclaimer

VideoDubber is a tool. **You are responsible for how you use it.**

- **Only dub videos you own or have explicit permission to process.** Respect copyright,
  licensing, and platform terms of service.
- **Translations and synthetic voices can be inaccurate.** Review output before
  publishing, especially for sensitive or factual content.
- **Voice cloning is not included.** VideoDubber uses generic TTS voices. Any future
  voice-cloning capability would require **explicit, documented consent** from the
  person whose voice is involved and a legal review (see
  [`docs/ROADMAP.md`](docs/ROADMAP.md)). Do not use this software to impersonate anyone.
- **No warranty.** Provided "as is" under the MIT License (see [`LICENSE`](LICENSE)).

### Reference attribution

The project [`jianchang512/stt`](https://github.com/jianchang512/stt) (GPL-3.0) was
studied as a **reference only** while designing the local STT/dubbing concept. **No
GPL-licensed code was copied**; VideoDubber is original work and does not depend on that
project at run time. Full statement in [`NOTICE.md`](NOTICE.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#why-jianchang512stt-is-reference-only).

---

## License

MIT — see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
