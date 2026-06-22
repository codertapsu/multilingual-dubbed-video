# VideoDubber v0.1.0

The first public release of **VideoDubber** — a local/offline-first desktop app
that dubs videos into another language. Transcription, translation, and voice
synthesis run **on your machine**; only the AI models download on first run.

## Download

Pick the installer for your OS.

| OS | Installer | First launch |
|---|---|---|
| **macOS — Apple Silicon** | `VideoDubber_0.1.0_aarch64.dmg` | Signed + notarized — **double-click to open**. |
| **Windows (x64)** | `VideoDubber_0.1.0_x64-setup.exe` (or `_x64_en-US.msi`) | Unsigned build: SmartScreen → **More info → Run anyway**. |
| Linux (x64) | `VideoDubber_0.1.0_amd64.AppImage` / `.deb` | _Coming shortly_ — `chmod +x *.AppImage` then run, or `sudo dpkg -i *.deb`. |
| macOS — Intel (x64) | `VideoDubber_0.1.0_x64.dmg` | _Coming shortly_ — signed + notarized, double-click. |

No Python, Node, or FFmpeg needed — the installer bundles the app, the pipeline
engine, the speech/translation/voice workers, and FFmpeg.

### macOS first launch

The macOS build is **signed with an Apple Developer ID and notarized by Apple**,
so it opens with a normal **double-click** — no Terminal, no right-click, no
warning:

1. Open the `.dmg` and drag **VideoDubber** into **Applications**.
2. Open VideoDubber from Applications. Done.

### Checksums (SHA-256)

Regenerated per build — verify your download against the `sha256` on the
[release page](https://github.com/codertapsu/multilingual-dubbed-video/releases),
or compute it locally: `shasum -a 256 VideoDubber_*.dmg`.

## Using it

1. Open the app — all local services start automatically.
2. The one-time **setup wizard** downloads the AI models for the languages you
   choose. After that it works fully offline.
3. Create a project, pick source/target languages, and start dubbing.

## What's inside

- **Speech-to-text:** faster-whisper (batched, VAD, `large-v3-turbo` default,
  PhoWhisper for Vietnamese-source).
- **Translation:** Argos offline by default; optional **TranslateGemma** (built-in
  llama.cpp, or via Ollama) or cloud (OpenAI/Claude/Gemini) per phase.
- **Text-to-speech:** Piper with per-language voice selection; optional neural
  voices via engine packs.
- **Mixing/render:** keep-and-duck, remove, or **replace-voices-keep-music** mix
  modes; burned-in/soft/sidecar subtitles.
- **Optional engine packs** (Settings → Engines) for accelerated and
  higher-quality engines on capable machines — self-contained (the app bundles
  `uv`; nothing else to install).

## Known limitations

- **Platforms:** this release ships **macOS (Apple Silicon)** and **Windows
  (x64)**. Linux (x64) and macOS (Intel) builds are added to this release as they
  finish.
- **Signing/notarization:** the **macOS** builds are Developer-ID signed and
  notarized by Apple, so they open with a plain double-click. **Windows** is not
  yet Authenticode-signed, so SmartScreen shows a first-launch warning — **More
  info → Run anyway** (Windows signing is a later addition).
- **Auto-update** is off in v0.1.0; update by downloading a newer release. It
  activates in a later release once builds ship a signed `latest.json`.

See the [README](https://github.com/codertapsu/multilingual-dubbed-video) and
[docs](https://github.com/codertapsu/multilingual-dubbed-video/tree/main/docs)
for details.
