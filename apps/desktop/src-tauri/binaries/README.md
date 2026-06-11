# Tauri externalBin sidecars

This directory holds the **bundled sidecar binaries** that make VideoDubber a
fully self-contained desktop app — end users need **no** Python, Node, or FFmpeg
preinstalled. The installer embeds everything here.

> **Binaries are NOT committed to git** (they are large and platform-specific —
> see the repo `.gitignore`). They are produced by the packaging scripts and, in
> CI, rebuilt fresh on each platform runner before `tauri build`. This folder is
> kept in git via `.gitkeep` so the path always exists.

## What lives here (per platform)

| Base name | Source | Built by |
|---|---|---|
| `videodubber-orchestrator` | Node orchestrator (port 5100), Node SEA single-exe | `scripts/package/build-orchestrator.{sh,ps1}` |
| `vd-stt-worker` | STT worker (faster-whisper, port 5101), PyInstaller | `scripts/package/build-workers.{sh,ps1}` |
| `vd-translation-worker` | Translation worker (Argos, port 5102), PyInstaller | `scripts/package/build-workers.{sh,ps1}` |
| `vd-tts-worker` | TTS worker (Piper/fallback, port 5103), PyInstaller | `scripts/package/build-workers.{sh,ps1}` |
| `vd-piper` | Frozen piper-tts CLI (neural TTS; spawned per segment by the TTS worker) | `scripts/package/build-workers.{sh,ps1}` |
| `vd-uv` | `uv` binary (Astral) — installs the optional Python engine packs and downloads their own Python, so users need nothing preinstalled | `scripts/package/fetch-uv.{sh,ps1}` |
| `ffmpeg` | static, **libass-enabled** FFmpeg | `scripts/package/fetch-ffmpeg.{sh,ps1}` |
| `ffprobe` | static FFprobe | `scripts/package/fetch-ffmpeg.{sh,ps1}` |

Build all of them at once:

```bash
pnpm package:sidecars          # macOS/Linux  (bash scripts/package/build-sidecars.sh)
pwsh scripts/package/build-sidecars.ps1   # Windows
```

## Naming convention — the Rust target triple suffix

Tauri's `bundle.externalBin` references each sidecar by its **base name** (e.g.
`binaries/vd-stt-worker`) and, at bundle time, **appends the Rust target triple**
of the build host. So the files on disk MUST be named:

```
<base>-<target-triple>[.exe]
```

Examples:

```
videodubber-orchestrator-aarch64-apple-darwin
vd-stt-worker-aarch64-apple-darwin
ffmpeg-aarch64-apple-darwin

videodubber-orchestrator-x86_64-pc-windows-msvc.exe
vd-stt-worker-x86_64-pc-windows-msvc.exe
ffmpeg-x86_64-pc-windows-msvc.exe

vd-translation-worker-x86_64-unknown-linux-gnu
ffprobe-x86_64-unknown-linux-gnu
```

Find your host triple with:

```bash
rustc -Vv | grep host      # e.g. "host: aarch64-apple-darwin"
```

The packaging scripts do this automatically. Override with the `TARGET_TRIPLE`
env var / `-TargetTriple` parameter when cross-building.

## How they're launched

* **Dev** (source checkout): the shell runs `scripts/start-services.sh` and the
  workers run from their venvs — these sidecars are not used.
* **Production** (bundled app): `apps/desktop/src-tauri/src/sidecar.rs` detects
  the bundled mode and launches these sidecars via the Tauri shell plugin's
  `sidecar()` API, wiring ports, `FFMPEG_PATH`/`FFPROBE_PATH` to the bundled
  ffmpeg, and the model directories.

See `docs/PRODUCTION.md` for the full self-contained architecture.
