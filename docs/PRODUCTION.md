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
│   │  vd-piper                   PyInstaller (piper-tts CLI)         (neural TTS, spawned per segment)  ││ │
│   │  ffmpeg / ffprobe           static, libass-enabled             (probe/extract/mix/render/burn-in) ││ │
│   └───────────────────────────────────────────────────────────────────────────────────────────────┘│ │
│                                                                                                       │ │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
                                                                                                        │
        DOWNLOADED ON DEMAND (NOT in the installer) — large + machine-dependent:                        │
          • faster-whisper model (tiny … large-v3-turbo) -> HuggingFace cache (~/.cache/huggingface)     │
          • Argos language packages (e.g. en→vi)      -> argostranslate user-data dir                    │
          • Piper voices (.onnx + .onnx.json)         -> ~/VideoDubber/models/piper                      │
          • ENGINE PACKS (Settings → Engines, optional, for capable machines):                           │
              whisper.cpp (Metal/CUDA/Vulkan)  ·  llama.cpp + local LLM  ·  neural TTS                    │
              vocal separation  ·  forced alignment + diarization        -> ~/VideoDubber/engines        │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**End users need NO Python, Node, or FFmpeg preinstalled.** Everything required
to run is inside the app bundle.

### Why models (and heavy engines) are not bundled

A single Whisper `large-v3` is ~3 GB; each language pair and voice adds more, and
the optional accelerated/neural engines are larger still. Bundling every
combination would make a multi-gigabyte installer that's mostly dead weight for
any one user. Instead the app ships small and:

- the **first-run wizard** fetches exactly the model(s) for the languages picked;
- **engine packs** (Settings → Engines) download only the higher-quality engines
  a given machine can use, verified and run on demand — see
  [`PROVIDERS.md`](PROVIDERS.md#engine-packs). The base app always works on the
  bundled CPU engines; packs are purely additive.

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

### What a brand-new user has to do (nothing preinstalled)

1. **Install** — drag the app from the `.dmg` (macOS) / run the `.msi`/`.exe`
   (Windows) / `.deb`/AppImage (Linux). No Python, Node, FFmpeg, or anything else
   is required first.
2. **Open it** — the backend (orchestrator + workers + ffmpeg) auto-starts.
3. **Follow the wizard** — pick languages, click **Download**; it fetches just the
   models for those languages. That's the entire required setup; the app can now
   dub fully offline.
4. **(Optional) Settings → Engines** — install higher-quality engine packs for a
   capable machine. These are **self-contained**: native engines are downloaded
   binaries, and the Python engines use the **bundled `uv`** (which fetches its
   own Python), so there is still **nothing to preinstall**. The screen detects
   what each engine needs and guides you; a pack that can't run yet is disabled
   with an explanation rather than failing.

The only thing the user ever needs is an **internet connection** for the
downloads — everything is obtained through the app's UI.

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
  * `PIPER_BINARY_PATH` -> the bundled `vd-piper` CLI and `PIPER_VOICES_DIR` ->
    `<config>/models/piper` (so the TTS worker speaks with the language-matched
    Piper voice instead of falling back to the OS default voice),
  * model directories (HF cache, Argos packages dir, `~/VideoDubber/models/piper`),
  * `VIDEODUBBER_CONFIG_DIR` (the app config dir).

  Child handles are tracked and **terminated on app exit**, exactly like the dev
  path's process-group teardown.

On a clean machine the orchestrator + workers come up as frozen binaries; the UI
reports their health via `GET /workers/health`. The webview connects directly to
`http://127.0.0.1:5100` for HTTP + SSE (the shell does not proxy SSE).

### Engine packs (optional, downloaded later)

Installed engine packs are **not** bundled sidecars — the orchestrator's
`EngineManager` owns their lifecycle. When a project selects a pack-backed
provider (accelerated whisper.cpp, local-LLM translation, neural TTS, vocal
separation, forced alignment), the orchestrator starts that pack's server on a
free loopback port, health-waits it, and runs it for that phase; because the
dubbing pipeline is sequential, it **unloads other heavy engines first** so a
single machine isn't overcommitted. All engine processes are stopped when the
orchestrator shuts down (which happens when the app quits). Nothing engine-pack
related runs until the user installs a pack and a project uses it.

---

## Storage layout (production)

| Path | Contents |
|---|---|
| `<config>` = `$VIDEODUBBER_CONFIG_DIR` or `~/VideoDubber` | App config/state root. |
| `<config>/setup.json` | First-run state (`firstRunComplete`, installed models). |
| `<config>/preferences.json` | Preferences (auto-update + default per-phase providers). |
| `<config>/credentials.json` | Cloud API keys (owner-only `0600`; optional). |
| `<config>/engines.json` + `<config>/engines/<packId>/` | Installed engine packs + their files. |
| `~/VideoDubber/models/piper` | Downloaded Piper voices. |
| `~/.cache/huggingface` | faster-whisper model cache (HF default). |
| argostranslate user-data dir | Installed Argos `.argosmodel` packages. |
| `~/VideoDubber/projects` | Per-project workspaces (unchanged from dev). |

Uninstalling the app does **not** delete `~/VideoDubber`, the model caches, or
engine packs — re-installing reuses everything already downloaded (no second
first-run download, no re-installing engine packs).

---

## Building the installers

See **[`docs/RELEASING.md`](RELEASING.md)** for the full runbook. In short:

```bash
# Build every sidecar for the current host triple into
# apps/desktop/src-tauri/binaries/, then bundle the installer.
pnpm package:sidecars
pnpm app:build
```

By default every OS is built **locally** on the maintainer's own machines
(`pnpm package:sidecars` then `pnpm app:build`, then upload to the v0.1.0 draft
release via `scripts/package/release-upload.{sh,ps1}`). macOS additionally needs
a mandatory deep-sign + notarize pass after the build — use
`scripts/package/release-macos.sh` (see [`APPLE_SIGNING.md`](APPLE_SIGNING.md)).
CI is **opt-in per OS** via the repo variables `RELEASE_CI_MACOS` /
`RELEASE_CI_WINDOWS` / `RELEASE_CI_LINUX` (all default `false` = local); a `v*`
tag only spins up runners for the OSes whose variable is `true`. See
[`RELEASING.md`](RELEASING.md) for the full runbook.

Related docs:

* **[`AUTOUPDATE.md`](AUTOUPDATE.md)** — how the in-app updater works.
* **[`DESKTOP_APP.md`](DESKTOP_APP.md)** — the simple install & use guide.
* **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — components, pipeline, data model.
