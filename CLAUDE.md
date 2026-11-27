# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VideoDubber dubs a video into another language, entirely on the user's machine. Local/offline-first
is the product thesis, not an implementation detail: cloud providers are opt-in per phase and per
key, and the default path must always work with no account and no network after setup.

## Commands

```bash
pnpm bootstrap          # fresh clone -> working env (prereq check, deps, libs, venvs, models)
pnpm dev                # whole stack, foreground: 3 Python workers + orchestrator + Angular UI
pnpm app                # native Tauri window (needs Rust); auto-starts/stops the backend
pnpm stop               # port-based teardown; works regardless of how it was started
pnpm doctor             # environment self-check with per-item fix hints

pnpm build              # TS workspace libs — REQUIRED before dev; they are consumed from dist/
pnpm lint  pnpm typecheck
pnpm test               # TypeScript only (see below)
pnpm test:workers       # the Python pytest suites
pnpm check              # lint + typecheck + test:all + check-versions + check-tasks
```

`pnpm test` **cannot reach the Python workers** — they are deliberately not pnpm workspace members,
so `pnpm -r test` never visits them. Always run `pnpm test:workers` (or `pnpm test:all`) too.

Single tests:

```bash
cd packages/node-orchestrator && npx vitest run src/alignment/align.test.ts
cd packages/node-orchestrator && npx vitest run -t 'exposes EVERY method'   # filter by test name
cd workers/tts-worker && .venv/bin/python -m pytest tests/test_service.py -q
cd apps/desktop/src-tauri && cargo test min_macos     # Rust lives here, not in pnpm
```

`apps/desktop`'s `test` script is `scripts/check-i18n.mjs`, not a unit-test runner: it asserts
`en.json` and `vi.json` stay key-for-key in sync. Adding a UI string means adding both.

## Cross-platform scripts — the dispatcher

Every task script ships as a **pair**: `scripts/dev.sh` + `scripts/dev.ps1`. `package.json` names a
*task*, and `scripts/run.mjs` picks the twin for the host OS. Never wire `bash scripts/foo.sh`
directly into package.json — that is the bug that left six tasks broken on Windows while their
`.ps1` twins sat unused.

`scripts/check-tasks.mjs` (part of `pnpm check`) enforces two invariants:

1. every dispatched task has **both** twins — single-platform tasks must be declared in
   `PLATFORM_ONLY` with a written reason;
2. every `.ps1` is **pure ASCII**. PowerShell reads a BOM-less `.ps1` in the host's ANSI codepage,
   so one UTF-8 em dash inside a quoted string desyncs the parser and cascades into dozens of bogus
   errors pointing at innocent lines. macOS/Linux decode UTF-8 fine, which is exactly why this must
   be a check and not a convention.

Coordination scripts that are genuinely platform-neutral (`release-status`, `release-publish`,
`release-version`) are plain `.mjs` with no twins — only the *build* half of a release is per-OS.

**Never write `pnpm <task> -- <flag>`.** pnpm 11 forwards the literal `--` to the script, which then
exits 2. Write `pnpm release --check` (POSIX) or `pnpm release -Check` (PowerShell), no separator.

## Architecture

```
Angular 22 UI ──HTTP+SSE──> node-orchestrator :5100 ──HTTP──> stt :5101 / translation :5102 / tts :5103
 (in Tauri 2 shell)              │                                      (Python, FastAPI)
                                 └── in-process ──> media-worker (Node) ──argv──> ffmpeg / ffprobe
```

- `packages/shared` — types + subtitle/language/pipeline utils. Consumed **from `dist/`**, so a
  stale build produces confusing resolution errors.
- `packages/node-orchestrator` — the brain: pipeline runner, provider registry, engine manager,
  run queue, workspace store, SSE.
- `workers/media-worker` — TypeScript, not Python. FFmpeg wrapper, used in-process.
- `workers/{stt,translation,tts}-worker` — Python FastAPI services with their own venvs.
- `workers/tts-engine-*` — engine-pack *sources*; their runtime deps install into uv venvs on the
  user's machine, not here.
- `apps/desktop` — Angular UI (`src/`) + Tauri shell (`src-tauri/`, Rust).

### The pipeline

Nine steps in order: `probe-video → extract-audio → stt → translation → refine → tts → alignment →
audio-mix → render`. `refine` is an optional AI review pass that no-ops when unconfigured. The
canonical list is `PIPELINE_STEP_DEFS` in `packages/shared/src/pipeline/steps.ts`.

**Resumability rests on one invariant: an artifact that exists is complete.** A step is skipped when
its outputs are present. That is only sound because every ffmpeg output is written through
`writeAtomically` (`workers/media-worker/src/atomic.ts`) — to `<dest>.partial<ext>`, renamed only on
exit 0. Before that, a cancelled render left a truncated non-empty file that the next run reported
as success, shipping a half-length dub. If you add an ffmpeg-producing step, it must write
atomically. The partial keeps the real extension because ffmpeg picks its muxer from it. The
same holds for JSON artifacts (`source.json`, `translated.aligned.json`): `writeJsonAtomic`.

**Line timing is fixed in exactly one place: the end of the STT step** (`pipeline/segmentTiming.ts`).
Both engines can stretch a line across seconds of music (faster-whisper's VAD maps a line's first word
into the previous chunk's padding; whisper.cpp starts a window's first line at the window start), and
everything downstream places the dub at the line's start. Word timings decide first, then the speech
map (Silero VAD, `POST /speech-regions` on the STT worker, cached in `audio/speech_regions.json`). A
line only shrinks or splits inside its own bounds. Nothing later re-times lines automatically.

**Only the speech in a dub clip is fitted and played.** Alignment measures each clip
(`alignment/clipSpeech.ts` over media-worker `measureSpeech`) and stores the part to keep as
`trimStartMs`/`trimEndMs` on its `AlignedSegment`; `generatedDurationMs` is that part's length.
Anything that plays a clip must cut the same window: the timeline mix and the editor's fitted
preview do. A clip played whole starts a lead-in late, and a botched one ("Thua": 12.3 s, the word
in its first half second) plays its noise over the next lines.

**Every subtitle file goes through `displayCuesFor`** (`workspace/subtitleTiming.ts` → shared
`planDisplayCues`): sorted, held to ≤17 cps and ≥1 s, capped at 7 s, kept up until the line's dub
voice ends, merged within a synthesis group rather than flashed. Never write
`transcriptSegmentsToCues` output to a file directly: that is how cues shipped at 102 cps, 99 s
long, or out of order.

**A pause is a stop, never a failure.** Pause, the app quitting (the shell's `POST /shutdown`,
SIGTERM) and `/cancel` all abort the run's signal, and the runner saves the pipeline `paused` at its
step (`pausePipelineState`): the step goes back to `pending` keeping its progress, no error event.
The next run treats that step as interrupted (its leftovers are never "already done") and continues
there. The long text steps save every finished batch (`pipeline/translationCheckpoint.ts`), keyed by
everything their result depends on and deleted once the step's result is written, so a finished
step never gets its old checkpoint back. A dub the app died on is settled `paused` at the next start
(`reconcileQueue`). The shell posted `/shutdown` long before the route existed: every Windows quit
killed the dub mid-step.

**The finished video is where the user chose: `projectOutputVideoPath(project)`** (shared
`pipeline/output.ts`), never `paths.outputMp4`, for rendering it, checking it exists, and playing or
serving it. In a chosen folder the files are `<name>.<lang>.mp4/.srt/.vtt`, named once when the
folder is chosen and unique there, counting the names other projects hold before they render
(`ProjectStore.withOutputName`, locked with the save); `/file` serves exactly a project's own files
from such a folder, never the folder.

**The projects folder can move** (Settings → Projects folder, `workspace/projectsFolder*.ts`):
`<root>/projects`, the root kept in `<config>/projects-folder.json`, which wins over the
`VIDEODUBBER_PROJECTS_DIR` the shell always passes. A move rewrites every absolute path inside each
project's **JSON** files (`rebaseJson`), so a new artifact that names a workspace path must be JSON,
and code must take the folder from the store (`store.projectsDir`), never `config.projectsDir`.

**Audio runs on the picture's clock.** Some sources hold more audio samples than their
timestamps cover (a 2.73 h upload: +4.8 s), and a plain extraction played them all, so the dub
drifted behind the picture. Both extractions (and a part's window, and every file of a join)
decode with `aresample=<rate>:async=1000:first_pts=0,apad,atrim=end_sample=<picture length>`,
and the drift is measured from the DECODED sample count (`drift.ts`), never from container or
stream durations, which hid it. Every normal render is capped at the picture's length (`-t`),
so a long mix can never lengthen the video.

**Everything long is visible, with who asked.** Every request carries its initiator
(`x-vd-initiator: ui|mcp`, the MCP client's name and session; the app's own starts run inside
`runAsScheduler`), and every long job reports through `activity` (`activity/registry.ts`,
kinds `speakers.detect`, `lines.retranscribe`, `series.*`, `project.join`, `picture.detect`…),
persisted and shown in the app. Every server-side write of a project's lines goes through
`replaceSourceLines` / `saveTranslatedSegments` / `patchSegments` (which record the edit
history) or calls `recordEdit` itself; a structural edit renumbers ids, so its entry is a
`range` and undo replaces the range. The window may hold no more permanent `EventSource`s than it
has (engines, models, downloads, plus a project's own): a webview keeps six connections per host,
and a fourth app-long stream hung every other request on "Loading". New lists poll.

**Songs and pictures.** A line flagged `song` gets no voice and no alignment; the mix keeps the
original in its window (each original-audio mode has its rule in `mix.ts`); its subtitle exists
only with `songSubtitles` (through `displayCuesFor`). Blur regions and the blurred subtitle band
are drawn FIRST in the render's filter graph, then the logo, title cards and subtitles on top;
region times are the input video's time, so a series part shifts its parent's regions to its
window. Burned-in subtitles default to `position: 'auto'`: just above the source's own subtitles
when the render knows where they are (`coverBand`, else a picture detection already saved; a part
uses its parent's) and they are not covered. The render never runs a detection for it.

**An advert tail ends the dub, with no review.** "全集免费" uploads are the drama only at their
start, then hours of a banner for the full version over a still image or moving footage. The
picture detection finds the banner (media-worker `adTail.ts`: pixels that are edges at the end,
not in the first ten minutes, always the same way, then the frame from which they stay; a frozen-
picture test misses the moving kind) and leaves its frames out of the watermark and band search,
which locked onto it. At the start of STT (`adTailStart`, `stopAtAdTail` not false, 20 min+), STT
and its checks stop at `adTail.fromMs`, a series plans only up to it (`SeriesPlan.endMs`, kept when
cuts move), and a cast counts no line past it (`adTailFrom`). A warning says where; nothing waits
for the user, who is not always there to review.

**The video's own subtitles are evidence of speech.** Where a source burns its subtitles in
(`subtitleCoverageCheck`, on for zh/ja/ko by `subtitleCheckOn`), the STT step reads the band five
times a second (media-worker `subtitlePresence.ts`, no OCR), keeps when a subtitle is on screen in
`audio/subtitle_presence.json`, and the loop check's silence test counts that time as speech
(`speechWithSubtitles`): never remove a line under a subtitle as silence. 0.18.0 trusted the speech
map alone and dropped ~780 real lines of 《反相之地》. `useBurnedInSubtitles` makes the subtitles the
transcript instead: one frame per subtitle (`readBandFrames`) read by the `ocr-rapid` pack
(`vd_ocr`, the PP-OCRv4 recogniser on each text line's box only), falling back to STT with a
`burned-in-fallback` warning, never silently.

**Lines that fail the checks get a second try before voicing** (end of the refine step,
`dubPasses.retryFailingLines`): told the words at fault and the sheet's names, never touching a
locked line or a song. What still fails is a `lines-flagged` warning; `holdFlaggedLines` stops the
run there (`PipelineState.heldLines`), and continuing voices the lines as they are. A flagged line
stays visible until it is rewritten or locked ("Keep as is"; a locked line is the user's): shared
`pipeline/lineIssues.ts` is the one rule (`isFlaggedLine`), read from the files through an mtime
cache (`workspace/lineIssueReader.ts`) for the list chips (GET /projects), each series part, GET
/projects/:id/issues and get_project / get_series, which name every id (the warning names five).

**Tests never reach a running app.** `node-orchestrator/vitest.config.ts` points the worker URLs
at port 1: the server tests build the real server, whose readiness probes would otherwise call a
running VideoDubber's own workers on 5101–5103 (a 48-part production ran on the development PC
while 0.18.0 was built).

### The lazy media proxy

`createLazyMediaService()` in `server.ts` generates its forwarders from `MEDIA_SERVICE_METHODS`,
backed by a `Record<keyof PipelineMediaService, true>` table in `media.ts`. Adding a method to the
interface without listing it is a **compile error**. This is not ceremony: the hand-written version
omitted `clip16kMono`, which is exactly what the runner's long-video chunking gate tests, so chunked
STT was dead in every shipped build — and no test could see it, because the fixture media service
implements the method.

### The studio editor

The editor route is a multi-track timeline over the pipeline's own artifacts (no parallel
state). `GET/PATCH /projects/:id/timeline` is its API; `workspace/timelineEdit.ts` holds the
invariants — a line never moves past a neighbour or creates an overlap — and
`apps/desktop/.../studio/timeline-math.ts` MIRRORS them so the UI never offers an edit the
server refuses. Change one, change both. A timing edit re-fits every unit from the clip
durations on disk (no re-synthesis) and also writes `source.json`. Lines carry `voiceId`,
`speakingRate`, `locked` (auto-fit / refine never rewrite it) and `ttsStale`. Regenerating
before alignment must not create a partial `translated.aligned.json`. Editor writes are
atomic (`writeJsonAtomic` / `writeTextAtomic`). The desktop package now runs vitest for its
pure modules (`*.spec.ts`, excluded from the Angular build) after the i18n check.

### Engine packs

Optional downloaded engines (whisper.cpp, llama.cpp + chat models, neural TTS) installed on demand
into **uv venvs** under the user's config dir. Catalog: `engines/enginePackCatalog.ts` — every
artifact URL carries a pinned `sha256`. `DISABLED_PACK_IDS` gates packs out of releases
(`separation-audio` and `alignment-whisperx` are unimplemented stubs; `tts-omnivoice` is on hold —
`docs/OMNIVOICE.md` is canonical). Recommend by measured hardware fit, but **never restrict a
backend**: the user can always pick anything.

whisper.cpp is two packs, like llama.cpp: the runtime and a `whisper-model-*` pack holding the
ggml file of the **project's** speech model (`resolveWhisperCppModel`, passed as `-m`; never a
different size). Without `-m`, whisper-server loads `models/ggml-base.en.bin` from its working
directory, and that is how every whisper.cpp dub failed through 0.11.0. Request
`response_format=verbose_json`: plain `json` carries no segments, which is an empty transcript,
not an error.

Two rules from a dub that could never finish (step 6, 21-minute video, `WORKER_TIMEOUT` twice):
**never trust a runtime's default thread count** for an autoregressive model. (llama.cpp and
whisper.cpp get the performance-core count the STT worker measures, `cpu_threads` in its `/health`:
llama.cpp via `LLAMA_ARG_THREADS`, whisper-server via `-t`.) ONNX Runtime's
default ran VieNeu 5.4× slower than 2 threads, and the SDK exposes no setting, so
`vd_tts_engine/engine.py` wraps its constructor (measurements there). And **long synthesis must
be batched and resumable**: the runner splits TTS into requests of `maxSegmentsPerRequest`
(neural: 6) with progress between them, and the engine reuses unchanged clips from
`.vieneu-cache/`, so a retry continues instead of starting over.

`tts-neural-cuda` (Windows + NVIDIA) is the one uv pack resolved **per machine**:
`torchCudaBuildFor` picks PyTorch cu126 or cu130 from the detected GPUs and driver (cu126 has no
PTX, so Blackwell must never get it). On the GPU, batching is the whole speed-up: one line at a
time is slower than the tuned CPU, so requests carry 24 lines when `/health` says `cuda`. Its
install ends with a real-kernel probe (`gpuVerify.ts`) because `is_available()` says yes on cards
the build cannot run. Both HF repos it loads with `trust_remote_code` are pinned to commits in
`vd_tts_engine/pinned.py`. Don't load them from `main`: that flag executes the repo's Python.
GPU packs are heavy at pack level (`isHeavyPack`), so they evict a resident llama.cpp.

**A pin is the content, not the upload.** sherpa-onnx re-exported the speaker-embedding model on
2026-11-19 (one byte longer, identical embeddings) and every fresh install of speaker detection was
discarded as corrupt. When an upstream file changes, measure that it is the same content, then add
its checksum to the artifact's `alsoSha256`; never swap `sha256` of a model whose hash is a cache
key (the speaker engine's `modelKey` keys saved detections, part checkpoints and cloned voices'
prints).

**Speaker linking keeps each part's own verdict.** Long audio is diarized in 10-minute parts and
linked by voice print (`vd_diarize/linking.py`). Two speakers a part kept apart never merge when
both prints can be trusted (3 s of speech), and the join of short prints and the merge past 100
speakers respect it too: with the old 15-s rule a drama's main voice took in 72 local speakers.
A change to the linking rules bumps the provider's `linkKey`, which re-links saved detections from
their kept parts.

### Dev vs production runtime

`apps/desktop/src-tauri/src/sidecar.rs` has two paths. Dev (a `pnpm-workspace.yaml` is found) runs
`scripts/start-services.*`; production spawns frozen `externalBin` sidecars. `pnpm dev` isolates all
state under `VIDEODUBBER_DEV_HOME` (default `~/VideoDubber-dev`) so development never touches an
installed app's `~/VideoDubber`.

## Platform constraints that have caused shipped bugs

**Python must be 3.12, not ">= 3.12".** The bundled runtime is CPython 3.12.16 (`fetch-python` runs
`uv python install 3.12`, so the patch version is whatever the pinned uv knows — bumping uv moves it;
re-check `minos` when it does) and engine-pack venvs
are built against it. Freezing workers from a 3.13 interpreter stamped `minos 26.0` onto 120 bundled
Mach-O files, so every published macOS build through v0.8.1 had a backend that could not start on
any Mac below 26 — while the PyInstaller launcher itself looked fine at `minos 11.0`.

**macOS floor is 14.0, and `tauri.conf.json` is the single source of truth.** numpy/onnxruntime/av
publish no Apple-Silicon wheels below `macosx_14_0`, so no build flag can go lower. `MIN_MACOS` in
`commands.rs` (the updater's OS gate) is kept in sync by the `min_macos_matches_config` test.
Moving the floor = change one number + `cargo test min_macos`.

**On macOS, never let rustc strip a library that dyld must load.** rustc strips Apple targets
with its bundled rust-objcopy, whose LINKEDIT string pool is 8-byte aligned only by luck of the
sizes, and macOS 27.2's dyld refuses to LOAD a library whose pool is misaligned ("mis-aligned
LINKEDIT string pool"). The first clean 0.11.0 build died with E0463 on serde_derive /
phf_macros, whose stripped dylibs the compiler could no longer load. So
`[profile.release.build-override] strip = false`. Executables are not checked today (the
postject-built orchestrator has a 4-aligned pool and runs), but `release-macos.sh` builds the
app binary unstripped anyway, in case that changes.

**Windows installers are unsigned, by standing decision** — not a missing step. SmartScreen is
expected; in-app updates are unaffected (they carry the updater's own signature).

**In-app updates go through `src-tauri/src/update.rs`, both paths** (the Install button and the
background update at launch). The 0.16.1 → 0.17.0 update hung for good: reqwest has no timeout by
default, the ~280 MB download stalled behind a spinner, and every step was a `println!` a windowed
build has nobody to read. So the updater's client carries connect/read timeouts, the download
reports progress (`update-status`), can be cancelled, logs to `shell.log`, and writes
`<config>/update-attempt.json` before the installer starts; the next launch compares versions to
say whether it took. The NSIS hooks (`windows/installer-hooks.nsh`, pure ASCII) are the NEW
version's code: they keep killing VideoDubber's background programs (Claude's `--mcp` connections
run the same orchestrator exe) until none is left, rename a still-busy exe aside (Windows can
rename a running program, never overwrite it; the app deletes `*.exe.old-*` at its next start),
and write `logs/installer.log`.

**Tauri matches command arguments by name.** A Rust parameter `options` never receives the
webview's `{ request }`: unknown keys are dropped and an `Option` arrives `None`, silently. That
is how Settings' model Download posted `{}` and did nothing for months.
`scripts/check-tauri-commands.mjs` (in `pnpm check`) compares every `invoke`/`call` in
`ipc.service.ts` with the `#[tauri::command]` signatures.

When writing code that touches the filesystem or spawns processes, assume the test suite has only
ever run on macOS unless proven otherwise. Recent Windows-only failures: POSIX separators asserted
against a `path.join` result; `/dev/null/...` used as an uncreatable path; `mode & 0o111` and
`0o600` asserted where Windows implements neither. And the one that failed real dubs: a
temp-then-rename **replace fails with EPERM/EACCES/EBUSY on Windows while any other handle is open
on the target** (a concurrent `pipeline.json` read, the studio preview streaming `output.mp4`,
Defender scanning a fresh file). Every atomic write goes through `renameReplacing`
(`node-orchestrator/src/fsRename.ts`; media-worker `atomic.ts` carries the same) — never a bare
`fsp.rename` onto an existing file.

**Every native engine pack on Windows needs the Microsoft Visual C++ runtime, and none ships
it.** A PE import scan found `msvcp140.dll` in onnxruntime, PyTorch, whisper.cpp and llama.cpp.
The base app hides this: the frozen workers bundle their own copy, and the bundled CPython has
`vcruntime140` but not `msvcp140`. So a clean Windows runs the app, then every recommended engine
dies at first start. `engines/vcRuntime.ts` installs Microsoft's redistributable (version ≥ 14.40,
Authenticode-checked, one UAC prompt) before any download. It is wired only in `server.ts`, on
Windows; tests inject fakes and must never reach the real registry or installer. When Node spawns Windows PowerShell 5.1, drop
`PSModulePath`: inherited from a PowerShell 7 parent, it stops 5.1 loading its own cmdlets, which
made every genuine Microsoft signature read as unsigned.

## Releases

Two machines building in parallel into one GitHub draft, then one publish. `docs/RELEASING.md` opens
with the whole flow on one page.

```bash
pnpm release:version 0.11.0   # bumps 5 manifests; dry run by default
pnpm release:check            # preflight, builds nothing — run this before a 20-min build
pnpm release --sidecars --upload      # macOS  (Windows: pnpm release -Sidecars -Upload)
pnpm release:status           # what has landed, per machine; exit 0 = ready
pnpm release:publish          # refuses unless complete; dry run by default, --yes to publish
```

`release:status` exists because publishing a draft whose `latest.json` lacks a platform entry is the
quiet catastrophe: the installer is visible on the release page while those users silently stop
receiving updates forever.

A build succeeding is **not** evidence your change shipped — a skipped sidecar step re-bundles the
previous binary. Verify the artifact (`GET /health` reports version + build stamp for this reason).

`scripts/apple-credentials.env` (git-ignored) holds the notarization secrets; see the committed
`.example` for how to verify them *before* paying for a build.

## Conventions

- Comments explain **why**, and usually name the incident that motivated the code. Match that
  register — the surrounding code sets an unusually high bar for it.
- FFmpeg is invoked with an **argv array**, never a concatenated shell string.
- Prefer pure, testable helpers with the I/O injected; that is what most existing tests target.
- `en.json` / `vi.json` stay key-for-key in sync. Write natural Vietnamese — it is the primary
  audience, and the release notes and UI are Vietnamese-first.
- Never restrict a backend on hardware grounds; recommend, then let the user choose.
- Dependencies are pinned exactly, and pnpm's minimum-release-age policy stands: when `pnpm add`
  offers to add a package to `minimumReleaseAgeExclude`, pick an older release instead of
  accepting the exclusion.
- Claude goes through the official `@anthropic-ai/sdk` (`providers/cloud/claudeMessages.ts`,
  loaded lazily), never raw `fetch`: `stop_reason` is checked, schemas become structured output.
  Claude through Mother Claude (the user's Claude plan; `"via": "mother-claude"` in
  `credentials.json`, the API key kept beside it) is the same path with Mother Claude's Base URL.
  Its Settings Test sends a real message: Mother Claude has listed models while every message failed.
- A cancel is the run's `AbortSignal` being aborted, never an error code. The local LLM's
  per-request timeout used to surface as `CANCELLED`, and the passes that rethrow cancels threw
  away a translation step whose lines were all done. It is `WORKER_TIMEOUT` now, the context
  engine fails fast after one, and callers check `signal.aborted`.
- Claude Code is connected only through its own CLI (`claude mcp add|remove --scope user`,
  `integrations/claude.ts`): VideoDubber reads `.claude.json` for the status and never writes Claude
  Code's files. Claude Desktop's config is the one file it edits, with a backup beside it.
- Admission must count every engine a run will start, not just its provider ids: the context
  engine (`contextEngine.ts`, the Gemma chat model for repairs and auto-fit) takes the heavy
  lane in a run whose providers are all light (`ClassifyOptions.contextEngine`).
- Another app can hold the graphics card (`scheduler/gpuHolds.ts`, `POST /scheduler/holds`:
  Voice Mask's live sessions). A hold only stops NEW heavy-lane work (queued heavy dubs wait as
  `gpu-hold`, a free lane is refused to editor actions and previews, which fall back to the
  CPU build); it never kills, pauses or slows a running dub, and a dub admitted on the lane
  keeps it. Holds are in memory and expire unless renewed: never persist one.
