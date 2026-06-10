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

## Prerequisites

| Requirement | Version / notes |
|---|---|
| **Node.js** | 20.11+ (LTS). Provides global `fetch` and ES2022. |
| **pnpm** | 9.x. Enable via `corepack enable` or `npm i -g pnpm`. |
| **Python** | **3.11–3.12 recommended.** 3.10 works. ⚠️ **Avoid 3.14** for now — some ML wheels (faster-whisper / ctranslate2, numpy) may not yet publish prebuilt wheels, forcing slow/failing source builds. |
| **FFmpeg + ffprobe** | Required at run time for probe / extract / render. Install per OS — see [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md). |
| **Rust (optional)** | Only needed to build/run the **full Tauri desktop app**. Install via [rustup](https://rustup.rs). The browser dev mode does **not** need Rust. |

Local models (downloaded by the setup script): a faster-whisper model (default
`small`), an Argos language package (default `en → vi`), and optionally a Piper voice.
See [`docs/MODEL_SETUP.md`](docs/MODEL_SETUP.md).

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

# 4a. Run EVERYTHING with one command (workers + orchestrator + Angular UI):
pnpm dev

# 4b. ...or run pieces individually in separate terminals:
pnpm dev:workers        # STT 5101, Translation 5102, TTS 5103
pnpm dev:orchestrator   # Node orchestrator on 5100
pnpm dev:desktop        # Angular UI on http://localhost:1420
```

Then open **http://localhost:1420** in your browser, pick a video, choose source/target
languages, and run the pipeline.

> First run is slower if models still need to download. Re-runs are fully offline.

---

## Dual mode: browser vs. native desktop

VideoDubber's UI is plain Angular 18 that talks to the orchestrator over HTTP/SSE. That
means you have two ways to run it:

### 1. Browser dev mode (no Rust required) — recommended for development

```bash
pnpm dev          # or: pnpm dev:desktop  (UI only)
```

`ng serve` hosts the UI on **http://localhost:1420**. The UI calls the orchestrator at
`http://127.0.0.1:5100` directly and subscribes to SSE for progress. Native-only
conveniences (file-picker dialog, "open output folder") degrade gracefully when not
running inside Tauri. **No Rust toolchain needed.**

### 2. Full Tauri desktop app (needs Rust)

```bash
# In one terminal, start the backend services:
SKIP_UI=1 pnpm dev          # workers + orchestrator only

# In another, launch the native shell (loads the Angular dev server on :1420):
pnpm --filter videodubber-desktop tauri dev
```

Tauri 2 wraps the same Angular UI in a native window and adds real native commands
(`pick_video_file`, `open_path`, etc.) that proxy to the orchestrator via `reqwest`.
Progress SSE goes **directly** from the webview to the orchestrator (not forwarded
through Rust). Building a release bundle additionally requires app icons — see the
`pnpm tauri icon` note in [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md).

---

## Dev command reference

| Command | What it does |
|---|---|
| `pnpm install` | Install all TS/Node workspace dependencies. |
| `bash scripts/setup-local-models.sh` | Create Python venvs + install worker deps + download models. (`.ps1` on Windows.) |
| `pnpm verify` | Run `scripts/verify-environment.ts`: checks Node/pnpm/Python/ffmpeg/workers/models. |
| `pnpm dev` | Start the **full** stack (3 workers + orchestrator + Angular UI). |
| `pnpm dev:workers` | Start only the 3 Python workers (5101/5102/5103). |
| `pnpm dev:orchestrator` | Start only the Node orchestrator (5100). |
| `pnpm dev:desktop` | Start only the Angular UI (`ng serve`, port 1420). |
| `pnpm build` | Build the TS packages + media-worker. |
| `pnpm typecheck` | Type-check every workspace package. |
| `pnpm test` | Run unit tests (shared utils, orchestrator). |
| `pnpm lint` | ESLint over the TypeScript sources. |
| `pnpm --filter videodubber-desktop tauri dev` | Launch the native Tauri desktop shell (needs Rust). |

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
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, pipeline flow, data model, workspace layout, HTTP API, Tauri commands, SSE model. |
| [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) | Node/pnpm/Python/FFmpeg/Rust setup; running each service. |
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
