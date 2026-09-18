# Troubleshooting

When something fails, VideoDubber returns a structured `AppError` with a `code`, a
`message`, a `remediation`, and a `docsRef` that points at an anchor on this page.

**This page serves two audiences and says which is which.**

- **[Using the installed app](#using-the-installed-app)** — you double-clicked an
  installer; you have no checkout, no terminal and no `pnpm`. Start there, and see
  [`USER_GUIDE.md`](USER_GUIDE.md) for everything that is not an error.
- **[Developing from source](#developing-from-source)** — you cloned the repo.
  Anything mentioning `pnpm`, `.dev-logs/`, `argospm` or a `.venv` is for you only.

> **`.dev-logs/` does not exist in an installed build.** It is written by the dev
> launchers (`scripts/dev.sh`, `scripts/start.sh`, `dev-workers.*`) from a source
> checkout, and is git-ignored. In a packaged app the workers' stdio is discarded,
> so there is currently **no log file for an end user to read** — which is itself an
> open gap, not an instruction you can follow. Wherever this page says "check
> `.dev-logs/`", read it as "if you are running from source".

> Worker error shape (JSON, with an appropriate HTTP status):
> ```json
> { "error": { "code": "...", "message": "...", "remediation": "...", "docsRef": "TROUBLESHOOTING.md#<anchor>" } }
> ```

---

## Using the installed app

### Windows: "Windows protected your PC" on the installer

Expected. The Windows installers are **unsigned** — there is no Authenticode
certificate for this project — so SmartScreen shows an "Unknown publisher" panel
whose only visible button is *Don't run*. Click the **More info** text above the
button (it is a link, not a button), then **Run anyway**. You see this once per
hand-downloaded version; updates the app installs for itself do not show it.

### Windows: the app, or one of its files, disappeared after install

Your antivirus quarantined it. VideoDubber has a textbook false-positive profile:
a large unsigned installer, an orchestrator executable that is a copy of `node.exe`
with a blob appended to it, a frozen Python CLI that unpacks executables into
`%TEMP%` for every line it speaks, four localhost HTTP servers on launch, and
runtime downloads of further binaries into your user folder. Nothing there is
malicious and all of it looks unusual to a heuristic scanner.

Symptoms are indistinguishable from a broken app: the installer finishes but
nothing runs, or dubbing fails at the voice step, or an engine-pack download
vanishes.

If you trust this build, add **folder** exclusions for both locations:

- `%LOCALAPPDATA%\VideoDubber` — the installed program.
- `%USERPROFILE%\VideoDubber` — your projects, models and engine packs.

In Windows Security: *Virus & threat protection* → **Manage settings** →
*Exclusions* → **Add an exclusion** → **Folder**.

### The app opens but every service says "unavailable"

Quit fully and reopen first. If it persists:

- **On macOS 14 or 15:** every release up to and including **0.9.0** froze its
  Python workers against a macOS 26 interpreter, so all three workers fail to start
  on an older OS (dyld refuses the extension modules at `import`). The build scripts
  have since been changed to freeze from the bundled portable CPython, but **no
  published release carries that fix yet**.
- **On macOS 13:** unsupported. The app's minimum is **macOS 14.0** — numpy,
  onnxruntime and av publish no Apple-Silicon wheels below `macosx_14_0`.
- **On Windows:** see the antivirus section above.

### Where are my files? How do I uninstall?

Everything lives in `~/VideoDubber` (macOS) or `%USERPROFILE%\VideoDubber`
(Windows), and uninstalling deliberately leaves it in place. See
[`USER_GUIDE.md`](USER_GUIDE.md#7-where-your-files-live) and
[Uninstalling](USER_GUIDE.md#11-uninstalling).

---

## Developing from source

The rest of this page is **not** dev-only — that would send installed-app users
away from the one section the app deep-links them into. The split is by *content*,
not by position:

- **[Error code reference](#error-code-reference)** serves both audiences. It is
  where every `docsRef` in the app lands, and several codes
  (`ENGINE_BUSY`, `RUN_IN_PROGRESS`, `CLOUD_*`, `ENGINE_PACK_*`) are reachable
  *only* from an installed build. Where a code's fix differs, the section says
  which one it is talking about.
- **[Common issues](#common-issues)** is where the developer-only material lives:
  anything mentioning `pnpm`, `.dev-logs/`, `argospm`, a `.venv`, `FFMPEG_PATH` or
  a Rust toolchain assumes a checkout and does not apply to an installed app.

---

## Error code reference

Every member of the `ErrorCode` union in `packages/shared/src/errors.ts` (24 codes)
appears here. If you add a code, add a row **and** a section — the app's `docsRef`
contract points at this page.

| Code | What failed | Likely why | How to fix | Doc |
|---|---|---|---|---|
| `FFMPEG_NOT_FOUND` | ffmpeg couldn't be launched | Not installed / not on PATH / bad `FFMPEG_PATH` | Install ffmpeg or set `FFMPEG_PATH` (dev only — the installed app bundles it) | [LOCAL_SETUP](LOCAL_SETUP.md#3-ffmpeg--ffprobe) |
| `FFPROBE_NOT_FOUND` | ffprobe couldn't be launched | Same as above, for ffprobe | Install ffmpeg (ships ffprobe) or set `FFPROBE_PATH` | [LOCAL_SETUP](LOCAL_SETUP.md#3-ffmpeg--ffprobe) |
| `FFMPEG_FILTER_MISSING` | Your ffmpeg lacks a needed filter | Build without libass, for burned-in subs | Use a libass build, or pick a non-burned subtitle mode | [#ffmpeg_filter_missing](#ffmpeg_filter_missing) |
| `PYTHON_NOT_FOUND` | Python interpreter missing | No Python / wrong `PYTHON_PATH` | Install Python 3.12 or set `PYTHON_PATH` | [LOCAL_SETUP](LOCAL_SETUP.md#2-python-workers-per-worker-venvs) |
| `STT_MODEL_MISSING` | faster-whisper model unavailable | Not cached and can't download | Pre-cache the model; check `FASTER_WHISPER_MODEL` | [MODEL_SETUP](MODEL_SETUP.md#1-faster-whisper-speech-to-text) |
| `TRANSLATION_PACKAGE_MISSING` | No Argos package for the pair | Pair not installed / not published | Install it from Settings → Translation packs (dev: `argospm install translate-<from>_<to>`) | [MODEL_SETUP](MODEL_SETUP.md#2-argos-translate-machine-translation) |
| `PIPER_MISSING` | Piper binary not usable | `PIPER_BINARY_PATH` unset/invalid | Install the Piper binary + set the path, or use the fallback engine | [MODEL_SETUP](MODEL_SETUP.md#3-piper-text-to-speech) |
| `TTS_VOICE_MISSING` | No voice for the language | No matching `.onnx` in `PIPER_VOICES_DIR` / bad `PIPER_VOICE_MODEL_PATH` | Download a voice `.onnx`+`.onnx.json` for the target language | [MODEL_SETUP](MODEL_SETUP.md#3-piper-text-to-speech) |
| `UNSUPPORTED_MEDIA` | Input can't be probed/decoded | Corrupt / unsupported container or codec | Re-encode to a standard MP4/MKV; verify with `ffprobe` | [#unsupported_media](#unsupported_media) |
| `NO_AUDIO_STREAM` | No audio to transcribe | Video has no audio track | Use a video with audio, or add a track | [#no_audio_stream](#no_audio_stream) |
| `INVALID_LANGUAGE` | Bad/unsupported language code | Typo or unknown locale | Use a valid code (e.g. `en`, `vi-VN`); see normalization rules | [#invalid_language](#invalid_language) |
| `INVALID_VIDEO_LINK` | The pasted link isn't a downloadable video | Not a video page, unsupported site, or private/removed | Copy the full address from the browser address bar | [#invalid_video_link](#invalid_video_link) |
| `OUTPUT_NOT_WRITABLE` | Can't write output/workspace | Permissions / missing dir / disk full | Fix permissions; ensure `VIDEODUBBER_PROJECTS_DIR` is writable; free space | [#output_not_writable](#output_not_writable) |
| `WORKER_UNAVAILABLE` | A worker didn't respond | Worker not started / wrong port / crashed | Start the worker; check the `*_WORKER_URL` | [#worker_unavailable](#worker_unavailable) |
| `WORKER_TIMEOUT` | A worker took too long | Large media / slow model / hang | Use a smaller model; retry the step | [#worker_timeout](#worker_timeout) |
| `CLOUD_CREDENTIALS_MISSING` | A cloud phase has no API key | Provider selected but key not set | Add the key in Settings → Cloud API keys, or switch the phase back to local | [PROVIDERS](PROVIDERS.md#cloud-api-keys) |
| `CLOUD_REQUEST_FAILED` | The cloud provider rejected the call | Invalid key, no quota, network/TLS | Check the key and quota, retry, or switch to a local provider | [PROVIDERS](PROVIDERS.md#cloud-troubleshooting) |
| `ENGINE_PACK_MISSING` | The phase's engine pack isn't installed | Provider chosen before installing the pack | Install it in Settings → Engines, or pick another provider | [PROVIDERS](PROVIDERS.md#engine-packs) |
| `ENGINE_PACK_FAILED` | The pack couldn't be downloaded/verified | Network, disk space, or checksum mismatch | Retry the install — corrupt downloads are discarded automatically | [PROVIDERS](PROVIDERS.md#engine-packs) |
| `ENGINE_UNAVAILABLE` | A pack's engine process won't start/respond | Crash, missing runtime, driver too old | Retry; reinstall the pack; or fall back to a CPU provider | [#engine_unavailable](#engine_unavailable) |
| `ENGINE_BUSY` | Another dub already owns this engine | Heavy local engines serve one project at a time | Wait for that dub (or cancel it), then retry | [#engine_busy](#engine_busy) |
| `CANCELLED` | Job was cancelled | User cancelled the pipeline | Expected — re-run when ready (resumes/skips done steps) | [#cancelled](#cancelled) |
| `RUN_IN_PROGRESS` | This project is already running | A second run/settings change was requested mid-run | Wait for the run to finish, or cancel it first | [#run_in_progress](#run_in_progress) |
| `UNKNOWN` | Unclassified error | Unexpected condition | Read the message; file an issue with the code + message | [#unknown](#unknown) |

Each code below has its own anchor so a `docsRef` can deep-link to it.

---

<a id="ffmpeg-not-found"></a>

### `FFMPEG_NOT_FOUND`
`ffmpeg` could not be launched. Install FFmpeg for your OS
([LOCAL_SETUP §3](LOCAL_SETUP.md#3-ffmpeg--ffprobe)) or set `FFMPEG_PATH` to the absolute
binary path. Verify with `ffmpeg -version` and re-run `pnpm verify`.

<a id="ffprobe-not-found"></a>

### `FFPROBE_NOT_FOUND`
`ffprobe` could not be launched. It ships with FFmpeg; install FFmpeg or set
`FFPROBE_PATH`. Verify with `ffprobe -version`.

<a id="ffmpeg-filter-missing"></a>

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

<a id="python-not-found"></a>

### `PYTHON_NOT_FOUND`
No usable Python interpreter. Install **Python 3.12** — the version the bundled
interpreter and every engine-pack venv use (`UV_PYTHON_VERSION = '3.12'`), so
matching it keeps dependency resolution identical to a release. Dependency metadata
really is marker-sensitive across this boundary (e.g. `libretranslate` resolves a
different numpy on 3.12 vs 3.13), which is why "3.11–3.13, whatever you have" is not
good enough. Or set `PYTHON_PATH` to the interpreter that built the worker venvs.
See [LOCAL_SETUP §2](LOCAL_SETUP.md#2-python-workers-per-worker-venvs).

<a id="stt-model-missing"></a>

### `STT_MODEL_MISSING`
The faster-whisper model isn't cached and couldn't be downloaded. Pre-cache it
([MODEL_SETUP §1](MODEL_SETUP.md#1-faster-whisper-speech-to-text)) while online, or set
`FASTER_WHISPER_MODEL` to a model you already have. Check disk space and the HF cache.

<a id="translation-package-missing"></a>

### `TRANSLATION_PACKAGE_MISSING`
No Argos Translate package is installed for the requested pair. The error includes the
exact command, e.g. `argospm install translate-en_vi`. Install it
([MODEL_SETUP §2](MODEL_SETUP.md#2-argos-translate-machine-translation)) or choose a
supported pair. Confirm with `curl http://127.0.0.1:5102/languages`.

<a id="piper-missing"></a>

### `PIPER_MISSING`
`PIPER_BINARY_PATH` is unset or points to a non-runnable binary. Install the Piper binary
and set the path ([MODEL_SETUP §3](MODEL_SETUP.md#3-piper-text-to-speech)). If you don't
want Piper, leave it unset — the TTS worker falls back to system TTS or a silent/sine
WAV automatically.

<a id="tts-voice-missing"></a>

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

<a id="unsupported-media"></a>

### `UNSUPPORTED_MEDIA`
The input couldn't be probed or decoded (corrupt file, or a container/codec FFmpeg can't
read). Inspect it with `ffprobe yourfile.ext`. Re-encode to a standard MP4 (H.264 + AAC)
or MKV and retry:
```bash
ffmpeg -i broken.ext -c:v libx264 -c:a aac fixed.mp4
```

<a id="no-audio-stream"></a>

### `NO_AUDIO_STREAM`
`extract-audio` found no audio track to transcribe. Confirm with
`ffprobe -show_streams yourfile`. Use a video that contains audio, or mux an audio track
in. Dubbing requires source speech to transcribe.

<a id="invalid-language"></a>

### `INVALID_LANGUAGE`
A language code is unrecognized. Use BCP-47-style codes such as `en`, `en-US`, `vi`,
`vi-VN`. Normalization rules: codes are trimmed and case-fixed (`EN → en`,
`vi-vn → vi-VN`); the special case **`vi-VI` (any case) normalizes to `vi-VN`**. STT uses
the whisper base subtag (`vi-VN → vi`); translation uses the Argos base subtag
(`vi-VN → vi`).

<a id="output-not-writable"></a>

### `OUTPUT_NOT_WRITABLE`
The workspace or output path can't be written. Ensure `VIDEODUBBER_PROJECTS_DIR`
(default `~/VideoDubber/projects`) and the chosen output directory exist and are
writable, and that the disk isn't full:
```bash
mkdir -p ~/VideoDubber/projects && touch ~/VideoDubber/projects/.write-test && rm ~/VideoDubber/projects/.write-test
df -h ~
```

<a id="worker-unavailable"></a>

### `WORKER_UNAVAILABLE`
The orchestrator couldn't reach a worker. Make sure it's running and the matching
`*_WORKER_URL` is correct. See [worker not starting / port in use](#worker-not-starting--port-in-use).
Check health:
```bash
curl -s http://127.0.0.1:5100/workers/health
```

<a id="worker-timeout"></a>

### `WORKER_TIMEOUT`
A worker call exceeded its time budget — usually a large file or a heavy model on CPU.
Try a smaller `FASTER_WHISPER_MODEL`, retry just that step
(`POST /projects/:id/retry { "stepId": "stt" }`), or inspect the worker log in
`.dev-logs/`.

<a id="engine-unavailable"></a>

### `ENGINE_UNAVAILABLE`
An engine pack's local server did not start, or stopped answering. Retry the step
first — engines are started on demand and a transient port/health failure is
recoverable. If it persists, **Reinstall** the pack from Settings → Engines, or
switch that phase to a CPU provider (Piper for TTS, faster-whisper for STT, Argos
for translation) to unblock the dub. On Windows with an NVIDIA GPU, see
[The CUDA engine pack won't start](#the-cuda-engine-pack-wont-start-nvidia-driver-too-old)
— an out-of-date driver produces exactly this shape of failure, late and with no
mention of a driver in the message.

<a id="engine-busy"></a>

### `ENGINE_BUSY`
Another dub is already using this local engine. Heavy engines (llama.cpp,
whisper.cpp, neural TTS) load a whole model into memory and take over the machine,
so the scheduler gives one **owner** at a time rather than silently stealing the
engine mid-run and thrashing both jobs. Work belonging to a different owner gets
`ENGINE_BUSY` instead.

This is expected, not a fault: wait for the running dub to finish (or cancel it),
then retry. It most often appears when you regenerate a single segment in the
editor while a full run is going. The admission rules and the simultaneous-dub
limit are explained in [`RUN_QUEUE.md`](RUN_QUEUE.md).

<a id="run-in-progress"></a>

### `RUN_IN_PROGRESS`
This project already has a pipeline run going, and the action you asked for would
conflict with it — starting a second run, changing project settings, or re-dubbing.
Wait for the run to finish, or cancel it from the Processing screen, then retry.

Note this is *per project*: other projects can run at the same time, bounded by the
simultaneous-dub limit in Settings → This computer ([`RUN_QUEUE.md`](RUN_QUEUE.md)).

<a id="cancelled"></a>

### `CANCELLED`
You cancelled the pipeline (`POST /projects/:id/cancel`). This is expected. Re-running
resumes: completed steps with existing artifacts are skipped.

<a id="unknown"></a>
<a id="unknown-error"></a>

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
Install Python 3.12 or set `PYTHON_PATH`. Recreate worker venvs with
`PYTHON_PATH=python3.12 bash scripts/setup-local-models.sh`. The dev scripts prefer
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

<a id="invalid-video-link"></a>

### `INVALID_VIDEO_LINK`

The **Download source video** screen could not recognise what you pasted. Copy the
full address out of the browser address bar — a full `bilibili.com/video/BV…` link,
a `b23.tv` short link, a `?bvid=` festival/list page and a bare `BV` id all work,
as do Douyin's `douyin.com/video/…`, `?modal_id=…`, `v.douyin.com` and bare numeric
forms — but a search-results or profile page is not a video.

**The whole downloader — supported sources, why the quality ceiling is lower than
the site shows, Bilibili's two pipes, and the `SESSDATA` risk/storage
explanation — is documented for users in
[`USER_GUIDE.md`](USER_GUIDE.md#5-downloading-a-source-video).** It lived here for
a whole release only because there was nowhere else for it to go.

Implementation notes that belong to a developer rather than a user:

- **A download reports "no audio" or "could not be read back".** The finished file
  is checked with `ffprobe` before it is handed over, because `ffmpeg` exiting 0 is
  not proof a stream copy produced a sound file — a broken or absent audio track
  would otherwise surface much later as "no audio to transcribe", pointing at the
  wrong step. Retry, or pick a different quality. If `ffprobe` is missing the check
  is skipped rather than failing the download.
- **Douyin is read from the public share page**, not its web API (which needs a
  signature recomputed from obfuscated site JavaScript). That page is only served
  to a **mobile** user agent — with a desktop one the request succeeds and returns
  a page containing no data at all.
- **Adding another source** is a two-line change; the `SourceProvider` contract is
  documented in [`PROVIDERS.md`](PROVIDERS.md#adding-a-download-source).
- If the link *is* a video page and it still fails, the video may be private,
  removed, region-locked or account-gated: open it in a logged-out browser to
  check. The downloader only reaches what an anonymous visitor can already play.

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

### Packaging a release build fails (macOS sign/notarize)
Local **release** builds (`pnpm package:sidecars` → `pnpm app:build`) have macOS-specific
failure modes: a plain `tauri build` only adhoc-signs the bundled workers/ffmpeg, the
static ffmpeg/ffprobe ship read-only and trip the bundler's `xattr` step, and notary
creds left in the env make `tauri build` try (and fail) to notarize itself. These and
their fixes are in [`APPLE_SIGNING.md` Phase 7](APPLE_SIGNING.md#phase-7--common-errors--fixes);
the one-command wrapper that avoids all three is `scripts/package/release-macos.sh`.

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

The auto-updater points at `plugins.updater.endpoints` in `tauri.conf.json`:
`https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json`.
Update checks fail **until a release that includes a signed `latest.json` is
published** (see [RELEASING.md](RELEASING.md)) — e.g. the very first release, or
any release built without the Tauri signing secret. The app no longer auto-checks
on launch/Settings load, so this only appears if you click **Check for
updates** before such a release exists. The installed version still shows (it's read
from bundle metadata via `get_app_version`, no network).

### Angular rejects the TypeScript version
The desktop app is **Angular 22** and every package in the monorepo — root and
`apps/desktop` alike — pins the **same** TypeScript. There is no per-package split
and nothing to "restore".

Angular's constraint is declared by `@angular/compiler-cli`, so check it rather
than trusting a version written down in prose:

```bash
npm view @angular/compiler-cli peerDependencies.typescript
```

Angular 22 declares `>=6.0 <6.1`, which is why TypeScript 7 is not installable
until Angular widens that peer. If `ng` complains about an unsupported TypeScript
version, reconcile the pin in the `package.json` files with that range.

*(This section used to describe a deliberate "Angular 18 / TypeScript ~5.5.4 in the
desktop app, ~5.6.3 at the root" split. None of it was true any more, and following
it would have downgraded TypeScript far enough to break the Angular 22 build — a
doc that documents a pin that does not exist is worse than a stale version
number.)*

### The CUDA engine pack won't start (NVIDIA driver too old)

Symptom: translation (or whisper.cpp) works until you install the **CUDA** engine
pack, and then the step gets slower or fails. The engine log ends with

```
D:\a\llama.cpp\llama.cpp\ggml\src\ggml-cuda\ggml-cuda.cu:103: CUDA error
```

and the process exit code is `-1073740791` (`0xC0000409` — `abort()`).

**Cause: the driver is older than the CUDA toolkit the pack was built against.**
The packs ship CUDA 12.4 binaries, which need **driver 551.61 or newer** on
Windows. NVIDIA documents "minor version compatibility" (12.x code on any r525+
driver); in practice it does not hold for these builds, and when it breaks it
breaks *late*: the GPU enumerates, the model loads, every buffer allocates, and
only the first real graph execution aborts. Nothing in the message mentions a
driver.

Measured on a GTX 1650 with the 26B MoE chat model:

| Driver | GPU allocation | Result |
|---|---|---|
| 546.29 (CUDA 12.3) | 1749.70 MiB model + 128 + 540 KV | abort |
| 610.88 | *byte-for-byte identical* | serves normally |

It is **not** a VRAM problem, and reducing the offload does not help: the same
abort happens at 4, 5 and 20 offloaded layers, with 1.8 GB of VRAM still free,
and for a dense 12B as well as the MoE.

**Fix:** update the NVIDIA driver, then restart the app. The app also gates the
CUDA packs on this (`minNvidiaDriver` in the engine catalog): below the floor
they stop being recommended, Settings → Engines badges them
"Needs NVIDIA driver 551.61 or newer", and an already-installed CUDA runtime is
ranked *behind* the Vulkan one so a run never pays its load-then-abort. The
Vulkan pack is a fine fallback on NVIDIA — slower, but unaffected by this.

**To confirm before/after:**
```powershell
pwsh scripts\diagnose-llama-engine.ps1 -Runtime llama-cpp-cuda -Bisect
```
The report opens with an explicit `driver 551.61+` check. (Note that the actual
CUDA error string can never be captured: `ggml_cuda_error()` logs it through
llama.cpp's asynchronous logger, which `abort()` does not flush — which is why
the script bisects the memory knobs instead of chasing the message.)

---

If a problem isn't covered here, capture the failing `AppError` (its `code` +
`message`) and open an issue. From a source checkout, attach the relevant
`.dev-logs/*.log` as well; from an installed build there is no log file to attach
(the packaged workers' stdio is discarded), so the code + message is what we have.
