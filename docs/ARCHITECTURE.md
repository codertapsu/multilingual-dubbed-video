# Architecture

This document describes how VideoDubber is put together: the components, the 8-step
pipeline (with inputs/outputs/artifacts), the provider architecture, the shared data
model, the per-project workspace layout, the orchestrator HTTP API, the Tauri command
mapping, and the SSE event model. It closes with why `jianchang512/stt` is
reference-only.

---

## 1. Component diagram

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ videodubber-desktop  (apps/desktop)                                           │
 │                                                                               │
 │   Angular 18 standalone UI                                                    │
 │     • HTTP calls + EventSource(SSE) ───────────────────────────┐              │
 │                                                                │              │
 │   Tauri 2 shell (src-tauri, Rust)  [optional native mode]      │              │
 │     • commands proxy to orchestrator via reqwest               │              │
 │     • native dialog (pick file) + opener (open path)           │              │
 │     • SSE is NOT proxied through Rust (webview talks direct)   │              │
 └────────────────────────────────────────────────────────────────┼────────────┘
                                                                    │ HTTP + SSE
                                                                    ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ @videodubber/node-orchestrator   (packages/node-orchestrator)   PORT 5100     │
 │                                                                               │
 │   • Fastify HTTP server (CORS open to localhost)                              │
 │   • Resumable 8-step pipeline runner (skip-if-artifact-exists)                │
 │   • Provider registry (STT / Translation / TTS)                               │
 │   • Project workspace store (project.json, pipeline.json, artifacts)          │
 │   • Alignment + audio-mix orchestration                                       │
 │   • SSE event bus (/projects/:id/events)                                      │
 └──┬───────────────┬──────────────────┬──────────────────┬─────────────────────┘
    │ in-process    │ HTTP             │ HTTP             │ HTTP
    ▼               ▼                  ▼                  ▼
 ┌────────────┐  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
 │ media-     │  │ stt-worker     │ │ translation-   │ │ tts-worker     │
 │ worker     │  │ FastAPI :5101  │ │ worker         │ │ FastAPI :5103  │
 │ (Node TS)  │  │ faster-whisper │ │ FastAPI :5102  │ │ Piper / system │
 │ FFmpeg +   │  │                │ │ Argos Translate│ │ / fallback     │
 │ ffprobe    │  └────────────────┘ └────────────────┘ └────────────────┘
 │ MediaService│
 └────────────┘
        │ argv-array spawn
        ▼
   ffmpeg / ffprobe   (external binaries; never shell-concatenated)
```

### Packages and dependencies

| Package | Role | Depends on |
|---|---|---|
| `@videodubber/shared` | TS types + subtitle/language/pipeline utils + error model | (none) |
| `@videodubber/media-worker` | FFmpeg/ffprobe wrapper, `MediaService` impl | `@videodubber/shared` |
| `@videodubber/node-orchestrator` | HTTP engine, pipeline, providers, workspace, SSE | `@videodubber/shared`, `@videodubber/media-worker` |
| `videodubber-desktop` | Angular 18 UI + Tauri 2 shell | `@videodubber/shared` (types only) |
| `workers/stt-worker` | Python FastAPI + faster-whisper | (Python venv) |
| `workers/translation-worker` | Python FastAPI + Argos Translate | (Python venv) |
| `workers/tts-worker` | Python FastAPI + Piper/system/fallback | (Python venv) |

The Python workers are **not** pnpm packages; they have their own venvs +
`requirements.txt`.

---

## 2. Pipeline flow (the 8 steps)

The orchestrator runs an ordered list of steps. Each step reads upstream artifacts and
writes its own, so a step is **skipped** if its expected output already exists and
upstream did not change. Retrying a step resets it and everything downstream.

`PipelineStepId` order: `probe-video → extract-audio → stt → translation → tts →
alignment → audio-mix → render`.

| # | Step | Input | Engine / service | Output artifact(s) |
|---|---|---|---|---|
| 1 | `probe-video` | `input/original.<ext>` | media-worker → `ffprobe` | `MediaInfo` persisted on project / `project.json` |
| 2 | `extract-audio` | original video | media-worker → `ffmpeg` | `audio/original.wav`, `audio/original_16k_mono.wav` |
| 3 | `stt` | `original_16k_mono.wav` | STT worker (faster-whisper) | `subtitles/source.json`, `subtitles/source.srt` |
| 4 | `translation` | source segments | Translation worker (Argos) | `subtitles/translated.json`, `translated.srt`, `translated.vtt` |
| 5 | `tts` | translated segments | TTS worker (Piper/system/fallback) | `audio/tts_segments/segment_0001.wav…` |
| 6 | `alignment` | TTS segments + source timing | orchestrator (`alignment/align.ts`) | `subtitles/translated.aligned.json`, `audio/tts_full.wav` |
| 7 | `audio-mix` | TTS full + original audio | media-worker → `ffmpeg` | `audio/final_mix.wav` |
| 8 | `render` | original video + final mix + subtitles | media-worker → `ffmpeg` | `render/output.mp4` + sidecar subtitle files |

### Step detail

- **probe-video** — Reads container, duration, video/audio streams. Fails with
  `UNSUPPORTED_MEDIA` if unreadable. Persisted so later steps and the UI can use it.
- **extract-audio** — Produces a full-quality WAV and a 16 kHz mono WAV (the format
  faster-whisper prefers). Fails with `NO_AUDIO_STREAM` if the input has no audio.
- **stt** — Transcribes the 16 kHz mono WAV into `TranscriptSegment[]` with word
  timestamps and per-segment confidence; reports detected language. Source language is
  reduced to the whisper base subtag (`toWhisperLanguage`).
- **translation** — Translates each segment independently (preserving ids/order), with
  optional glossary pre/post replacement. Languages reduced via `toArgosLanguage`.
  Missing pair → `TRANSLATION_PACKAGE_MISSING`.
- **tts** — Synthesizes one WAV per segment, named by the numeric part of the id
  (`segment_0001.wav`). Engines tried in priority: Piper → system TTS → silent/sine
  fallback. Durations are measured from the real WAV headers.
- **alignment** — Computes, per segment, a `speedRatio` to fit the generated audio into
  its time window, bounded by `maxSpeedRatio`/`allowedOverflowMs`. Marks each
  `AlignedSegment` `ok` / `needs-review` / `timing-conflict`, then assembles the placed
  segments into a continuous `tts_full.wav`.
- **audio-mix** — Mixes the aligned TTS over the original background according to
  `includeOriginalBackgroundAudio`, `duckOriginalAudio`, `duckingLevelDb`, `ttsGainDb`.
- **render** — Muxes video + `final_mix.wav` into the output, applying the chosen
  `subtitleExportMode` (sidecar / embedded-soft / burned-in with `burnSubtitleStyle`).
  Subtitle paths used in the FFmpeg `subtitles=` filter are validated/escaped; FFmpeg is
  always invoked with an argv array, never a concatenated shell string.

---

## 3. Provider architecture

Providers are pluggable implementations of three interfaces, all defined in
`@videodubber/shared`. The orchestrator's provider registry
(`src/providers/registry.ts`) selects an implementation by id from `ProjectSettings`
(`sttProviderId`, `translationProviderId`, `ttsProviderId`).

```ts
interface SttProvider         { id; displayName; isLocal; transcribe(input): Promise<SttResult>; }
interface TranslationProvider { id; displayName; isLocal; translateSegments(input): Promise<TranslationResult>; }
interface TtsProvider         { id; displayName; isLocal; synthesizeSegments(input): Promise<TtsResult>; }
```

### Local defaults (always available)

| Capability | Provider | Implementation | Talks to |
|---|---|---|---|
| STT | `faster-whisper` | `providers/stt/fasterWhisperProvider.ts` | STT worker `:5101` |
| Translation | `argos` | `providers/translation/argosProvider.ts` | Translation worker `:5102` |
| TTS | `local` (Piper/system/fallback) | `providers/tts/localTtsProvider.ts` | TTS worker `:5103` |

Each local provider is a thin HTTP client (`providers/workerHttp.ts`) over its Python
worker.

### Cloud adapters (optional, placeholder)

`providers/cloudPlaceholders.ts` holds **scaffolded, non-functional** cloud adapters
with clear `TODO`s and the env var each would read. They are not wired into the default
pipeline. The default `processingMode` is `local`; `cloud-enhanced` is reserved for
future opt-in use. See [`PROVIDERS.md`](PROVIDERS.md) for the full table, the data each
cloud provider would send, and cost-first guidance.

---

## 4. Shared data model

All TypeScript components import these from `@videodubber/shared`. Key types:

- **Settings & project**
  - `ProjectSettings` — languages, subtitle export mode, processing mode, provider ids,
    voice/model selection, audio mixing knobs (`duckingLevelDb`, `ttsGainDb`),
    alignment limits (`maxSpeedRatio`, `allowedOverflowMs`), optional `burnSubtitleStyle`.
  - `Project` — id, name, input path, `workspaceDir`, `outputDir`, `settings`, `status`
    (`created|running|paused|failed|completed`), timestamps, optional `mediaInfo`.
  - `SubtitleStyle`, `SubtitleExportMode`, `ProcessingMode`.
- **Media**
  - `MediaInfo`, `VideoStreamInfo`, `AudioStreamInfo`, `AudioExtractResult`.
  - `RenderFinalVideoInput` / `RenderFinalVideoResult`.
  - `MediaService` interface (`probe`, `extractAudio`, `renderFinalVideo`).
- **Transcript / synthesis / alignment**
  - `TranscriptSegment` (+ `TranscriptWord`) with `sourceText`/`translatedText`.
  - `TtsSegment` — synthesized audio path, duration, window, `speedRatio`.
  - `AlignedSegment` + `AlignmentStatus` (`ok | needs-review | timing-conflict`).
- **Worker I/O**
  - `SttInput`/`SttResult`, `TranslationInput`/`TranslationResult`,
    `TtsInput`/`TtsResult` and their segment sub-types.
- **Pipeline state**
  - `PipelineStepState`, `PipelineState`, `PipelineStepId`.
  - Utilities: `PIPELINE_STEP_DEFS`, `createInitialPipelineState`, `setStepStatus`
    (pure; recomputes `progressPercent`, `currentStep`, and rolls up overall `status`).
- **Orchestration**
  - `CreateProjectInput`, `JobOrchestrator` interface.
- **Errors**
  - `ErrorCode`, `AppError`, `AppErrorException`, `toAppError(unknown)`.
- **Subtitle utilities** — `toSrtTimestamp`, `toVttTimestamp`, `splitSubtitleLines`
  (≤2 lines, ~42 chars/line target for Vietnamese), `segmentsToSrt`, `segmentsToVtt`,
  `SubtitleCue` + adapters from `TranscriptSegment` (uses `translatedText` if present).
- **Language utilities** — `normalizeLanguageCode` (case/locale fix, `vi-VI → vi-VN`),
  `toWhisperLanguage` (base subtag), `toArgosLanguage` (base subtag). The Python workers
  apply the same base-subtag reduction and the `vi-VI → vi-VN` rule.

> All timestamps are integer **milliseconds** internally. Subtitle formatters convert to
> `HH:MM:SS,mmm` (SRT) / `HH:MM:SS.mmm` (VTT) at the edge.

### Error model

Workers return failures as JSON with an appropriate HTTP status:

```json
{ "error": { "code": "TRANSLATION_PACKAGE_MISSING", "message": "...", "remediation": "...", "docsRef": "TROUBLESHOOTING.md#..." } }
```

`toAppError` normalizes any thrown value into an `AppError`; `AppErrorException` carries
a structured `AppError`. `docsRef` values point at anchors in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

---

## 5. Project workspace layout

The orchestrator creates one folder per project under `VIDEODUBBER_PROJECTS_DIR`
(default `~/VideoDubber/projects`):

```
<projectsDir>/<project-id>/
├── project.json                     # Project (settings, status, mediaInfo)
├── pipeline.json                    # persisted PipelineState (for resume)
├── input/
│   └── original.<ext>               # the source video (copied in)
├── audio/
│   ├── original.wav                 # full-quality extracted audio
│   ├── original_16k_mono.wav        # 16 kHz mono for STT
│   ├── tts_segments/
│   │   ├── segment_0001.wav
│   │   └── segment_0002.wav ...
│   ├── tts_full.wav                 # aligned/assembled TTS track
│   └── final_mix.wav                # TTS mixed over (ducked) background
├── subtitles/
│   ├── source.json                  # STT TranscriptSegment[]
│   ├── source.srt
│   ├── translated.json              # segments with translatedText
│   ├── translated.srt
│   ├── translated.vtt
│   └── translated.aligned.json      # AlignedSegment[]
├── render/
│   └── output.mp4
└── logs/
    └── pipeline.log
```

**Resumability:** a step is skipped if its expected output artifact already exists and
upstream is unchanged. `retry_pipeline_step` resets the target step and all downstream
steps, then re-runs from there.

---

## 6. Orchestrator HTTP API (port 5100)

JSON over HTTP, CORS open to localhost. Each endpoint maps 1:1 to a Tauri command.

| Method | Path | Command | Body → Response |
|---|---|---|---|
| GET | `/health` | — | → `{ status:"ok" }` |
| GET | `/workers/health` | — | → `{ stt, translation, tts, ffmpeg, ffprobe : { available, detail? } }` |
| GET | `/languages` | — | → translation worker languages + curated `COMMON_LANGUAGES` |
| POST | `/projects` | `create_project` | `CreateProjectInput` → `Project` |
| GET | `/projects` | `list_projects` | → `Project[]` |
| GET | `/projects/:id` | `get_project` / `open_project` | → `{ project, pipeline }` |
| POST | `/projects/:id/probe` | `probe_video` | → `MediaInfo` (persisted) |
| POST | `/projects/:id/run` | `run_pipeline` | → `202 { started:true }` (async, resumable) |
| POST | `/projects/:id/cancel` | `cancel_pipeline` | → `{ ok:true }` |
| POST | `/projects/:id/retry` | `retry_pipeline_step` | `{ stepId }` → `202` (reset step + downstream) |
| GET | `/projects/:id/segments` | — | → `TranscriptSegment[]` (merged w/ alignment status) |
| PUT | `/projects/:id/segments` | `save_translated_segments` | `{ segments:[{id, translatedText}] }` → `{ ok:true }` |
| POST | `/projects/:id/segments/:segId/tts` | `synthesize_single_segment` | `{ text?, voiceId?, speed? }` → `{ segment, alignment }` |
| POST | `/projects/:id/render` | `render_final_video` | `{ subtitleExportMode?, burnSubtitleStyle? }` → `RenderFinalVideoResult` |
| POST | `/open` | `open_output_folder` / `open_path` | `{ path }` → `{ ok:true }` |
| GET | `/projects/:id/events` | — | SSE stream (see §8) |

---

## 7. Tauri command mapping

The Tauri 2 shell (`apps/desktop/src-tauri`) exposes these commands; each proxies to the
orchestrator over `reqwest`, except the native helpers:

| Tauri command | Orchestrator endpoint |
|---|---|
| `create_project` | `POST /projects` |
| `open_project` / `get_project` | `GET /projects/:id` |
| `list_projects` | `GET /projects` |
| `probe_video` | `POST /projects/:id/probe` |
| `run_pipeline` | `POST /projects/:id/run` |
| `cancel_pipeline` | `POST /projects/:id/cancel` |
| `retry_pipeline_step` | `POST /projects/:id/retry` |
| `save_translated_segments` | `PUT /projects/:id/segments` |
| `synthesize_single_segment` | `POST /projects/:id/segments/:segId/tts` |
| `render_final_video` | `POST /projects/:id/render` |
| `open_output_folder` | `POST /open` |
| **`pick_video_file`** | native dialog (`tauri-plugin-dialog`) — no orchestrator call |
| **`open_path`** | native open (`tauri-plugin-opener`) — no orchestrator call |

**Progress is consumed by the webview via direct SSE** to
`ORCHESTRATOR_URL/projects/:id/events`. SSE is intentionally **not** forwarded through
Rust. In browser dev mode the same Angular code calls the orchestrator HTTP API
directly and uses `EventSource` for SSE; native-only commands degrade gracefully.

---

## 8. SSE event model

`GET /projects/:id/events` returns `text/event-stream`. Each event's `data` is a JSON
object emitted on every step transition and on log lines:

| `type` | Payload | Meaning |
|---|---|---|
| `state` | `{ type:"state", pipeline: PipelineState }` | Full pipeline snapshot. |
| `step` | `{ type:"step", step: PipelineStepState }` | A single step changed. |
| `log` | `{ type:"log", level, message, ts }` | A structured log line. |
| `done` | `{ type:"done" }` | Pipeline finished successfully. |
| `error` | `{ type:"error", error: AppError }` | Pipeline failed with a structured error. |

The UI subscribes once per running project and updates its pipeline view, log console,
and segment statuses live.

---

## 9. Service lifecycle (process management)

"The stack" is four long-running processes: the Node orchestrator (5100) and the three
Python workers (5101/5102/5103) — plus, in browser mode, the Angular dev server (1420).
There are two ways they are started and stopped.

### Dev / headless (scripts)

| Script | pnpm | Role |
|---|---|---|
| `scripts/dev.sh` | `pnpm dev` | Foreground supervisor: starts workers + orchestrator + UI; `trap`s INT/TERM/EXIT and kills its whole child set on Ctrl-C. Loads `.env`. |
| `scripts/start.sh` | `pnpm start` | Launches `dev.sh` **detached** (nohup) and writes `.dev-logs/stack.pid`. |
| `scripts/stop.sh` | `pnpm stop` | **Port-based** teardown of 1420 + 5100–5103 (SIGTERM → SIGKILL), plus the pidfile. Reliable regardless of how the stack was started. |
| `scripts/start-services.sh` | `pnpm services` | Backend only (no UI), foreground — a thin `SKIP_UI=1` wrapper over `dev.sh`. This is what the desktop shell launches. |

Each has a `.ps1` sibling for Windows. All load a repo-root `.env` (machine paths/ports)
before starting.

### Desktop app (Tauri auto start/stop)

The packaged/native app manages the backend itself, so opening the window starts
everything and closing it stops everything:

```
open app ──> Tauri .setup() ──> sidecar::maybe_spawn_services()
                                  └─ spawn `scripts/start-services.sh` in its OWN
                                     process group (unix: process_group(0);
                                     windows: CREATE_NEW_PROCESS_GROUP)
                                  └─ track the Child in SidecarManager (managed state)

quit app ──> RunEvent::Exit ────> SidecarManager::shutdown()
                                  └─ SIGTERM the process group (launcher trap + workers
                                     exit cleanly) → SIGKILL backstop  (windows: taskkill /T /F)
```

- Source: [`apps/desktop/src-tauri/src/sidecar.rs`](../apps/desktop/src-tauri/src/sidecar.rs)
  + wiring in [`lib.rs`](../apps/desktop/src-tauri/src/lib.rs).
- **Default on.** Disable with `VIDEODUBBER_MANAGE_SERVICES=0` (e.g. when you run the
  backend yourself). The repo root is found via `VIDEODUBBER_REPO_DIR` or by walking up to
  `pnpm-workspace.yaml`.
- The Angular UI in `tauri dev` is started by `beforeDevCommand` (and stopped by Tauri on
  exit); in a packaged build the UI is served from `frontendDist`, so only the backend
  process group is managed.
- **Standalone installers** (no pre-installed Node/Python) would bundle the orchestrator
  and workers as Tauri sidecars (`bundle.externalBin`, via `pkg`/`pyinstaller`) and launch
  those instead of the dev script — see [`ROADMAP.md`](ROADMAP.md).

---

## Why `jianchang512/stt` is reference-only

The open-source project [`jianchang512/stt`](https://github.com/jianchang512/stt) is
licensed under **GPL-3.0**. We studied it **only** to understand the general approach of
a local dubbing/STT pipeline (the high-level idea of *extract audio with FFmpeg →
transcribe with a Whisper-family model → emit JSON/SRT*).

- **No code was copied, adapted, translated, or vendored** from that project — or any
  other GPL project — into VideoDubber.
- VideoDubber's pipeline was **reimplemented cleanly from scratch**: our own
  FFmpeg argv wrappers, our own faster-whisper FastAPI worker, our own JSON/SRT
  serialization, our own orchestrator and data model.
- `jianchang512/stt` is **not a build-time or run-time dependency** of VideoDubber. It is
  not installed, imported, linked, or invoked.

Because the repository contains no GPL-licensed code, the entire VideoDubber codebase is
distributed under the permissive **MIT** license. Third-party tools such as FFmpeg,
faster-whisper, Argos Translate, and Piper are invoked as separate processes / used via
their own permissive runtimes and remain under their respective upstream licenses. See
[`NOTICE.md`](../NOTICE.md) for the formal statement.
