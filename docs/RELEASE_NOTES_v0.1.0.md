# VideoDubber v0.1.0

The first public release of **VideoDubber** — a local/offline-first desktop app
that dubs videos into another language. Transcription, translation, and voice
synthesis run **on your machine**; only the AI models download on first run.

## Download

Pick the installer for your OS.

| OS | Installer | First launch |
|---|---|---|
| **macOS — Apple Silicon** | `VideoDubber_0.1.0_aarch64.dmg` | Not yet notarized — **one-time unlock** (see *macOS first launch* below). |
| **Windows (x64)** | `VideoDubber_0.1.0_x64-setup.exe` (or `_x64_en-US.msi`) | Unsigned build: SmartScreen → **More info → Run anyway**. |
| Linux (x64) | `VideoDubber_0.1.0_amd64.AppImage` / `.deb` | _Coming shortly_ — `chmod +x *.AppImage` then run, or `sudo dpkg -i *.deb`. |
| macOS — Intel (x64) | `VideoDubber_0.1.0_x64.dmg` | _Coming shortly_ — same one-time unlock. |

No Python, Node, or FFmpeg needed — the installer bundles the app, the pipeline
engine, the speech/translation/voice workers, and FFmpeg.

### macOS first launch

This build isn't notarized by Apple yet, so macOS quarantines it (*"VideoDubber
cannot be opened because Apple cannot check it for malicious software"*). Clear it
**once**:

1. Open the `.dmg` and drag **VideoDubber** into **Applications**.
2. Open **Terminal** (⌘ Space → type `Terminal` → Return).
3. Paste and run:
   ```sh
   xattr -dr com.apple.quarantine /Applications/VideoDubber.app
   ```
4. Open VideoDubber from Applications normally — you won't need to repeat this.

The old "right-click → Open" no longer works on macOS Sequoia (15)+. A future
signed + notarized build removes this step.

### Checksums (SHA-256)

```
35ace879aaaa81f770e829bcf3f5371a07e467d1cd3bb2d96c8edaab43415986  VideoDubber_0.1.0_aarch64.dmg
72fb89a71d1592f1d0b8d70ac2e4801d2f37c6515d5eb6a6f0e064bb0f12bd53  VideoDubber_0.1.0_x64-setup.exe
0385c14ebabf0641dadb71617c3bfe0edbcdb3918568f3d538f5452a92df40d2  VideoDubber_0.1.0_x64_en-US.msi
```

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
- **Signing/notarization:** this build is unsigned/un-notarized, so macOS
  Gatekeeper and Windows SmartScreen show a first-launch warning. macOS: do the
  one-time **macOS first launch** unlock above (Sequoia removed the old
  right-click → Open shortcut). Windows: **More info → Run anyway**. A signed +
  notarized macOS build will let it open with a plain double-click.
- **Auto-update** is off in v0.1.0; update by downloading a newer release. It
  activates in a later release once builds ship a signed `latest.json`.

See the [README](https://github.com/codertapsu/multilingual-dubbed-video) and
[docs](https://github.com/codertapsu/multilingual-dubbed-video/tree/main/docs)
for details.
