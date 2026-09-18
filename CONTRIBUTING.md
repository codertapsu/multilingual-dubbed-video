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

**Only phase 1 never installs.** It is easy to read the sentence above as "bootstrap just
checks things" — it does not. Phases 2-4 install workspace dependencies, build the
libraries, create a `.venv` for **each of the five Python suites** and download roughly
**1.5-2 GB of models**. Budget **20+ minutes** on a first run, on a real connection.

**Flags** (each is also an environment variable, which is how the same behavior is
driven on both OSes and in CI):

| macOS / Linux | Windows | Env | Effect |
|---|---|---|---|
| `--skip-deps` | `-SkipDeps` | `SKIP_DEPS=1` | Don't run `pnpm install`. |
| `--skip-build` | `-SkipBuild` | `SKIP_BUILD=1` | Don't run `pnpm build`. |
| `--skip-python` | `-SkipPython` | `SKIP_PYTHON=1` | No venvs, no model downloads. |
| `--skip-models` | `-SkipModels` | `SKIP_MODELS=1` | Venvs yes, ~1.5-2 GB of models no. |
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
| `pnpm check` | `lint` → `typecheck` → `test:all` → `check-versions.mjs` → `check-tasks.mjs`. | The full gate. `check-versions` asserts the **four** version manifests agree — `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json` — and reports a stale `Cargo.lock` entry as a *warning*, since cargo owns that file and regenerates it on the next build (`--set X.Y.Z` bumps all four in one reviewable command); `check-tasks` asserts every dispatched task has **both** shell twins, so adding a one-sided task fails on any machine instead of only on the OS that is missing it. |

### Packaging & release (maintainers)

| Command | What it does | Notes |
|---|---|---|
| `pnpm package:sidecars` | Stages everything bundled into an installer: the orchestrator (Node SEA), the frozen Python workers, `vd-piper`, `vd-uv` + a portable CPython, a libass FFmpeg, and the engine-pack source. | Required before `pnpm app:build` — and before `cargo check`/`cargo test`, which fail on a fresh clone without it (`build.rs` copies the sidecars; `generate_context!` needs `apps/desktop/dist`). Needs `rustc` on PATH even though it compiles no Rust: it derives the target triple from `rustc -Vv`. |
| `pnpm app:build` | `tauri build` → the installer/bundle for this OS. | Needs Rust **and** generated app icons. |
| `pnpm release:check` | The preflight: "could I cut a release right now?" Version consistency, the Python suites run strictly (`test-workers -RequireAll`), a clean git tree, the updater signing key, a GitHub token. **Builds nothing**, takes seconds. | Worth running every time. On macOS the real path ships the bundle to Apple's notary service, so discovering a missing `APPLE_TEAM_ID` afterwards costs ~20 minutes. `ALLOW_DIRTY=1` downgrades the clean-tree gate to a warning. |
| `pnpm release` | The front door to cutting **this OS's half** of a release. A thin wrapper that reimplements nothing: macOS delegates to `release-macos.sh` (build → deep-sign → notarize → staple → updater archive → upload), Windows to `release-windows.ps1`. | Flags: `--sidecars` / `--upload` / `--tag v0.9.1` on macOS, `-Sidecars` / `-Upload` / `-Tag` on Windows — e.g. `pnpm release --sidecars --upload` (no `--` separator — see §1). Read [`docs/RELEASING.md`](docs/RELEASING.md) first. |
| `pnpm release:version` | Starts a release cycle: bumps the version in the four manifests **and** `Cargo.lock` in one reviewable command (`node scripts/release-version.mjs`). | `pnpm release:version 0.10.0` or `minor`/`patch`. **Dry run** until `--yes`. Refuses on a dirty tree; restores every file if any step fails. It does not commit, tag, build, or touch GitHub. Replaces five hand-edits made under release pressure — the expensive half-bump is `tauri.conf.json`, because `release-upload` derives the draft tag from it, so a stale one uploads this release's installers onto the **previous** release without erroring. |
| `pnpm release:status` | "Where is this release up to, and what is still missing?" (`node scripts/release-status.mjs`). Lists the 8 assets per machine with sizes, checks `latest.json` for all three platform keys at the right version, and prints a verdict. | **Read-only** — GETs only. Exit 0 = complete, so it can gate a script. Neither release machine can see the other's progress; this is how you find out. `--tag`, `--repo`, `--json`. An `untagged-…` URL on a draft is normal and it says so. |
| `pnpm release:publish` | Publishes the finished draft (`node scripts/release-publish.mjs`): re-runs the status check, **refuses to publish anything incomplete**, then appends your notes and flips the draft. | **Dry run unless `--yes`.** `--notes-file PATH` / `--notes "..."`, `--tag`, `--repo`, `--prerelease`. Notes go **under** the seeded download table, never over it, and re-running replaces the changelog rather than stacking a second copy. |
| `pnpm desktop:rebuild` | `scripts/clean-build.mjs` — a fully clean rebuild of the desktop app. Removes generated artifacts, then reinstalls, rebuilds sidecars and bundles. | Keeps `node_modules`, the cargo cache and the worker venvs (removing them costs 10–30 min for no correctness gain). `DEEP=1` wipes the venvs too. |

Three more release scripts have no `pnpm` name: the first two are called for you by
`pnpm release`, and the third is a cleanup you run occasionally. They are the moving
parts, and worth knowing when something goes wrong mid-release:

| Script | What it does |
|---|---|
| `scripts/package/release-upload.{sh,ps1}` | **Ensures** the `vX.Y.Z` **draft** release exists (creating it on demand, seeded with the bilingual download table from `release-body-header.md`) and **uploads** assets to it. GitHub REST via `curl`; the token is `$GH_TOKEN`, else whatever `git credential fill` has for `github.com`. |
| `scripts/package/merge-latest-json.mjs` | Merges **one** platform's entry into the release's `latest.json`, preserving every other platform's. `--platform darwin-aarch64 \| windows-x86_64 \| windows-x86_64-msi`. `--fix-tag` repairs a stray `untagged-<sha>` draft tag. |
| `scripts/package/prune-releases.mjs` | Keeps the N newest **published** releases (default 2). **Dry run by default** — `--apply` to actually delete. Never touches drafts, never touches the release the updater resolves to, and keeps git tags unless you pass `--tags`. |

#### How a release is actually cut

There is **no CI build** — since 2026-07-04 a release is two local builds, **in
parallel, on two machines**, converging on one GitHub draft:

```
Mac (arm64)                              Windows box
pnpm release --sidecars --upload         pnpm release -Sidecars -Upload
  build -> deep-sign -> notarize                build -> verify -> upload
  -> staple -> updater archive
        |                                          |
        +----------->  draft release vX.Y.Z  <-----+
                       (created on demand by
                        release-upload, by
                        whichever gets there first)
```

Each machine merges only **its own** `latest.json` entry, so neither clobbers the
other: `darwin-aarch64` from the Mac, `windows-x86_64` **and** `windows-x86_64-msi`
from Windows (MSI-installed users need their own updater target, or an update drags
them through an elevated `msiexec` uninstall).

A complete draft has exactly **8 assets** — 3 from the Mac, 4 from Windows, plus the
shared `latest.json`:

```
latest.json
VideoDubber_<ver>_aarch64.app.tar.gz  + .sig     macOS updater payload
VideoDubber_<ver>_aarch64.dmg                    macOS installer  (no .sig -- correct)
VideoDubber_<ver>_x64-setup.exe       + .sig     Windows NSIS installer
VideoDubber_<ver>_x64_en-US.msi       + .sig     Windows MSI
```

The `.dmg` having no `.sig` is not an oversight: the updater installs the
`.app.tar.gz`, which is the file the signature covers. The Windows installers are
**unsigned** by a standing decision — there is no Authenticode certificate and none is
planned.

So the whole cycle is five commands:

```bash
pnpm release:version 0.9.1 --yes     # once, on either machine; commit and push
pnpm release --sidecars --upload     # the Mac      \ in parallel
pnpm release -Sidecars -Upload       # the Windows box /
pnpm release:status                  # read-only: is the other machine done?
pnpm release:publish --notes-file NOTES.md --yes
```

`release:publish` is deliberately not just "click the button in a script". It re-runs
`release:status` and **refuses** anything incomplete, because publishing cannot be taken
back — clients resolve `releases/latest` the moment you publish, and a `latest.json`
missing `windows-x86_64` looks perfectly fine in the asset list while silently stranding
every Windows user on the version they have.

The full runbook, including what to verify afterwards and how to roll back, is
[`docs/RELEASING.md`](docs/RELEASING.md); the Windows half end to end is
[`docs/WINDOWS.md`](docs/WINDOWS.md#part-e--build-release-and-publish).

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

Rust, for the desktop shell — **after `pnpm package:sidecars`**, not before:

```bash
pnpm package:sidecars              # once; see below for why
cd apps/desktop/src-tauri
cargo check
cargo test                         # 16 tests
```

> **`cargo check` fails on a fresh clone**, and the error does not say why. `build.rs`
> copies the five `externalBin` sidecars, and `generate_context!` needs the built Angular
> output in `apps/desktop/dist` — all of it gitignored, all of it produced by
> `pnpm package:sidecars`. On Windows, wrap both calls in an explicit `$LASTEXITCODE`
> check: `$ErrorActionPreference = 'Stop'` does not trap a native program's exit code, so
> a failed `cargo check` otherwise falls straight through into `cargo test`.

On Windows, run the Python suites the way the release gate does — `pwsh
scripts\test-workers.ps1 -RequireAll`. Without `-RequireAll` a suite with no venv is
reported as *skipped* and the run exits 0, which reads green having run nothing. All
**five** suites need a venv, and `setup-local-models` creates all five.

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
- **On Windows, use `pwsh` 7 — not "Windows PowerShell 5.1".** This is not a
  preference. `scripts/bootstrap.ps1`, `scripts/release.ps1` and
  `scripts/package/release-windows.ps1` carry `#requires -Version 7.0` and **hard-fail**
  in 5.1 before running a line; `scripts/run.mjs` only *warns* when it finds 5.1, so
  `pnpm bootstrap` there prints a warning and then dies on the `#requires` anyway. (5.1
  also mishandles these scripts in general — a native command's redirected stderr becomes
  a terminating `NativeCommandError`.) `winget install --id Microsoft.PowerShell -e`.
- **Every `.ps1` in this repo must be pure ASCII.** PowerShell decodes a BOM-less `.ps1`
  in the host's **ANSI codepage**, so a UTF-8 em dash arrives as three Windows-1252
  characters and, inside a quoted string, takes the parser with it. 123 of them across 15
  scripts once made five scripts unparseable on Windows while every one of them was fine
  on macOS. `pnpm check` enforces it (`scripts/check-tasks.mjs`); write `-` and `...`.
- **On Windows, enable long paths once, elevated.** `pnpm install` alone builds nested
  `node_modules` chains around 256 characters *relative* to the repo root, against a
  260-character `MAX_PATH`, and the failures look like random missing files.
  `bootstrap.ps1` only advises this when the checkout path is >= 60 characters, which the
  usual `D:\development\projects\multilingual-dubbed-video` (49) never trips. See
  [`docs/WINDOWS.md`](docs/WINDOWS.md).
- **Node must be >= 24.15.0 on the Node 24 line.** The root `package.json` says
  `engines.node >= 22.12.0`, which is looser than what actually runs: Angular 22 declares
  `node: ^22.22.3 || ^24.15.0 || >=26.0.0`, and below that the UI build fails with an
  engine error that names Angular, not this repo.
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
5. If you touched a script, touch **both halves of the pair** and verify each parses.
   `bash -n scripts/foo.sh` for the bash half. For PowerShell, parse it **before** you
   run it — parsing a script you have already run proves nothing — and parse the whole
   tree, because `scripts/package/` holds more `.ps1` files than `scripts/` does:

   ```powershell
   Get-ChildItem -Path .\scripts -Filter *.ps1 -Recurse | ForEach-Object {
     $tokens = $null; $errors = $null
     [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
     if ($errors) { Write-Host "PARSE FAIL: $($_.FullName)" -ForegroundColor Red; $errors | ForEach-Object { Write-Host "  $_" } }
   }
   ```

   `ParseFile` takes **two `[ref]` arguments** after the path, and does **not** resolve a
   relative path against PowerShell's current location — hence `$_.FullName`. If you have
   no Windows machine, run `node scripts/check-tasks.mjs` (twins exist + ASCII) and say
   plainly in the PR that you could not parse-check it.
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
