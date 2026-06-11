# VideoDubber v0.1.0

The first public release of **VideoDubber** — a local/offline‑first desktop app
that dubs videos into another language. Transcription, translation, and voice
synthesis run **on your machine**; only the AI models download on first run.

## Download

Pick the installer for your OS from the assets below.

| OS | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `VideoDubber_0.1.0_aarch64.dmg` | Right‑click → **Open** the first launch if it isn't notarized. |
| macOS (Intel) | `VideoDubber_0.1.0_x64.dmg` | Same. |
| Windows | `VideoDubber_0.1.0_x64-setup.exe` / `.msi` | Click through SmartScreen ("More info → Run anyway") if unsigned. |
| Linux | `VideoDubber_0.1.0_amd64.AppImage` / `.deb` | `chmod +x *.AppImage` then run, or `sudo dpkg -i *.deb`. |

No Python, Node, or FFmpeg needed — the installer bundles the app, the pipeline
engine, the speech/translation/voice workers, and FFmpeg.

## Using it

1. Open the app — all local services start automatically.
2. The one‑time **setup wizard** downloads the AI models for the languages you
   choose. After that it works fully offline.
3. Create a project, pick source/target languages, and start dubbing.

## What's inside

- **Speech‑to‑text:** faster‑whisper (batched, VAD, `large‑v3‑turbo` default,
  PhoWhisper for Vietnamese‑source).
- **Translation:** Argos offline by default; optional cloud (OpenAI/Claude/Gemini)
  or local LLM (Ollama / llama.cpp) per phase.
- **Text‑to‑speech:** Piper with per‑language voice selection; optional neural
  voices via engine packs.
- **Mixing/render:** keep‑and‑duck, remove, or **replace‑voices‑keep‑music** mix
  modes; burned‑in/soft/sidecar subtitles.
- **Optional engine packs** (Settings → Engines) for accelerated and
  higher‑quality engines on capable machines — self‑contained (the app bundles
  `uv`; nothing else to install).

## Known limitations

- **Signing/notarization:** this build is unsigned, so macOS Gatekeeper and
  Windows SmartScreen show a first‑launch warning — bypass as noted above
  (right‑click → **Open** on macOS; "More info → Run anyway" on Windows).
- **Auto‑update** is off in v0.1.0; update by downloading a newer release. It
  activates in a later release once builds ship a signed `latest.json`.

See the [README](https://github.com/codertapsu/multilingual-dubbed-video) and
[docs](https://github.com/codertapsu/multilingual-dubbed-video/tree/main/docs)
for details.
