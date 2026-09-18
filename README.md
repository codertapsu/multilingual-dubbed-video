# VideoDubber

**Dub any video into another language — locally, offline, and for free.**

VideoDubber is a local/offline-first desktop app that transcribes a video, translates
the transcript, re-voices it with text-to-speech, time-aligns the new audio to the
original timing, mixes it back over the (optionally ducked) background, and renders a
finished dubbed video — with optional soft, burned-in, or sidecar subtitles.

Everything runs on your machine by default. No cloud account, no API keys, no
per-minute billing. Cloud providers are **opt-in**, per phase and per key, never a
requirement.

---

## Download & install (desktop app)

**Just want to use VideoDubber?** Head to the
[**Releases**](https://github.com/codertapsu/multilingual-dubbed-video/releases) page and
grab the installer for your machine — no Python, Node, or FFmpeg required. Each build is
**fully self-contained**: it bundles the app, the pipeline engine, all three AI
workers, and FFmpeg.

> 📖 **New here? Read [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)** — install, first
> launch, your first dub, where files live, updating, uninstalling. No terminal
> required. The rest of this README is about **developing from source**.

| Your machine | File to download | First launch |
|---|---|---|
| **Mac — Apple Silicon** (M1/M2/M3/M4) | `VideoDubber_<ver>_aarch64.dmg` | Double-click to open (signed + notarized). |
| **Windows 10/11 (64-bit)** | `VideoDubber_<ver>_x64-setup.exe` | Unsigned → SmartScreen shows "Windows protected your PC". Click **More info** (a link, above the button), then **Run anyway**. |

> **Which Mac do I have?**  → **About This Mac**: "Apple M…" = Apple Silicon, "Intel" = Intel.

The other assets on a release are **not** installers — `…_aarch64.app.tar.gz`,
`…_x64_en-US.msi`, the `.sig` files and `latest.json` exist for the in-app updater
and for IT-managed Windows deployment. Downloading the `.app.tar.gz` by hand leaves
a loose app in your Downloads folder that can never update itself. See
[the user guide](docs/USER_GUIDE.md#files-you-should-ignore).

**Intel macOS and Linux are not built today.** `bundle.targets` produces
`app`/`dmg`/`nsis`/`msi` only, the macOS release script is arm64-only, and no
release has ever carried an `_x64.dmg`, a `.deb` or an `.AppImage`. On those
machines, build from source — see [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md).

### macOS first launch

The macOS builds are **signed with an Apple Developer ID and notarized by Apple**,
so VideoDubber opens with a normal **double-click** — no security prompt, no
Terminal, no right-click:

1. Open the `.dmg` and drag **VideoDubber** into your **Applications** folder.
2. Open **VideoDubber** from Applications. That's it.

> Building an unsigned fork (no Apple signing secrets configured)? macOS will
> quarantine it; the one-time unlock and the full signing/notarization setup are
> documented in [`docs/APPLE_SIGNING.md`](docs/APPLE_SIGNING.md).

### Windows first launch

The Windows installers are **not code-signed** — there is no Authenticode
certificate for this project — so every Windows user sees SmartScreen's
"Unknown publisher" panel on a hand-downloaded installer, exactly once per
version. Updates the app installs for itself do not show it again. Antivirus
false positives are also possible; what to exclude is in
[the user guide](docs/USER_GUIDE.md#antivirus-removed-something).

**First launch** runs a one-time wizard that downloads the AI **models** for the
languages you choose (the only thing not in the installer); after that the app works
fully **offline**.

**Updating is automatic.** Since v0.2.0 VideoDubber checks GitHub Releases for a
newer version, verifies the update's signature on-device, and installs it in place.
Turn it off, or check manually, in **Settings → Updates**.

> Bundle internals: [`docs/PRODUCTION.md`](docs/PRODUCTION.md) · auto-update design:
> [`docs/AUTOUPDATE.md`](docs/AUTOUPDATE.md).

**Cutting a release locally?** Releases are built on the maintainer's own Mac +
Windows (CI is opt-in per OS). The short version, **the same on both machines**:

```bash
pnpm release:check      # preflight only — nothing is built or uploaded
pnpm release            # cut this OS's release end to end
```

`pnpm release` is a thin front door that reimplements nothing: on macOS it delegates to
`release-macos.sh` (build → deep-sign → notarize → staple → updater archive → upload),
on Windows to `release-windows.ps1`. Add `--sidecars --upload` (macOS) or
`-Sidecars -Upload` (Windows) to rebuild the bundled sidecars and publish. Both
machines upload to the **same** draft release, and `latest.json` is merged so the
updater sees both platforms.

Run `pnpm release:check` first, always — it answers "could I cut a release right now?"
in seconds without building anything, which on macOS saves discovering a missing
`APPLE_TEAM_ID` after a 20-minute build and a trip to Apple's notary service.

Full runbook (per-OS steps, signing, opt-in CI): [`docs/RELEASING.md`](docs/RELEASING.md);
macOS deep-sign rationale + troubleshooting: [`docs/APPLE_SIGNING.md`](docs/APPLE_SIGNING.md).
The rest of this README covers **developing from source**.

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
- **Cloud is optional.** Per-step, key-gated cloud providers (OpenAI / Anthropic /
  Gemini) can be opted into where quality matters, but the default is always local.
  See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

---

## Features

- 9-step dubbing pipeline: **probe → extract-audio → STT → translation → refine →
  TTS → alignment → audio-mix → render** (`refine` is an optional AI review pass
  that no-ops when unconfigured).
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
- **Download a source video** from **Bilibili** or **Douyin** and dub it, with a
  quality target and an optional per-source session cookie — see
  [the user guide](docs/USER_GUIDE.md#5-downloading-a-source-video).
- **Optional engine packs** (Settings → Engines): GPU-accelerated whisper.cpp,
  local-LLM translation via llama.cpp, neural Vietnamese TTS. Downloaded on demand,
  run only while a project uses them, hardware-gated so an unrunnable pack is never
  offered. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md#engine-packs).
- **Opt-in cloud providers** (OpenAI / Anthropic / Gemini) per phase, per key.
- **Run queue**: dub several videos at once, bounded by what the machine can take —
  see [`docs/RUN_QUEUE.md`](docs/RUN_QUEUE.md).
- **English + Vietnamese UI** (Settings → Language), switchable at runtime.
- **Dual mode**: run the Angular UI in a plain browser (no Rust needed), or build the
  full **Tauri 2** native desktop app.
- **Signed in-app auto-update** (Settings → Updates) — [`docs/AUTOUPDATE.md`](docs/AUTOUPDATE.md).
- Live progress over **Server-Sent Events (SSE)**.

---

## Architecture at a glance

```
                          ┌──────────────────────────────────────────┐
                          │  videodubber-desktop                       │
                          │  Angular 22 UI  ──(SSE + HTTP)──┐           │
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
- **`videodubber-desktop`** — Angular 22 standalone UI inside a Tauri 2 shell.

Full details, the 9-step flow, and the data model are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## System requirements

| Requirement | Version / notes |
|---|---|
| **OS** | macOS 14.0+ (Apple Silicon), Windows 10/11, or a modern Linux. Only macOS arm64 and Windows x64 get released installers; Linux and Intel macOS are build-from-source. (Validated end-to-end on macOS arm64.) |
| **Node.js** | **≥ 22.12**; **use Node 24 LTS** — what releases are built with. Angular 22's CLI refuses anything below 22.22.3, and Node 20 went end-of-life 2026-04-30. |
| **pnpm** | **11.9.0**, pinned in `package.json` `packageManager`. Enable with `corepack enable && corepack prepare pnpm@11.9.0 --activate`. |
| **Python** | **3.12** — the version `UV_PYTHON_VERSION` gives every engine-pack venv and the version of the interpreter the installer bundles, so matching it keeps dependency resolution identical to a release. Other 3.11–3.13 interpreters run, but metadata is marker-sensitive across that boundary (libretranslate resolves a different numpy on 3.13). ⚠️ **Avoid 3.14** — some ML wheels aren't published yet, forcing slow/failing source builds. On macOS: `brew install python@3.12`. The project uses a **per-project** interpreter (a `.venv` or `PYTHON_PATH`), so your system `python3` version doesn't matter — see [switching Python](docs/LOCAL_SETUP.md#choosing-the-python-version). |
| **FFmpeg + ffprobe** | Required at run time for probe / extract / mix / render. Install per OS — see [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md#3-ffmpeg--ffprobe). **For burned-in subtitles** you need an FFmpeg built **with libass** (the `subtitles` filter). macOS Homebrew's default `ffmpeg` omits it — use `brew install ffmpeg-full` and set `FFMPEG_PATH`/`FFPROBE_PATH`. The other subtitle modes (soft / sidecar) work with any FFmpeg. |
| **Disk** | ~1–2 GB for Node deps + Python venvs + models (a small/base Whisper model, one Argos pair, one Piper voice). |
| **Rust (optional)** | Only needed to build/run the **native Tauri desktop app** (`pnpm app`). Install via [rustup](https://rustup.rs). The browser dev mode does **not** need Rust. |

Local models (downloaded by the setup script): a faster-whisper model (default
`small`; `base` is a fast CPU choice), Argos language package(s) (default `en → vi`;
non-English pairs like `zh → vi` pivot through English and need both legs), and
optionally a Piper voice for high-quality TTS. The packaged app downloads these on
first run (small installer). A build can instead **bundle** the default-pair
(`en → vi` / `zh → vi`) models for an offline out-of-box first dub with
`BUNDLE_DEFAULT_MODELS=1` (adds ~1 GB) — the pairs live in
[`defaultBundle.ts`](packages/node-orchestrator/src/setup/defaultBundle.ts). See
[`docs/MODEL_SETUP.md`](docs/MODEL_SETUP.md).

---

## Quick start

**Two commands, the same two on every OS** — macOS, Linux and Windows:

```bash
corepack enable         # (once) gives you the pnpm version this repo pins

pnpm bootstrap          # set everything up
pnpm dev                # run everything
```

Then open **http://localhost:1420** in your browser, pick a video, choose source/target
languages, and run the pipeline. `Ctrl-C` stops the whole stack.

### What `pnpm bootstrap` does

Five phases, printed as numbered banners so you can see where you are:

1. **Prerequisites** — Node, pnpm, Python, FFmpeg, and Rust if you want the native
   window. Anything missing is reported with the **exact install command for your OS**,
   and bootstrap stops there: it never installs system software, runs `sudo`, or edits
   your PATH on your behalf.
2. **Workspace dependencies** — `pnpm install`.
3. **Build the workspace libraries** — `pnpm build`, because `@videodubber/shared` and
   `@videodubber/media-worker` are consumed through `exports` that point at `dist/`.
4. **Python workers + models** — a `.venv` per worker with its `requirements.txt`, a
   pre-cached faster-whisper model, an Argos language pair, and a Piper voice, built
   with a **resolved Python 3.12** rather than whatever `python3` happens to be. Uses
   the network, but never fails hard offline; it prints the manual steps instead.
5. **Verify** — the environment doctor, so you end on an OK/WARN/MISSING table rather
   than a surprise three commands later.

It is safe to re-run at any time, and a re-run skips what is already in place.
Flags go straight after the task name, with **no `--` separator** (pnpm 11 forwards a
literal `--` and the script rejects it): `--skip-deps`, `--skip-build`, `--skip-python`,
`--skip-models`, `--strict`, `--help`. On Windows: `-SkipDeps`, `-SkipBuild`,
`-SkipPython`, `-SkipModels`, `-Strict`. Each also works as an env var
(`SKIP_MODELS=1`, …).

### Doing it by hand

```bash
corepack enable && corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm build
node scripts/run.mjs setup-local-models    # the .sh / .ps1 pair, dispatched per OS
pnpm doctor                                # = scripts/verify-environment.ts
```

`setup-local-models` is individually skippable — `SKIP_VENVS=1`, `SKIP_MODELS=1`,
`SKIP_WHISPER=1`, `SKIP_ARGOS=1`, `SKIP_PIPER=1` — and tunable with `PYTHON_PATH`,
`FASTER_WHISPER_MODEL`, `ARGOS_FROM`/`ARGOS_TO`, `PIPER_VOICE` and
`VIDEODUBBER_DEV_HOME`. See [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md).

### Other ways to run it

```bash
pnpm start        # the whole stack, detached — your terminal returns
pnpm stop         # stop it (port-based; works however it was started)
```

> Prefer a **native desktop window**? Run `pnpm app` (needs Rust) — it opens the app and
> **auto-starts/stops all backend services for you**. See
> [Running the app](#running-the-app) below.

> First run is slower if models still need to download. Re-runs are fully offline.

---

## Running the app

VideoDubber's UI is plain Angular 22 talking to the orchestrator over HTTP/SSE, so you
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
[`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md) for running the shell from source.

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
- **Every one of these works on Windows too.** Each task ships as a `.sh` + `.ps1` pair
  and `scripts/run.mjs` dispatches to the right half, so `pnpm dev` / `pnpm start` /
  `pnpm stop` are the commands on every OS — no separate `pwsh scripts/…` invocation.
- Put machine-specific paths in a `.env` (copy from `.env.example`) — `FFMPEG_PATH`,
  `PYTHON_PATH`, `PIPER_*`, ports, etc. The start scripts load it automatically.

> Building a release **installer** (`pnpm app:build`) needs the sidecars staged first
> (`pnpm package:sidecars` — the Node orchestrator, the three Python workers, `vd-piper`,
> `vd-uv`, a bundled CPython and a libass FFmpeg). Full runbook:
> [`docs/RELEASING.md`](docs/RELEASING.md); the developer-facing summary is in
> [`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md).

---

## Dev command reference

**Every command below runs on macOS, Linux and Windows.** The task scripts ship as
`.sh` + `.ps1` pairs and `scripts/run.mjs` picks the right one, forwarding your
arguments, the exit code and Ctrl-C.

| Command | What it does |
|---|---|
| `pnpm bootstrap` | **Start here.** Prerequisite check → `pnpm install` → `pnpm build` → Python venvs + models → doctor. Idempotent. |
| `pnpm doctor` | Run `scripts/verify-environment.ts`: Node/pnpm/Python/ffmpeg/workers/models, with a fix hint per row. (`pnpm verify` is the same script.) |
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
| `pnpm test` | TypeScript unit tests (shared utils, media-worker, orchestrator, desktop i18n check). |
| `pnpm test:workers` | The **Python** pytest suites — which `pnpm test` cannot reach, because the workers are not pnpm packages. |
| `pnpm test:all` | `pnpm test` + `pnpm test:workers`. |
| `pnpm check` | `lint` → `typecheck` → `test:all` → version-consistency check → shell-twin check. The full gate. |
| `pnpm lint` | ESLint over the TypeScript sources. |
| `pnpm package:sidecars` | Stage everything an installer bundles (orchestrator SEA, frozen workers, ffmpeg, uv + CPython). |
| `pnpm release` / `pnpm release:check` | Cut this OS's release, or run only its preflight (builds nothing, takes seconds). See [`docs/RELEASING.md`](docs/RELEASING.md). |
| `pnpm desktop:rebuild` | Fully clean rebuild of the desktop app (keeps node_modules, cargo cache and venvs; `DEEP=1` wipes the venvs too). |

> Environment overrides for `pnpm dev` on macOS/Linux: `SKIP_WORKERS=1`, `SKIP_UI=1`,
> `SKIP_LIB_WATCH=1`. On Windows use the switches on `scripts\dev.ps1` instead —
> `-SkipWorkers` / `-SkipUi` / `-SkipLibWatch` (only `-SkipLibWatch` also honors its
> env var). For
> `setup-local-models`: `SKIP_VENVS=1`, `SKIP_MODELS=1`, `SKIP_WHISPER=1`,
> `SKIP_ARGOS=1`, `SKIP_PIPER=1`, plus `FASTER_WHISPER_MODEL`, `ARGOS_FROM`/`ARGOS_TO`,
> `PIPER_VOICE`.

New to the codebase? [`CONTRIBUTING.md`](CONTRIBUTING.md) has the full task reference,
the repo layout, the house conventions, and the gotchas that actually bite.

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

Optional cloud keys — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — are used **only** when you select a cloud
provider for a phase, and are never required. They can also be entered in the app
(**Settings → Cloud API keys**), which stores them in `<config>/credentials.json`
with owner-only permissions. `.env.example` additionally lists `DEEPL_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_SPEECH_*` and `ELEVENLABS_API_KEY`: those
belong to **deliberately unimplemented** placeholder backends in the translation
worker and setting them does nothing. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

---

## Documentation

**For users** — you need none of the rest of this README.

| Doc | Contents |
|---|---|
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | **Start here.** Which file to download, first launch on each OS, the setup wizard, dubbing a video, the downloader, Settings, where files live, updating, uninstalling. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Every error code, plus common failures — split into "using the app" and "developing". |
| [`docs/VIENEU_TTS_SETUP.md`](docs/VIENEU_TTS_SETUP.md) | The optional neural Vietnamese voice (VieNeu v3): install it and use it. |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | Every engine you can pick per phase — local defaults, engine packs, optional cloud adapters + what data they send. |
| [`docs/MODEL_SETUP.md`](docs/MODEL_SETUP.md) | Whisper / Argos / Piper models: download, storage, troubleshooting. |

**For contributors** — building and running from source.

| Doc | Contents |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | **Start here if you are new.** `pnpm bootstrap`, the full task reference, repo layout, how to run every test suite, house conventions, and how to propose a change. |
| [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) | Node/pnpm/Python/FFmpeg/Rust setup; running, starting & stopping each service. |
| [`docs/WINDOWS.md`](docs/WINDOWS.md) | The complete Windows onboarding + build + release guide (the canonical toolchain versions). |
| [`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md) | Running the Tauri desktop shell **from source** and how it auto-starts/stops the backend. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, pipeline flow, data model, workspace layout, HTTP API, Tauri commands, SSE model, service lifecycle. |
| [`docs/RUN_QUEUE.md`](docs/RUN_QUEUE.md) | How simultaneous dubs are admitted, bounded and sequenced. |
| [`docs/DUBBING_QUALITY.md`](docs/DUBBING_QUALITY.md) | Why dubs sound the way they do, and the ranked plan to improve them. |
| [`docs/ENGINE_PACKS.md`](docs/ENGINE_PACKS.md) | Maintainer runbook for the engine-pack catalog: pins, checksums, re-pinning a dead URL. |

**For maintainers** — packaging, signing, shipping.

| Doc | Contents |
|---|---|
| [`docs/RELEASING.md`](docs/RELEASING.md) | Release runbook: cut a release **locally** (`pnpm package:sidecars` + `pnpm app:build` → `release-upload.{sh,ps1}`); macOS deep-sign + notarize via `release-macos.sh`; updater keys; opt-in per-OS CI. |
| [`docs/APPLE_SIGNING.md`](docs/APPLE_SIGNING.md) | Developer ID signing + notarization: why a deep-sign pass is mandatory, and how to debug it. |
| [`docs/AUTOUPDATE.md`](docs/AUTOUPDATE.md) | How auto-update works (endpoint, pubkey, signature verification), the auto/manual setting, manual checks, rollback. |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) | The self-contained installer: what's bundled vs. downloaded on first run, prod sidecar lifecycle, storage & sizes. |

**Research & decisions**

| Doc | Contents |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What has shipped, and what is genuinely still planned. |
| [`docs/TECH_STACK_RESEARCH.md`](docs/TECH_STACK_RESEARCH.md) | The on-device AI landscape survey the engine-pack system came out of. |
| [`docs/TRANSLATION_EVAL.md`](docs/TRANSLATION_EVAL.md) | What is and isn't known about translation quality for our pairs. |
| [`docs/OMNIVOICE.md`](docs/OMNIVOICE.md) | The OmniVoice TTS pack: why it is on hold and the re-enable checklist. |
| [`docs/RELEASE_NOTES_v0.1.0.md`](docs/RELEASE_NOTES_v0.1.0.md) | The first release's notes, kept for reference. |

An index with the same grouping lives at [`docs/README.md`](docs/README.md).

---

## Known limitations

- TTS quality depends on the chosen Piper voice; without a Piper binary/voice the worker
  falls back to system TTS or a silent/sine placeholder.
- No speaker diarization — all segments use a single voice unless you assign one per
  segment in the editor. The `alignment-whisperx` pack that would provide it is an
  **unimplemented stub** and is hidden from Settings → Engines rather than shipped
  broken.
- No source separation (music/voice); ducking is a volume reduction, not stem
  isolation. The `separation-audio` pack is likewise an unimplemented stub.
- **Windows installers are unsigned, by choice.** No Authenticode certificate is
  provisioned and none is planned, so every hand-downloaded install and update shows
  SmartScreen's "Unknown publisher" panel ([what to click](#windows-first-launch));
  managed Windows images that block unsigned installers outright cannot install
  VideoDubber at all. In-app auto-updates are unaffected — those carry the updater's
  own signature. Rationale: [`docs/RELEASING.md`](docs/RELEASING.md#windows-code-signing--deliberately-not-configured).
- **Intel macOS and Linux get no installers.** See the download section.
- **macOS below 26 cannot run any *published* release (≤ 0.9.0)**: the frozen Python
  workers in those builds were compiled against the macOS 26 SDK although the app
  declared 13.5. `build-workers.{sh,ps1}` now freeze from the bundled portable
  CPython instead, which fixes it — but **no published release carries that fix yet**.
  The next release requires **macOS 14.0+**: numpy/onnxruntime/av publish no arm64
  wheels below `macosx_14_0`, so 14.0 is the real floor and the app now declares it.
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
