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
atomically. The partial keeps the real extension because ffmpeg picks its muxer from it.

### The lazy media proxy

`createLazyMediaService()` in `server.ts` generates its forwarders from `MEDIA_SERVICE_METHODS`,
backed by a `Record<keyof PipelineMediaService, true>` table in `media.ts`. Adding a method to the
interface without listing it is a **compile error**. This is not ceremony: the hand-written version
omitted `clip16kMono`, which is exactly what the runner's long-video chunking gate tests, so chunked
STT was dead in every shipped build — and no test could see it, because the fixture media service
implements the method.

### Engine packs

Optional downloaded engines (whisper.cpp, llama.cpp + chat models, neural TTS) installed on demand
into **uv venvs** under the user's config dir. Catalog: `engines/enginePackCatalog.ts` — every
artifact URL carries a pinned `sha256`. `DISABLED_PACK_IDS` gates packs out of releases
(`separation-audio` and `alignment-whisperx` are unimplemented stubs; `tts-omnivoice` is on hold —
`docs/OMNIVOICE.md` is canonical). Recommend by measured hardware fit, but **never restrict a
backend**: the user can always pick anything.

### Dev vs production runtime

`apps/desktop/src-tauri/src/sidecar.rs` has two paths. Dev (a `pnpm-workspace.yaml` is found) runs
`scripts/start-services.*`; production spawns frozen `externalBin` sidecars. `pnpm dev` isolates all
state under `VIDEODUBBER_DEV_HOME` (default `~/VideoDubber-dev`) so development never touches an
installed app's `~/VideoDubber`.

## Platform constraints that have caused shipped bugs

**Python must be 3.12, not ">= 3.12".** The bundled runtime is CPython 3.12.13 and engine-pack venvs
are built against it. Freezing workers from a 3.13 interpreter stamped `minos 26.0` onto 120 bundled
Mach-O files, so every published macOS build through v0.8.1 had a backend that could not start on
any Mac below 26 — while the PyInstaller launcher itself looked fine at `minos 11.0`.

**macOS floor is 14.0, and `tauri.conf.json` is the single source of truth.** numpy/onnxruntime/av
publish no Apple-Silicon wheels below `macosx_14_0`, so no build flag can go lower. `MIN_MACOS` in
`commands.rs` (the updater's OS gate) is kept in sync by the `min_macos_matches_config` test.
Moving the floor = change one number + `cargo test min_macos`.

**Windows installers are unsigned, by standing decision** — not a missing step. SmartScreen is
expected; in-app updates are unaffected (they carry the updater's own signature).

When writing code that touches the filesystem or spawns processes, assume the test suite has only
ever run on macOS unless proven otherwise. Recent Windows-only failures: POSIX separators asserted
against a `path.join` result; `/dev/null/...` used as an uncreatable path; `mode & 0o111` and
`0o600` asserted where Windows implements neither.

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
