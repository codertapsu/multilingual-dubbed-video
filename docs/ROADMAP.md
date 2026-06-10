# Roadmap

VideoDubber's MVP delivers a complete local/offline-first dubbing pipeline (probe →
extract-audio → STT → translation → TTS → alignment → audio-mix → render) with a dual
browser/Tauri UI. This document tracks where it's headed. Items are roughly ordered by
expected effort/impact, not by commitment date.

> Guiding principles, unchanged: **local-first**, **cost-first**, **private by
> default**, and **consent + legal review before anything involving real people's
> voices**.

---

## Near term

### Speaker diarization
Detect *who* is speaking and segment the transcript per speaker, so multi-speaker videos
aren't flattened into a single voice. Annotate `TranscriptSegment.speakerId` (already in
the data model) using a local diarization model.

### Narrator / speaker → voice selection
Let users map each detected speaker (or a single narrator) to a chosen TTS voice, with
per-speaker voice/pitch/speed settings. Surfaces in the segment editor and persists in
`ProjectSettings`.

### Subtitle styling editor
A visual editor for `SubtitleStyle` (font, size, colors, outline, alignment) with live
preview for burned-in subtitles, beyond the current settings fields.

---

## Audio quality

### Source separation (Demucs / UVR)
Split the original audio into stems (vocals vs. music/effects) so the dub can replace
**only** the speech while preserving music and ambience — a real upgrade over volume
ducking. Likely an optional local model step before audio-mix, given its compute cost.

### GPU acceleration
Optional CUDA / Metal acceleration for faster-whisper (and any future local models) to
cut STT/diarization time on capable machines, while keeping the int8 CPU path as the
universal default.

---

## Scale & throughput

### Batch processing
Queue multiple videos (or a folder) with shared settings and run them sequentially,
reusing the resumable per-project workspaces. Useful for series/playlists.

---

## Quality (opt-in cloud)

### Cloud-enhanced high-quality mode
Wire up the placeholder cloud adapters (`providers/cloudPlaceholders.ts`) into a true
`cloud-enhanced` `processingMode` — per-step, key-gated opt-in for higher-quality STT /
MT / TTS where it matters. Always optional; local remains the default and the fallback.
Data-flow and minimization rules are documented in [`PROVIDERS.md`](PROVIDERS.md).

---

## Sensitive / gated

### Voice cloning — with consent & legal review
Cloning a real person's voice is **deliberately excluded today**. Any future support
would require, at minimum:

- **Explicit, documented consent** from the person whose voice is involved.
- A **legal review** of jurisdiction-specific rights (publicity, likeness, biometric
  voiceprint laws).
- Safeguards against impersonation/misuse.

Until those gates exist, VideoDubber uses only generic TTS voices. See the disclaimer in
the [README](../README.md#legal--usage-disclaimer).

---

## Packaging & distribution

### Installer packaging (Tauri sidecars / bundling) — **scaffolded**
**Done:** the desktop shell **auto-starts the backend on launch and stops it on quit**
(`src-tauri/src/sidecar.rs`, on by default; `VIDEODUBBER_MANAGE_SERVICES=0` to disable),
in both a **dev** path (source checkout, Node + Python venvs) and a **production** path
that launches the bundled sidecars.

**Scaffolded:** a fully self-contained, one-click installer that **embeds** the Node
orchestrator (Node SEA) and the three Python workers (PyInstaller) **and**
libass-enabled FFmpeg/ffprobe as Tauri `bundle.externalBin` sidecars — end users need
**no** Python/Node/FFmpeg preinstalled. The only thing not bundled is the AI **models**,
downloaded on **first run** by an in-app wizard.

- Build scripts: [`scripts/package/`](../scripts/package/) (`build-sidecars.{sh,ps1}` →
  `build-orchestrator`, `build-workers` + PyInstaller `.spec`s, `fetch-ffmpeg`). Run
  with `pnpm package:sidecars`.
- CI: [`.github/workflows/release.yml`](../.github/workflows/release.yml) — on a `v*`
  tag, a macOS-arm64 / macOS-x64 / Windows / Linux matrix builds the sidecars + bundles
  the installers and publishes a **draft** GitHub Release with the updater `latest.json`.
- Docs: [`PRODUCTION.md`](PRODUCTION.md), [`RELEASING.md`](RELEASING.md).

**Remaining hardening:** generate + commit the real app icons (`pnpm tauri icon`);
provision the **code-signing certificates** (Apple Developer ID + notarization, Windows
Authenticode) as CI secrets; generate the **updater keypair** and set the real
endpoint/pubkey; first end-to-end signed release per OS.

### Auto-update (GitHub Releases) — **scaffolded**
**Scaffolded:** in-app auto-update via the official `tauri-plugin-updater`, reading a
signed `latest.json` from GitHub Releases. Users toggle **automatic** vs. **manual**
updates and can check/install on demand (**Settings → Updates**); updates are
signature-verified on-device before install.

- Config: `tauri.conf.json` `plugins.updater` (endpoint + pubkey) +
  `bundle.createUpdaterArtifacts`.
- Docs: [`AUTOUPDATE.md`](AUTOUPDATE.md).

**Remaining hardening:** generate the signing keypair (`pnpm tauri signer generate`),
replace the endpoint/pubkey placeholders, and ship the first published release so the
updater endpoint resolves.

---

## Engine upgrades (implemented)

A deep, web-verified survey of the mid-2026 on-device AI landscape lives in
[`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md) (per-hardware-tier stack table,
maximum-quality fully-local EN→VI pipeline, license traps). Its roadmap is now
implemented as the **engine-pack** system + hardware-aware recommendations — see
[`PROVIDERS.md`](PROVIDERS.md#engine-packs):

- **Accelerated STT** — `whisper-cpp` provider (Metal/CUDA/Vulkan packs); batched
  faster-whisper + VAD; `large-v3-turbo` is the new recommended model; PhoWhisper
  for Vietnamese-source audio.
- **Local LLM translation** — `ollama` (keyless daemon) and `llama-cpp` (engine
  pack) providers speaking the OpenAI dialect (TranslateGemma/Qwen/Gemma);
  duration-aware prompts; per-segment raw-MT mode.
- **Neural TTS** — `neural-tts` engine pack (Kokoro / VieNeu / Chatterbox /
  Qwen3-TTS), including the Vietnamese VieNeu upgrade over Piper.
- **Vocal separation** — `separation-audio` engine pack powering the
  “replace voices, keep music & effects” mix mode; two-pass loudnorm.
- **Forced alignment + diarization** — `alignment-whisperx` engine pack for
  ±50 ms word timing and per-speaker voices.
- **Render** — opt-in hardware encode (VideoToolbox/NVENC); Rubber Band
  time-stretch helpers for natural speech above ~1.3×.

The orchestrator's EngineManager downloads packs on demand, runs them as managed
local servers, and sequences heavy engines to fit memory.

Still binary-dependent (wired, runs once the relevant binary/model lands): the
pinned download checksums in the catalog, and Rubber Band subprocess execution
(the decision + argv are implemented and tested; `atempo` is the default until a
`rubberband` binary is present).

---

## Ideas backlog

- Glossary / terminology management UI (the translation worker already accepts a
  `glossary`).
- Alternative local MT/TTS engines as additional providers (see
  [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md) for the vetted list).
- Per-segment re-translation suggestions and confidence-driven review queues.
- Export presets (platform-specific resolutions/bitrates) for `render`.

Have a request? Open an issue describing the use case.
