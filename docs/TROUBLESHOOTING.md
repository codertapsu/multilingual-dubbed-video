# Troubleshooting

When something fails, VideoDubber returns a structured `AppError` with a `code`, a
`message`, a `remediation`, and a `docsRef` that points at an anchor on this page. This
doc lists **every** error code, then covers common environment issues.

> Worker error shape (JSON, with an appropriate HTTP status):
> ```json
> { "error": { "code": "...", "message": "...", "remediation": "...", "docsRef": "TROUBLESHOOTING.md#<anchor>" } }
> ```

---

## Error code reference

| Code | What failed | Likely why | How to fix | Doc |
|---|---|---|---|---|
| `FFMPEG_NOT_FOUND` | ffmpeg couldn't be launched | Not installed / not on PATH / bad `FFMPEG_PATH` | Install ffmpeg or set `FFMPEG_PATH` | [LOCAL_SETUP](LOCAL_SETUP.md#3-ffmpeg--ffprobe) |
| `FFPROBE_NOT_FOUND` | ffprobe couldn't be launched | Same as above, for ffprobe | Install ffmpeg (ships ffprobe) or set `FFPROBE_PATH` | [LOCAL_SETUP](LOCAL_SETUP.md#3-ffmpeg--ffprobe) |
| `PYTHON_NOT_FOUND` | Python interpreter missing | No Python / wrong `PYTHON_PATH` | Install Python 3.11–3.13 or set `PYTHON_PATH` | [LOCAL_SETUP](LOCAL_SETUP.md#2-python-workers-per-worker-venvs) |
| `STT_MODEL_MISSING` | faster-whisper model unavailable | Not cached and can't download | Pre-cache the model; check `FASTER_WHISPER_MODEL` | [MODEL_SETUP](MODEL_SETUP.md#1-faster-whisper-speech-to-text) |
| `TRANSLATION_PACKAGE_MISSING` | No Argos package for the pair | Pair not installed / not published | `argospm install translate-<from>_<to>`; pick a supported pair | [MODEL_SETUP](MODEL_SETUP.md#2-argos-translate-machine-translation) |
| `PIPER_MISSING` | Piper binary not usable | `PIPER_BINARY_PATH` unset/invalid | Install the Piper binary + set the path, or use the fallback engine | [MODEL_SETUP](MODEL_SETUP.md#3-piper-text-to-speech) |
| `TTS_VOICE_MISSING` | No voice for the language | No matching `.onnx` in `PIPER_VOICES_DIR` / bad `PIPER_VOICE_MODEL_PATH` | Download a voice `.onnx`+`.onnx.json` for the target language | [MODEL_SETUP](MODEL_SETUP.md#3-piper-text-to-speech) |
| `UNSUPPORTED_MEDIA` | Input can't be probed/decoded | Corrupt / unsupported container or codec | Re-encode to a standard MP4/MKV; verify with `ffprobe` | [#unsupported_media](#unsupported_media) |
| `NO_AUDIO_STREAM` | No audio to transcribe | Video has no audio track | Use a video with audio, or add a track | [#no_audio_stream](#no_audio_stream) |
| `INVALID_LANGUAGE` | Bad/unsupported language code | Typo or unknown locale | Use a valid code (e.g. `en`, `vi-VN`); see normalization rules | [#invalid_language](#invalid_language) |
| `OUTPUT_NOT_WRITABLE` | Can't write output/workspace | Permissions / missing dir / disk full | Fix permissions; ensure `VIDEODUBBER_PROJECTS_DIR` is writable; free space | [#output_not_writable](#output_not_writable) |
| `WORKER_UNAVAILABLE` | A worker didn't respond | Worker not started / wrong port / crashed | Start the worker; check the `*_WORKER_URL`; read `.dev-logs/` | [#worker_unavailable](#worker_unavailable) |
| `WORKER_TIMEOUT` | A worker took too long | Large media / slow model / hang | Use a smaller model; retry the step; check worker logs | [#worker_timeout](#worker_timeout) |
| `CANCELLED` | Job was cancelled | User cancelled the pipeline | Expected — re-run when ready (resumes/skips done steps) | [#cancelled](#cancelled) |
| `UNKNOWN` | Unclassified error | Unexpected condition | Read the message + `.dev-logs/`; file an issue with the log | [#unknown](#unknown) |

Each code below has its own anchor so a `docsRef` can deep-link to it.

---

### `FFMPEG_NOT_FOUND`
`ffmpeg` could not be launched. Install FFmpeg for your OS
([LOCAL_SETUP §3](LOCAL_SETUP.md#3-ffmpeg--ffprobe)) or set `FFMPEG_PATH` to the absolute
binary path. Verify with `ffmpeg -version` and re-run `pnpm verify`.

### `FFPROBE_NOT_FOUND`
`ffprobe` could not be launched. It ships with FFmpeg; install FFmpeg or set
`FFPROBE_PATH`. Verify with `ffprobe -version`.

### `FFMPEG_FILTER_MISSING`
Your FFmpeg build lacks a filter the requested operation needs. The common case
is **burned-in subtitles**, which use the `subtitles` filter (libass). Minimal
FFmpeg builds (e.g. Homebrew's default `ffmpeg`) omit libass — check with
`ffmpeg -filters | grep subtitles` (empty = missing). Fixes:
- **Install a libass-enabled FFmpeg.** macOS: `brew install ffmpeg-full`, then point
  the orchestrator at it: `FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`
  `FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe`. Linux: most distro
  `ffmpeg` packages include libass already.
- **Or avoid burning in:** choose subtitle mode `embedded-soft` (a selectable
  `mov_text` track), `srt-file`, or `vtt-file` — none of these need libass.

### `PYTHON_NOT_FOUND`
No usable Python interpreter. Install Python **3.11–3.13** (avoid 3.14 for ML wheels) or
set `PYTHON_PATH` to the interpreter that built the worker venvs. See
[LOCAL_SETUP §2](LOCAL_SETUP.md#2-python-workers-per-worker-venvs).

### `STT_MODEL_MISSING`
The faster-whisper model isn't cached and couldn't be downloaded. Pre-cache it
([MODEL_SETUP §1](MODEL_SETUP.md#1-faster-whisper-speech-to-text)) while online, or set
`FASTER_WHISPER_MODEL` to a model you already have. Check disk space and the HF cache.

### `TRANSLATION_PACKAGE_MISSING`
No Argos Translate package is installed for the requested pair. The error includes the
exact command, e.g. `argospm install translate-en_vi`. Install it
([MODEL_SETUP §2](MODEL_SETUP.md#2-argos-translate-machine-translation)) or choose a
supported pair. Confirm with `curl http://127.0.0.1:5102/languages`.

### `PIPER_MISSING`
`PIPER_BINARY_PATH` is unset or points to a non-runnable binary. Install the Piper binary
and set the path ([MODEL_SETUP §3](MODEL_SETUP.md#3-piper-text-to-speech)). If you don't
want Piper, leave it unset — the TTS worker falls back to system TTS or a silent/sine
WAV automatically.

### `TTS_VOICE_MISSING`
No usable voice for the requested language. Drop a matching `.onnx`/`.onnx.json` voice
into `PIPER_VOICES_DIR` (default `~/VideoDubber/models/piper/`) or set
`PIPER_VOICE_MODEL_PATH` ([MODEL_SETUP §3](MODEL_SETUP.md#3-piper-text-to-speech)).
Confirm with `curl "http://127.0.0.1:5103/voices?language=<lang>"`.

### The dub speaks the wrong language (or is silent)
The TTS worker picks its engine **per target language**: Piper needs a voice whose
filename matches the language (`vi_VN-…onnx` → `vi`), and the OS engine (`say` /
espeak-ng) is only used when the OS actually has a voice for that language. If nothing
can speak the language, segments are written as **silent placeholders** and the
pipeline logs a warning naming the missing voice — install a Piper voice for the
target language and re-run. (Older builds could read Vietnamese text aloud with the
default English system voice; current builds never use a wrong-language voice.) The
`/synthesize-segments` response reports the engine used
(`"engine": "piper" | "system" | "fallback"`).

### `UNSUPPORTED_MEDIA`
The input couldn't be probed or decoded (corrupt file, or a container/codec FFmpeg can't
read). Inspect it with `ffprobe yourfile.ext`. Re-encode to a standard MP4 (H.264 + AAC)
or MKV and retry:
```bash
ffmpeg -i broken.ext -c:v libx264 -c:a aac fixed.mp4
```

### `NO_AUDIO_STREAM`
`extract-audio` found no audio track to transcribe. Confirm with
`ffprobe -show_streams yourfile`. Use a video that contains audio, or mux an audio track
in. Dubbing requires source speech to transcribe.

### `INVALID_LANGUAGE`
A language code is unrecognized. Use BCP-47-style codes such as `en`, `en-US`, `vi`,
`vi-VN`. Normalization rules: codes are trimmed and case-fixed (`EN → en`,
`vi-vn → vi-VN`); the special case **`vi-VI` (any case) normalizes to `vi-VN`**. STT uses
the whisper base subtag (`vi-VN → vi`); translation uses the Argos base subtag
(`vi-VN → vi`).

### `OUTPUT_NOT_WRITABLE`
The workspace or output path can't be written. Ensure `VIDEODUBBER_PROJECTS_DIR`
(default `~/VideoDubber/projects`) and the chosen output directory exist and are
writable, and that the disk isn't full:
```bash
mkdir -p ~/VideoDubber/projects && touch ~/VideoDubber/projects/.write-test && rm ~/VideoDubber/projects/.write-test
df -h ~
```

### `WORKER_UNAVAILABLE`
The orchestrator couldn't reach a worker. Make sure it's running and the matching
`*_WORKER_URL` is correct. See [worker not starting / port in use](#worker-not-starting--port-in-use).
Check health:
```bash
curl -s http://127.0.0.1:5100/workers/health
```

### `WORKER_TIMEOUT`
A worker call exceeded its time budget — usually a large file or a heavy model on CPU.
Try a smaller `FASTER_WHISPER_MODEL`, retry just that step
(`POST /projects/:id/retry { "stepId": "stt" }`), or inspect the worker log in
`.dev-logs/`.

### `CANCELLED`
You cancelled the pipeline (`POST /projects/:id/cancel`). This is expected. Re-running
resumes: completed steps with existing artifacts are skipped.

### `UNKNOWN`
An unclassified error. Read the `message` and the relevant log under `.dev-logs/`
(`orchestrator.log`, `stt-worker.log`, etc.). If it's reproducible, file an issue and
attach the log (secrets are never logged).

---

## Common issues

### ffmpeg / ffprobe not found
Install per OS ([LOCAL_SETUP §3](LOCAL_SETUP.md#3-ffmpeg--ffprobe)) or set
`FFMPEG_PATH` / `FFPROBE_PATH`. `pnpm dev` warns (doesn't fail) at startup if they're
missing; probe/extract/render will then fail with `FFMPEG_NOT_FOUND` /
`FFPROBE_NOT_FOUND`.

### python not found
Install Python 3.11–3.13 or set `PYTHON_PATH`. Recreate worker venvs with
`PYTHON_PATH=python3.13 bash scripts/setup-local-models.sh`. The dev scripts prefer
`workers/<name>/.venv/bin/python`, so building those venvs with a specific Python pins it.

### worker not starting / port in use
Symptoms: `/workers/health` shows a worker unavailable, or uvicorn exits immediately.

- Read the per-worker log: `.dev-logs/stt-worker.log` (and `translation-worker.log`,
  `tts-worker.log`).
- Port already in use? Find and free it:
  ```bash
  lsof -i :5101            # macOS/Linux  (5101/5102/5103 for the workers, 5100 orchestrator)
  kill <PID>
  # Windows:
  netstat -ano | findstr :5101
  taskkill /PID <PID> /F
  ```
- Missing venv? Run `bash scripts/setup-local-models.sh`. The launch scripts warn (not
  fail) when a `.venv` is absent and fall back to `PYTHON_PATH`.

### model missing
See the model error codes above and [`MODEL_SETUP.md`](MODEL_SETUP.md):
`STT_MODEL_MISSING`, `TRANSLATION_PACKAGE_MISSING`, `PIPER_MISSING`, `TTS_VOICE_MISSING`.
Run `pnpm verify` for a model status summary.

### no audio stream
The source video has no audio — see [`NO_AUDIO_STREAM`](#no_audio_stream).

### output not writable
Fix permissions / disk space — see [`OUTPUT_NOT_WRITABLE`](#output_not_writable).

### worker timeout
Heavy model or large file — see [`WORKER_TIMEOUT`](#worker_timeout). Prefer a smaller
whisper model on CPU-only machines.

### CORS / SSE issues
- **Browser dev:** workers and the orchestrator enable CORS for localhost. If the UI
  can't reach the orchestrator, confirm `ORCHESTRATOR_URL` is `http://127.0.0.1:5100`
  and that `/health` responds.
- **SSE not updating:** `GET /projects/:id/events` is a long-lived `text/event-stream`.
  Don't proxy it through anything that buffers responses; ensure no ad/privacy extension
  is blocking `EventSource`. In Tauri, the **webview** opens SSE directly to the
  orchestrator (it is **not** forwarded through Rust) — the `connect-src` CSP in
  `tauri.conf.json` already lists `http://127.0.0.1:5100`.
- **Tauri CSP:** if you change worker ports, update `connect-src` in
  `apps/desktop/src-tauri/tauri.conf.json` to match.

### Tauri build needs Rust + icons
`tauri dev`/`tauri build` require the Rust toolchain (`rustup`, rustc ≥ 1.77.2). A
release **bundle** also needs generated icons:
```bash
pnpm --filter videodubber-desktop tauri icon path/to/source.png
```
See [LOCAL_SETUP §6](LOCAL_SETUP.md#6-rust--tauri-only-for-the-native-desktop-app). The
browser dev mode needs neither Rust nor icons.

### Packaged app shows unstyled UI (CSS not applied)

Symptom: the app works (JS runs, routing works) but has **no styling** in the packaged
build, while `ng serve` looks fine. Cause: Angular's production `inlineCritical`
optimization emits the global stylesheet as
`<link rel="stylesheet" media="print" onload="this.media='all'">`. The inline `onload`
handler is **blocked by the Tauri CSP** (`script-src 'self'`, no `'unsafe-inline'`), so
the stylesheet stays `media="print"` and never applies to the screen. (`ng serve`
enforces no CSP, hence it only shows in the packaged app.)

Fix (already applied): disable critical-CSS inlining in `apps/desktop/angular.json`
production config so a plain render-blocking `<link>` is emitted:
```json
"optimization": { "scripts": true, "styles": { "minify": true, "inlineCritical": false }, "fonts": true }
```
Verify the built `dist/browser/index.html` has a plain `<link rel="stylesheet" …>` with
no `media="print"`/`onload`. (Component styles, injected as inline `<style>`, are fine —
they're covered by `style-src 'unsafe-inline'`.)

### "Could not fetch a valid release JSON" in Settings → Updates

The auto-updater points at `plugins.updater.endpoints` in `tauri.conf.json`, which ships
as the **placeholder** `https://github.com/OWNER/REPO/releases/latest/download/latest.json`.
Until you replace `OWNER/REPO` with your real GitHub repo (and publish a release with a
`latest.json` — see [RELEASING.md](RELEASING.md)), update checks will fail. The app no
longer auto-checks on launch/Settings load, so this only appears if you click **Check for
updates** before configuring a real endpoint. The installed version still shows (it's read
from bundle metadata via `get_app_version`, no network).

### Angular / TypeScript version pin
The Angular workspace pins **TypeScript ~5.5.4** (`apps/desktop/package.json`) because
Angular 18 supports a specific TS range — newer TS may be rejected by the Angular
compiler. The rest of the monorepo uses TS ~5.6.3. Don't bump the desktop app's
TypeScript past what Angular 18 supports; if `ng` complains about an unsupported
TypeScript version, reinstall to honor the pin (`pnpm install`).

---

If a problem isn't covered here, capture the failing `AppError` (its `code` +
`message`) and the relevant `.dev-logs/*.log` and open an issue.
