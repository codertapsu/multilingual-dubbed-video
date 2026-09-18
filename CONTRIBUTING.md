# Contributing to VideoDubber

Welcome. This page is for someone who has **never seen this codebase** and wants to get
it running, change something, and send the change back.

VideoDubber is a local/offline-first desktop dubbing app: a **Tauri 2** shell around an
**Angular 22** UI, a **Node/Fastify** orchestrator on port 5100, **three Python FastAPI
workers** (STT 5101 / translation 5102 / TTS 5103), a Node media-worker that wraps
FFmpeg, and optional downloadable "engine packs" installed into `uv` venvs.

Users do not need any of this — they download an installer. See
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

---

## 1. Get set up — one command

```bash
git clone https://github.com/codertapsu/multilingual-dubbed-video.git
cd multilingual-dubbed-video

pnpm bootstrap
```

The same command works on **macOS, Linux and Windows**. If you do not have `pnpm` yet,
run it as `corepack enable && corepack prepare pnpm@11.9.0 --activate` first — Corepack
ships with Node, and `package.json`'s `packageManager` field pins the exact pnpm version.

### What `pnpm bootstrap` does

Five numbered phases, the same on both OSes:

1. **Prerequisites** — Node, pnpm, Python, FFmpeg, and (only if you want the native
   window) Rust. It **never installs system software behind your back**: anything
   missing is reported with the *exact* command for your OS — `brew install
   python@3.12`, `winget install --id Python.Python.3.12 -e`, … — and it stops.
   Deciding what goes on your machine is your call, not a setup script's.
2. **Workspace dependencies** — `pnpm install`.
3. **Build the workspace libraries** — `pnpm build`. This is not optional polish:
   `@videodubber/shared` and `@videodubber/media-worker` are consumed through package
   `exports` that point at `dist/`, so without it `pnpm dev` dies at
   `Could not resolve "@videodubber/shared"`.
4. **Python workers + models** — a `.venv` per worker with its `requirements.txt`, a
   pre-cached faster-whisper model, an Argos language pair, a Piper voice. It resolves
   a **real 3.12** interpreter and hands it to the setup as `PYTHON_PATH` rather than
   letting whatever `python3` happens to be on PATH decide — a 3.13/3.14 venv is how
   v0.8.1 shipped macOS workers no older Mac could load. Needs the network, but never
   fails hard offline: it prints the manual steps instead.
5. **Verify** — the environment doctor, so you end on an OK/WARN/MISSING table instead
   of discovering a gap three commands later.

It is **idempotent**: re-running it is a no-op plus a fresh prerequisite table.

**Flags** (each is also an environment variable, which is how the same behavior is
driven on both OSes and in CI):

| macOS / Linux | Windows | Env | Effect |
|---|---|---|---|
| `--skip-deps` | `-SkipDeps` | `SKIP_DEPS=1` | Don't run `pnpm install`. |
| `--skip-build` | `-SkipBuild` | `SKIP_BUILD=1` | Don't run `pnpm build`. |
| `--skip-python` | `-SkipPython` | `SKIP_PYTHON=1` | No venvs, no model downloads. |
| `--skip-models` | `-SkipModels` | `SKIP_MODELS=1` | Venvs yes, ~700 MB of models no. |
| `--strict` | `-Strict` | `STRICT=1` | Treat **optional** prerequisites as errors. |
| `--help` | `-Help` | — | The flag list. |

Pass them straight after the task name — **no `--` separator**:
`pnpm bootstrap --skip-models`. pnpm 11 forwards a literal `--` to the script
rather than swallowing it, and these scripts reject an unknown option, so
`pnpm bootstrap -- --skip-models` dies with `Unknown option: --` and exit 2.

### Doing it by hand

`pnpm bootstrap` is a wrapper, not magic. The individual steps are:

```bash
corepack enable && corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm build
node scripts/run.mjs setup-local-models     # or: bash scripts/setup-local-models.sh
pnpm doctor
```

`setup-local-models` is tunable via environment variables — `SKIP_VENVS=1`,
`SKIP_MODELS=1`, `SKIP_WHISPER=1`, `SKIP_ARGOS=1`, `SKIP_PIPER=1`, plus `PYTHON_PATH`,
`FASTER_WHISPER_MODEL`, `ARGOS_FROM`/`ARGOS_TO`, `PIPER_VOICE` and
`VIDEODUBBER_DEV_HOME`. The `.ps1` twin accepts the same env vars **and** the switch
forms `-SkipVenvs`, `-SkipModels`, `-SkipWhisper`, `-SkipArgos`, `-SkipPiper`.

Full detail: [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) (all platforms) and
[`docs/WINDOWS.md`](docs/WINDOWS.md) (the Windows toolchain, end to end).

---

## 2. Run it

```bash
pnpm dev        # workers + orchestrator + Angular UI, foreground. Ctrl-C stops all.
```

Then open **http://localhost:1420**.

Prefer the real native window? `pnpm app` (needs Rust) opens the Tauri shell, which
**starts the backend for you on open and stops it on quit**.

Logs from the dev stack land in `.dev-logs/`.

---

## 3. Task reference — every `pnpm` script

**All of these work on macOS, Linux and Windows.** The shell tasks ship as pairs
(`scripts/dev.sh` + `scripts/dev.ps1`, and so on) and `scripts/run.mjs` picks the right
half for your OS, forwarding your arguments, the exit code and Ctrl-C. Older revisions
of these docs listed a `bash …` command and a separate `pwsh …` command for the same
task; that split is gone — **use the `pnpm` name on every OS.**

### Setup & health

| Command | What it does | Notes |
|---|---|---|
| `pnpm bootstrap` | One-command onboarding, in five phases: prerequisite check → `pnpm install` → `pnpm build` → Python venvs + models → doctor. | The documented entry point. Idempotent. Flags: `--skip-deps`, `--skip-build`, `--skip-python`, `--skip-models`, `--strict` (`-SkipDeps` … on Windows; each is also an env var). |
| `pnpm doctor` | `scripts/verify-environment.ts`. Prints an OK/WARN/MISSING table for Node, pnpm, Python, ffmpeg/ffprobe, the three worker `/health` endpoints, the orchestrator `/health`, the whisper model, installed Argos languages and Piper. | Exits non-zero **only** when a check marked `core` (Node or pnpm) fails, so you can inspect a partial setup. |
| `pnpm verify` | The same script under its older name. | Kept so existing docs, muscle memory and scripts keep working. |

### Running the stack

| Command | What it does | Notes |
|---|---|---|
| `pnpm dev` | Full stack in the **foreground**: 3 Python workers + orchestrator + Angular UI. Ctrl-C stops everything. | `SKIP_WORKERS=1`, `SKIP_UI=1`, `SKIP_LIB_WATCH=1` are honored by `dev.sh`. On Windows they are the switches `-SkipWorkers`, `-SkipUi`, `-SkipLibWatch` on `scripts\dev.ps1` — only `-SkipLibWatch` also reads its env var there, so pass the switch. |
| `pnpm start` | The full stack **detached** — your terminal comes back. | Logs to `.dev-logs/`; supervisor PID in `.dev-logs/stack.pid`. |
| `pnpm stop` | Stops the whole stack. | **Port-based** (1420 / 5100 / 5101–5103), so it works no matter how the stack was started — `dev`, `start`, individual `dev:*`, or the desktop shell's managed services. |
| `pnpm services` | Backend only (orchestrator + 3 workers), no UI, foreground. | A thin wrapper over `dev` with `SKIP_UI=1`. This is what the Tauri shell launches. |
| `pnpm app` | The native desktop app (`tauri dev`). Auto-starts and auto-stops the backend. | Needs Rust. `VIDEODUBBER_MANAGE_SERVICES=0` makes it attach to a backend you started yourself. |
| `pnpm dev:workers` | Only the 3 Python workers (5101/5102/5103). | |
| `pnpm dev:orchestrator` | Only the Node orchestrator (5100), `tsx watch`. | |
| `pnpm dev:desktop` | Only the Angular dev server (`ng serve --port 1420`). | Build the workspace libraries first — see [the gotcha in `LOCAL_SETUP.md`](docs/LOCAL_SETUP.md#desktop-ui). |

### Building & checking

| Command | What it does | Notes |
|---|---|---|
| `pnpm build` | Builds the TS packages + the media-worker. | Not the installer. |
| `pnpm lint` | ESLint over the TypeScript sources. | |
| `pnpm typecheck` | `tsc --noEmit` in every workspace package. | |
| `pnpm test` | The TypeScript suites (`pnpm -r test`): shared, media-worker, orchestrator, and the desktop app's i18n check. | Does **not** reach Python — see [Tests](#5-tests). |
| `pnpm test:workers` | The Python suites (pytest) for the three workers plus the two TTS engine packs. | `ONLY=stt-worker`, `REQUIRE_ALL=1`. On Windows: `-Only`, `-RequireAll`. Suites without a venv are **skipped**, not failed, unless you pass `REQUIRE_ALL`. |
| `pnpm test:all` | `pnpm test && pnpm test:workers`. | What you want before opening a PR. |
| `pnpm check` | `lint` → `typecheck` → `test:all` → `check-versions.mjs` → `check-tasks.mjs`. | The full gate. `check-versions` asserts the five places carrying the app version agree; `check-tasks` asserts every dispatched task has **both** shell twins, so adding a one-sided task fails on any machine instead of only on the OS that is missing it. |

### Packaging & release (maintainers)

| Command | What it does | Notes |
|---|---|---|
| `pnpm package:sidecars` | Stages everything bundled into an installer: the orchestrator (Node SEA), the frozen Python workers, `vd-piper`, `vd-uv` + a portable CPython, a libass FFmpeg, and the engine-pack source. | Required before `pnpm app:build`. |
| `pnpm app:build` | `tauri build` → the installer/bundle for this OS. | Needs Rust **and** generated app icons. |
| `pnpm release` | The front door to cutting this OS's release. A thin wrapper that reimplements nothing: macOS delegates to `release-macos.sh` (build → deep-sign → notarize → staple → updater archive → upload), Windows to `release-windows.ps1`. | Flags: `--sidecars` / `--upload` / `--tag v0.9.1` on macOS, `-Sidecars` / `-Upload` / `-Tag` on Windows — e.g. `pnpm release --sidecars --upload` (no `--` separator — see §1). Read [`docs/RELEASING.md`](docs/RELEASING.md) first. |
| `pnpm release:check` | The preflight: "could I cut a release right now?" Checks the credentials and gates in seconds and **builds nothing**. | Worth running every time. On macOS the real path ships the bundle to Apple's notary service, so discovering a missing `APPLE_TEAM_ID` afterwards costs ~20 minutes. |
| `pnpm desktop:rebuild` | `scripts/clean-build.mjs` — a fully clean rebuild of the desktop app. Removes generated artifacts, then reinstalls, rebuilds sidecars and bundles. | Keeps `node_modules`, the cargo cache and the worker venvs (removing them costs 10–30 min for no correctness gain). `DEEP=1` wipes the venvs too. |

### Odds and ends

| Command | What it does | Notes |
|---|---|---|
| `pnpm eval:translation` | The EN↔VI A/B translation eval harness (chrF + a side-by-side dump). | Start the engines first; see the script header for `EVAL_OLLAMA` / `EVAL_LLAMACPP_URL`. |
| `pnpm diagnose:llama` | Diagnoses the llama.cpp translation engine pack. | |
| `pnpm dmg:instructions` | Builds the `.dmg` Finder layout for a macOS release. | **macOS only**, and declared as such in `scripts/check-tasks.mjs`'s `PLATFORM_ONLY` — a disk-image concept with no Windows analogue. It is the one task with a single twin, and the exception is written down. |

---

## 4. Repo layout

```
apps/
  desktop/              videodubber-desktop — Angular 22 standalone UI
    src/i18n/           en.json + vi.json (kept key-for-key in sync)
    src-tauri/          the Tauri 2 / Rust shell: sidecar.rs, commands.rs, …
packages/
  shared/               @videodubber/shared — types + subtitle/language/pipeline utils
  node-orchestrator/    @videodubber/node-orchestrator — the pipeline engine (:5100)
workers/
  media-worker/         @videodubber/media-worker — FFmpeg/ffprobe wrapper (Node, in-process)
  stt-worker/           Python · FastAPI · faster-whisper     (:5101)
  translation-worker/   Python · FastAPI · Argos Translate    (:5102)
  tts-worker/           Python · FastAPI · Piper / system TTS (:5103)
  tts-engine-neural/    engine pack: VieNeu neural Vietnamese TTS
  tts-engine-omnivoice/ engine pack: OmniVoice — ON HOLD, excluded from releases
scripts/                every task script, as a .sh + .ps1 pair, plus run.mjs
docs/                   user, contributor and maintainer documentation
```

**Four packages are in the pnpm workspace** — `apps/desktop`, `packages/shared`,
`packages/node-orchestrator`, `workers/media-worker` — plus the repo root. The
**Python workers are deliberately not pnpm packages**: they are managed with their own
`requirements.txt` and virtualenvs and launched from `scripts/`. `pnpm-workspace.yaml`
says so explicitly, and that has a consequence for tests (next section).

The Tauri shell lives in **`apps/desktop/src-tauri/`**. It starts the backend on open
(`src/sidecar.rs`), stops it on quit, and exposes native commands (file picker, "open
output folder", …) that proxy to the orchestrator.

Deeper map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 5. Tests

```bash
pnpm test              # TypeScript: shared, media-worker, orchestrator, desktop i18n
pnpm test:workers      # Python: pytest across the workers and TTS engine packs
pnpm test:all          # both
```

Rust, for the desktop shell:

```bash
cd apps/desktop/src-tauri
cargo test
```

> **Why `pnpm test` is not enough.** `pnpm -r test` only visits pnpm workspace packages,
> and the Python workers are not pnpm packages, so for a long time roughly a hundred
> passing Python tests ran **nowhere automatically** — while the packaging scripts would
> happily freeze and ship a worker whose suite was red. `pnpm test:workers` exists to
> close that gap; it takes about a second. Run `pnpm test:all` before you push.

`pnpm test` for the desktop app is not a unit-test runner — it is
`scripts/check-i18n.mjs`, which fails if the UI asks for a translation key that a locale
does not define. Angular compiles `{{ 'a.b.c' | translate }}` whether or not `a.b.c`
exists and renders the raw key to the user, so this check is the only thing standing
between a typo and `settings.engines.title` appearing mid-screen.

---

## 6. House conventions

These are not style preferences; each one is load-bearing.

**Comments explain WHY, and name the incident.** A comment that restates the code is
noise. A comment that says *"this used to download into `~/VideoDubber` while `dev.sh`
read `~/VideoDubber-dev`, so the first dub silently re-downloaded the model"* is the
reason the next person does not undo the fix. Read the header of
`scripts/package/build-workers.sh` or `scripts/run.mjs` for the register to aim for.

**Helpers are pure and testable.** Push logic out of the I/O path into functions that
take values and return values. That is what makes the fast suites above possible.

**Subprocesses take an argv array, never a concatenated shell string.** Every path in
this project can contain a space, and several routinely do. `spawn(bin, [a, b])` — not
`` spawn(`${bin} ${a}`) ``.

**`en.json` and `vi.json` stay key-for-key in sync.** Add a key to one, add it to the
other in the same change. `pnpm --filter videodubber-desktop test` enforces it.

**Shell scripts ship in pairs.** If you add `scripts/foo.sh`, add `scripts/foo.ps1`, or
you have just made a task that a Windows contributor cannot run. `pnpm check` enforces
this via `scripts/check-tasks.mjs`; a genuinely single-platform task must be declared in
its `PLATFORM_ONLY` map **with a reason**, which is the point — an exception gets argued
for in writing, once. The two twins must also agree on flag names, env-var names, phase
order and exit codes, because a reviewer diffs them for drift.

`bash`: `set -euo pipefail`, `SCRIPT_DIR`/`ROOT_DIR` resolved from `${BASH_SOURCE[0]}`,
colored tag logging, and **bash 3.2-compatible** (that is what macOS ships — no
associative arrays, no `mapfile`, no `${var^^}`).
`pwsh`: `#requires -Version 7.0`, comment-based help, `[CmdletBinding()] param(...)`,
`$ErrorActionPreference = 'Stop'`, and **check `$LASTEXITCODE` after every native
call** — `Stop` does not trap a native program's exit code, and that exact gap once
shipped a bare `node.exe` as the orchestrator.

---

## 7. Gotchas that actually bite

- **Python must be 3.12.** It is what `UV_PYTHON_VERSION` gives every engine-pack venv
  and what the installer's bundled interpreter is, so matching it keeps dependency
  resolution identical to a release. 3.11 and 3.13 run, but the metadata is
  marker-sensitive across that boundary, so a bug you hit on 3.13 may be one no user
  can hit. **Avoid 3.14** — several ML wheels are not published for it, which forces
  slow or failing source builds.
- **On Windows, use `pwsh` 7 — not "Windows PowerShell 5.1".** 5.1 mishandles these
  scripts (a native command's redirected stderr becomes a terminating
  `NativeCommandError`, among other things). `winget install --id Microsoft.PowerShell -e`.
- **Do not put `FFMPEG_PATH` in `.env` on the Windows build box.** The release build
  reads `.env` too, and a *shared* ffmpeg build (the gyan.dev `…-shared` archive most
  people have at `D:\ffmpeg`) cannot be bundled — the sidecar ships `ffmpeg.exe` alone,
  without its DLLs. Put the folder on **PATH** for dev and let the release build
  download the static build it needs. Details: [`docs/WINDOWS.md`](docs/WINDOWS.md).
- **The app requires macOS 14.0+** (Apple Silicon). numpy / onnxruntime / av publish no
  arm64 wheels below `macosx_14_0`, so 14.0 is the real floor and the app declares it.
- **Windows installers are unsigned, by choice.** There is no Authenticode certificate
  and none is planned, so SmartScreen's "Unknown publisher" panel on a hand-downloaded
  installer is expected behavior, not a bug. In-app auto-updates are unaffected.
- **Burned-in subtitles need an FFmpeg built with libass.** macOS Homebrew's default
  `ffmpeg` omits it; `brew install ffmpeg-full` and set `FFMPEG_PATH`/`FFPROBE_PATH`.
  The other subtitle modes work with any FFmpeg.
- **The workspace libraries must be built even in dev.** `@videodubber/shared` and
  `@videodubber/media-worker` are consumed through package `exports` that point at
  `dist/`. `pnpm dev` handles it; starting `ng serve` on its own does not.

More symptoms and fixes: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## 8. Proposing a change

1. **Open an issue first** for anything larger than a fix — a new engine, a pipeline
   step, a dependency. It is cheaper to disagree about an approach in prose.
2. Branch off `main`.
3. Make the change. Keep it focused; a PR that does one thing gets reviewed, a PR that
   does four gets postponed.
4. Run `pnpm check` (and `cargo test` if you touched `src-tauri/`). Add or update tests
   for anything you fixed — a bug without a regression test comes back.
5. If you touched a script, touch **both halves of the pair** and verify each parses:
   `bash -n scripts/foo.sh`, and for PowerShell either `pwsh -NoProfile -Command
   '[System.Management.Automation.Language.Parser]::ParseFile(...)'` or say plainly in
   the PR that you could not parse-check it.
6. If you changed behavior a user can see, update the docs in the same PR. A doc that
   describes last month's behavior is worse than no doc.
7. Write the commit message so it explains **why**, and open the PR.

### What a good bug report contains

- **What you did, what you expected, what happened** — in that order.
- **The diagnostics blob.** In the app, open **Help & diagnostics** and press
  **Copy diagnostics**. It describes the machine, the versions and what went wrong, and
  it is never sent anywhere on its own — you paste it deliberately.
- From a source checkout: the relevant file from **`.dev-logs/`**
  (`orchestrator.log`, `stt-worker.log`, …) and the output of **`pnpm doctor`**.
- The **error code** if the app showed one (`FFMPEG_NOT_FOUND`,
  `FFMPEG_FILTER_MISSING`, …). Every code is listed in
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
- Whether it reproduces from a **fresh** `pnpm bootstrap`.

---

## 9. Scope

Two things are out of scope on purpose, so nobody spends a weekend on a PR that cannot
be merged:

- **Voice cloning.** Excluded deliberately. Any such capability would need explicit,
  documented consent from the person whose voice is involved, plus a legal review.
- **Anything that makes a cloud call by default.** Cloud providers are opt-in per phase
  and per key, and local-first is the product, not a fallback.

What *is* wanted, and what has already shipped, is in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

By contributing you agree your work is licensed under the repository's
[MIT License](LICENSE).
