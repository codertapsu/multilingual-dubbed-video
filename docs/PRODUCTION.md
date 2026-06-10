# Production — the fully self-contained desktop app

This document describes how VideoDubber ships to **end users** as a one-click,
fully self-contained installer, and how it differs from the dev/source-checkout
mode you use day-to-day.

> **TL;DR.** The installer bundles *everything that runs code* — the Tauri shell,
> the Angular UI, the Node orchestrator, the three Python workers, and an
> libass-enabled FFmpeg/ffprobe — as Tauri **externalBin sidecars**. The **only**
> thing not bundled is the **AI models** (large, language-dependent), which are
> downloaded on **first run** via an in-app wizard.

---

## What's bundled vs. downloaded

```
┌──────────────────────── VideoDubber installer (.dmg / .msi / .deb / AppImage) ────────────────────────┐
│                                                                                                        │
│   Tauri 2 shell  ──────────────────────────────────────────────────────────────────────────────────┐ │
│   (native window + auto-updater + sidecar lifecycle)                                                 │ │
│                                                                                                       │ │
│   Angular 18 UI  (frontendDist, compiled into the app)                                                │ │
│                                                                                                       │ │
│   ┌──────────────────────────── bundle.externalBin SIDECARS (frozen binaries) ───────────────────────┐│ │
│   │  videodubber-orchestrator   Node SEA single-exe        :5100   (pipeline brain)                   ││ │
│   │  vd-stt-worker              PyInstaller (faster-whisper):5101   (speech-to-text)                  ││ │
│   │  vd-translation-worker      PyInstaller (Argos)        :5102   (machine translation)              ││ │
│   │  vd-tts-worker              PyInstaller (Piper/fallback):5103   (text-to-speech)                   ││ │
│   │  ffmpeg / ffprobe           static, libass-enabled             (probe/extract/mix/render/burn-in) ││ │
│   └───────────────────────────────────────────────────────────────────────────────────────────────┘│ │
│                                                                                                       │ │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
                                                                                                        │
        DOWNLOADED ON FIRST RUN (NOT in the installer) — large + language-dependent:                    │
          • faster-whisper model (tiny … large-v3)   -> HuggingFace cache (~/.cache/huggingface)         │
          • Argos language packages (e.g. en→vi)      -> argostranslate user-data dir                    │
          • Piper voices (.onnx + .onnx.json)         -> ~/VideoDubber/models/piper                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**End users need NO Python, Node, or FFmpeg preinstalled.** Everything required
to run is inside the app bundle.

### Why models are not bundled

A single Whisper `large-v3` is ~3 GB; each language pair and voice adds more.
Bundling every combination would make a multi-gigabyte installer that's mostly
dead weight for any one user. Instead the app ships small and the **first-run
wizard** fetches exactly the model(s) for the languages the user picks.

---

## Approximate sizes

| Component | Approx. size | Notes |
|---|---|---|
| Installer (shell + UI + sidecars, no models) | ~150–300 MB | Dominated by PyInstaller workers (ctranslate2, stanza) + ffmpeg. |
| faster-whisper `base` | ~145 MB | Recommended starter; `small` ~480 MB. |
| faster-whisper `large-v3` | ~3 GB | Best quality; CPU-heavy. |
| One Argos pair (e.g. en→vi) | ~100–200 MB | Per language pair. |
| One Piper voice (medium) | ~60–75 MB | `.onnx` + `.onnx.json`. |

So a typical first-run footprint (base Whisper + one Argos pair + one Piper voice)
is roughly **300–500 MB of models** on top of the installed app.

---

## The first-run wizard

On boot the shell calls `setup_get_status`. If `firstRunComplete` is `false`, the
UI routes to the **onboarding wizard** (`/welcome`) instead of Home:

1. **Welcome** — what the app is and what's about to happen (a one-time download).
2. **Self-check** — `setup_preflight` verifies the bundled sidecars answer
   `/health` (orchestrator + 3 workers), ffmpeg/ffprobe run, network is reachable,
   and there's enough free disk in the models dir. Each check shows
   ok/warn/fail + a remediation hint; a **Re-check** button re-runs it.
3. **Choose** — source + target language(s), a Whisper model (catalog defaults to
   the recommended one), and whether to fetch a Piper voice for the target.
4. **Download** — `setup_install_models` starts an async install; the UI subscribes
   to the orchestrator's setup SSE channel (`/setup/events`) and shows per-item
   progress bars + a live log. On `done` it calls `setup_complete` (which writes
   `firstRunComplete=true`) and navigates Home.

The install steps (run by the orchestrator):

1. Ensure the Whisper model via the STT worker (`POST /models/ensure`) — triggers
   a download into the HuggingFace cache.
2. Ensure each Argos pair via the Translation worker (`POST /packages/ensure`).
3. Download each Piper voice (`.onnx` + `.onnx.json`) into
   `~/VideoDubber/models/piper` (streamed by the orchestrator, percent from
   `Content-Length`).

State lives in `<config>/setup.json` (see **Storage** below), so the wizard only
appears once. Users can fetch more languages/voices later from Settings.

---

## Production sidecar lifecycle

`apps/desktop/src-tauri/src/sidecar.rs` has two paths:

* **Dev path** (source checkout present — detected by `pnpm-workspace.yaml`):
  launches `scripts/start-services.sh` (workers run from their venvs). This is the
  current `pnpm app` behavior and is unchanged.
* **Production path** (bundled app — no source tree; or `VIDEODUBBER_BUNDLED=1`):
  launches the **externalBin sidecars** via the Tauri shell plugin's `sidecar()`
  API. For each child the shell sets:
  * ports (`ORCHESTRATOR_PORT=5100`, `STT_PORT=5101`,
    `TRANSLATION_WORKER_PORT=5102`, `TTS_WORKER_PORT=5103`),
  * `FFMPEG_PATH` / `FFPROBE_PATH` -> the bundled ffmpeg/ffprobe sidecars,
  * model directories (HF cache, Argos packages dir, `~/VideoDubber/models/piper`),
  * `VIDEODUBBER_CONFIG_DIR` (the app config dir).

  Child handles are tracked and **terminated on app exit**, exactly like the dev
  path's process-group teardown.

On a clean machine the orchestrator + workers come up as frozen binaries; the UI
reports their health via `GET /workers/health`. The webview connects directly to
`http://127.0.0.1:5100` for HTTP + SSE (the shell does not proxy SSE).

---

## Storage layout (production)

| Path | Contents |
|---|---|
| `<config>` = `$VIDEODUBBER_CONFIG_DIR` or `~/VideoDubber` | App config/state root. |
| `<config>/setup.json` | First-run state (`firstRunComplete`, installed models). |
| `<config>/preferences.json` | User preferences (e.g. `autoUpdate`). |
| `~/VideoDubber/models/piper` | Downloaded Piper voices. |
| `~/.cache/huggingface` | faster-whisper model cache (HF default). |
| argostranslate user-data dir | Installed Argos `.argosmodel` packages. |
| `~/VideoDubber/projects` | Per-project workspaces (unchanged from dev). |

Uninstalling the app does **not** delete `~/VideoDubber` or the model caches —
re-installing reuses already-downloaded models (no second first-run download).

---

## Building the installers

See **[`docs/RELEASING.md`](RELEASING.md)** for the full runbook. In short:

```bash
# Build every sidecar for the current host triple into
# apps/desktop/src-tauri/binaries/, then bundle the installer.
pnpm package:sidecars
pnpm app:build
```

In CI, `.github/workflows/release.yml` does this on a macOS-arm64 / macOS-x64 /
Windows / Linux matrix and publishes a draft GitHub Release with the installers
and the auto-updater `latest.json`.

Related docs:

* **[`AUTOUPDATE.md`](AUTOUPDATE.md)** — how the in-app updater works.
* **[`DESKTOP_APP.md`](DESKTOP_APP.md)** — the simple install & use guide.
* **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — components, pipeline, data model.
