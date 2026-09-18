# Roadmap

VideoDubber delivers a complete local/offline-first dubbing pipeline (probe →
extract-audio → STT → translation → refine → TTS → alignment → audio-mix → render)
with a dual browser/Tauri UI. This document tracks **what has shipped** and **what
is genuinely still open**. Items under "Planned" are roughly ordered by expected
effort/impact, not by commitment date.

> Guiding principles, unchanged: **local-first**, **cost-first**, **private by
> default**, and **consent + legal review before anything involving real people's
> voices**.

> **Read this section if you are planning work.** Until 2026-09 this file listed
> auto-update, the self-contained installer, batch processing and cloud-enhanced
> mode as "scaffolded" or future work — all four had shipped, some of them four
> releases earlier — and listed source separation and diarization under a heading
> called "Engine upgrades (implemented)" when neither has any worker code at all.
> Planning off the old text mis-scheduled in both directions. The split below
> exists so that cannot recur: if you ship something, move it up; if you find
> something listed as implemented that has no code, move it down.

---

## Shipped

| Feature | Since | Where it's documented |
|---|---|---|
| **Self-contained installers** — the Tauri shell, Angular UI, Node orchestrator (Node SEA), the three PyInstaller Python workers, a bundled CPython, `vd-piper`, `vd-uv` and a libass FFmpeg all ship as `bundle.externalBin` / `bundle.resources`. End users need no Python, Node or FFmpeg. | v0.1.0 | [`PRODUCTION.md`](PRODUCTION.md), [`RELEASING.md`](RELEASING.md) |
| **macOS Developer ID signing + notarization** — a mandatory deep-sign pass signs every bundled Mach-O, then notarizes and staples. | v0.1.0 | [`APPLE_SIGNING.md`](APPLE_SIGNING.md) |
| **In-app auto-update** via `tauri-plugin-updater`, reading a signed `latest.json` from GitHub Releases; auto vs. manual is a user setting and updates are signature-verified on-device before install. | **v0.2.0** | [`AUTOUPDATE.md`](AUTOUPDATE.md) |
| **Engine packs** — downloadable, hardware-gated optional engines (accelerated whisper.cpp, llama.cpp + local LLM, neural TTS), installed on demand and run only while a project uses them. Packs a machine cannot run are hidden rather than offered. | v0.3.0 | [`PROVIDERS.md`](PROVIDERS.md#engine-packs), [`ENGINE_PACKS.md`](ENGINE_PACKS.md) |
| **Bundled default-pair models** (`BUNDLE_DEFAULT_MODELS=1`) for an offline out-of-box first dub, on macOS and Windows. | v0.3.0 | [`PRODUCTION.md`](PRODUCTION.md) |
| **Batch processing / run queue** — queue several dubs, admitted and bounded by what the machine can actually take, with a user-visible limit and pause. | v0.4.0 | [`RUN_QUEUE.md`](RUN_QUEUE.md) |
| **Context-aware translation** — character sheet, glossary, xưng hô plan, offline context-repair tiers, per-speaker voice assignment, duration-aware prompts. | v0.4.0 | [`DUBBING_QUALITY.md`](DUBBING_QUALITY.md) |
| **Review & Refine step** — an optional AI transcript-review checkpoint between translation and TTS (the 5th of the nine steps), plus voice-synced subtitles. | v0.4.0 | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **Cloud-enhanced mode** — per-phase, per-key opt-in to OpenAI / Anthropic / Gemini with on-device key storage and Test buttons. Local remains the default and the fallback. | v0.4.0 | [`PROVIDERS.md`](PROVIDERS.md) |
| **Gemma 4 chat-model packs** (Apache-2.0) + the new turn/channel prompt grammar. | v0.4.0 | [`PROVIDERS.md`](PROVIDERS.md) |
| **Backend-down recovery UI** — tell the user when the backend is down and offer the restart that fixes it. | v0.5.0 | — |
| **llama.cpp engine diagnostics** — capture *why* an engine will not start (`diagnose-llama-engine.ps1`). | v0.6.0 | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| **English + Vietnamese UI** — the app is fully localized and switchable at runtime (Settings → Language); `scripts/check-i18n.mjs` gates missing keys in the desktop package's `test` script. | **v0.8.0** | [`USER_GUIDE.md`](USER_GUIDE.md#6-settings) |
| **Update notifications** — tell the user a new version exists. | v0.8.0 | [`AUTOUPDATE.md`](AUTOUPDATE.md) |
| **Video downloader** — fetch a source video from **Bilibili** or **Douyin**, with a quality target across Bilibili's two pipes and an optional per-provider session cookie. Adding a source is a two-line `SourceProvider` registration. | **v0.9.0** | [`USER_GUIDE.md`](USER_GUIDE.md#5-downloading-a-source-video), [`PROVIDERS.md`](PROVIDERS.md) |

### Long videos (30–120 min+)

Hours-long inputs are handled, not just short clips: STT is transcribed in bounded,
checkpointed, resumable windows with per-chunk progress; TTS synthesis and local-LLM
translation run with bounded concurrency; cloud translation batches by a character
budget; alignment probes are individually timed out and report progress; and the
long-video audio-mix path guards against temp-disk exhaustion. Full description in
[`ARCHITECTURE.md`](ARCHITECTURE.md#long-video-handling).

**Remaining (optional):** a persistent/batch Piper process (synthesize many segments
in one model-resident invocation) on top of the existing thread-pool parallelism, and
ndjson streaming of the aligned-segment artifact beyond a few thousand segments.

### Accelerated engines that shipped

The survey in [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md) became the
engine-pack system plus hardware-aware recommendations — see
[`PROVIDERS.md`](PROVIDERS.md#engine-packs):

- **Accelerated STT** — `whisper-cpp` provider (CUDA/Vulkan packs); batched
  faster-whisper + VAD; `large-v3-turbo` is the recommended model; PhoWhisper
  for Vietnamese-source audio.
- **Local LLM translation** — `ollama` (keyless daemon) and `llama-cpp` (engine
  pack) providers speaking the OpenAI dialect (TranslateGemma / Gemma);
  duration-aware prompts; per-segment raw-MT mode.
- **Neural TTS** — the `tts-neural` engine pack, which is **VieNeu-TTS v3-Turbo,
  Vietnamese only**. (The old text here claimed "Kokoro / VieNeu / Chatterbox /
  Qwen3-TTS"; none of Kokoro, Chatterbox or Qwen3-TTS exists anywhere in this
  repo, and a non-Vietnamese user who installed the ~1.5 GB pack on the strength
  of that sentence got an engine that only speaks Vietnamese.)
- **Render** — opt-in hardware encode (VideoToolbox/NVENC); Rubber Band
  time-stretch helpers for natural speech above ~1.3×.

The orchestrator's EngineManager downloads packs on demand, runs them as managed
local servers, and sequences heavy engines to fit memory. Pack download URLs are
pinned to verified upstream releases **with sha256 checksums**.

**Remaining:** Rubber Band subprocess execution (the decision + argv are
implemented and tested; `atempo` is the default until a `rubberband` binary is
present).

---

## Planned — not built

### Speaker diarization — **not built**

Detect *who* is speaking and segment the transcript per speaker, so multi-speaker
videos aren't flattened into a single voice, annotating `TranscriptSegment.speakerId`
(already in the data model).

**Status: no implementation exists.** The `alignment-whisperx` pack is defined in
the catalog but sits in `DISABLED_PACK_IDS` because its worker server (`vd_whisperx`)
is an unimplemented stub — there is no `workers/` directory for it. It is withheld
from Settings → Engines so nobody can install a pack that would never become
healthy. The *consumer* side is ready (per-speaker voice selection, group
partitioning), so the missing piece is the model runtime only.

Design notes live in [`DUBBING_QUALITY.md`](DUBBING_QUALITY.md); the leading
candidate is a small Rust sidecar rather than the 3 GB, HuggingFace-gated
pyannote/whisperx venv the catalog entry currently describes.

### Source separation (music vs. voice) — **not built**

Split the original audio into stems so the dub can replace **only** the speech
while preserving music and ambience — a real upgrade over volume ducking.

**Status: no implementation exists.** Same shape as diarization: the
`separation-audio` pack is defined, its worker (`vd_separator`) is a stub, and the
pack is in `DISABLED_PACK_IDS`. The runner already has the fallback path for when
separation is absent, which is what ships today.

### Subtitle styling editor

A visual editor for `SubtitleStyle` (font, size, colors, outline, alignment) with
live preview for burned-in subtitles, beyond the current settings fields.

### Windows code signing

Windows installers are **unsigned**: `bundle.windows` exists in `tauri.conf.json`
but carries no signing fields (no `certificateThumbprint`, no `signCommand`), and
nothing in the local release script signs anything either. Every
Windows user therefore meets SmartScreen's "Unknown publisher" panel on each
hand-downloaded install. Buying a certificate is a maintainer decision, not a code
change — see [`RELEASING.md`](RELEASING.md#windows-code-signing-not-configured).

### Linux packaging

Linux ships nothing today and cannot: `bundle.targets` contains no Linux package
type (so a Linux `tauri build` exits 0 having bundled nothing), there is no
`bundle.linux` config, no `release-linux.sh`, and `merge-latest-json.mjs` has no
Linux platform key. Shipping Linux is a project — targets, `deb.depends`, a glibc
floor policy, a build machine or container, a release script and a manifest key —
not a config tweak.

### Intel macOS

Also nothing: the macOS release script hardcodes `aarch64`, no release has ever
carried an `_x64.dmg`, and the CI fallback that could build one targets the retired
`macos-13` runner. Given Apple ships no Intel hardware, the honest options are to
drop it explicitly or to commit to it and note the August 2027 runner cutoff.

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

## Ideas backlog

- Glossary / terminology management UI (the translation worker already accepts a
  `glossary`).
- Alternative local MT/TTS engines as additional providers (see
  [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md) for the vetted list).
- Per-segment re-translation suggestions and confidence-driven review queues.
- Export presets (platform-specific resolutions/bitrates) for `render`.
- A third UI locale (the i18n plumbing and the `check-i18n.mjs` gate already exist).

Have a request? Open an issue describing the use case.
