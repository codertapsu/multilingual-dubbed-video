# Model setup

VideoDubber's local engines need three kinds of models:

1. A **faster-whisper** speech-to-text model (default `small`).
2. **Argos Translate** language package(s) (default `en → vi`; a non-English pair like
   `zh → vi` pivots through English and needs both `zh → en` and `en → vi`).
3. (Optional) A **Piper** voice for high-quality local TTS.

The one-shot setup script handles all three:

```bash
bash scripts/setup-local-models.sh        # Windows: pwsh scripts/setup-local-models.ps1
```

Override defaults with env vars: `FASTER_WHISPER_MODEL`, `ARGOS_FROM`/`ARGOS_TO`,
`PIPER_VOICE`, `MODELS_DIR`. Each phase is individually skippable (`SKIP_WHISPER=1`,
`SKIP_ARGOS=1`, `SKIP_PIPER=1`, `SKIP_MODELS=1`, `SKIP_VENVS=1`). The script never fails
hard if you're offline — it prints manual instructions instead.

The sections below explain each model, how to pre-download it manually, and where it's
cached.

---

## 1. faster-whisper (speech-to-text)

### Model sizes

| Model | Size (approx) | Speed | Quality | Notes |
|---|---|---|---|---|
| `tiny` | ~75 MB | fastest | lowest | quick smoke tests |
| `base` | ~145 MB | fast | low | |
| `small` | ~480 MB | balanced | good | **default** |
| `medium` | ~1.5 GB | slower | better | |
| `large-v3` | ~3 GB | slowest | best | needs RAM/VRAM |
| `turbo` | ~1.6 GB | fast | high | speed-optimized large variant |

Set the model via env: `FASTER_WHISPER_MODEL=small`. The STT worker runs CPU inference
with `compute_type=int8` (low memory, no GPU required).

### Pre-download

The setup script constructs `WhisperModel(model, device="cpu", compute_type="int8")`,
which downloads and caches the model on first construction. To do it manually:

```bash
workers/stt-worker/.venv/bin/python - <<'PY'
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8")
print("cached")
PY
```

To switch models, pre-cache another and set the env var:

```bash
FASTER_WHISPER_MODEL=medium bash scripts/setup-local-models.sh   # only re-caches the model with SKIP_VENVS=1 SKIP_ARGOS=1 SKIP_PIPER=1
```

### Where it's cached

faster-whisper downloads CTranslate2 model weights via Hugging Face Hub, so they land in
the HF cache:

- macOS/Linux: `~/.cache/huggingface/hub/`
- Windows: `%USERPROFILE%\.cache\huggingface\hub\`

Override with `HF_HOME` / `HF_HUB_CACHE` if you want a custom directory.

Missing/undownloadable model → **`STT_MODEL_MISSING`** (see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#stt_model_missing)).

---

## 2. Argos Translate (machine translation)

Argos is offline neural MT. You install a **language package** per direction (e.g.
`en → vi`). The translation worker reduces locales to the base subtag
(`toArgosLanguage`, so `vi-VN → vi`) before looking up the package.

> **English pivot.** Argos publishes packages only **to and from English**, so a
> non-English pair translates in two hops. Installing `zh → vi`, for example, means
> installing **both** `zh → en` and `en → vi`; argostranslate chains them
> automatically. The app computes these legs for you (`argosPivotLegs`) when you pick
> languages and downloads them on first run. A build can instead **pre-bundle** the
> legs for its default pairs — `en → vi` **and** `zh → vi` — for an offline
> out-of-box first dub by setting `BUNDLE_DEFAULT_MODELS=1` (the pairs are the
> single source of truth
> [`defaultBundle.ts`](../packages/node-orchestrator/src/setup/defaultBundle.ts);
> add to `DEFAULT_PAIRS` there and rebuild).

### Install a package

Via the setup script (default `en → vi`):

```bash
ARGOS_FROM=en ARGOS_TO=vi bash scripts/setup-local-models.sh
```

Via the Argos CLI (`argospm`), inside the translation worker venv:

```bash
source workers/translation-worker/.venv/bin/activate
argospm update
argospm install translate-en_vi          # English -> Vietnamese
argospm list                             # show installed packages
```

Via the Python API:

```bash
workers/translation-worker/.venv/bin/python - <<'PY'
import argostranslate.package as p
p.update_package_index()
pkg = next(x for x in p.get_available_packages()
           if x.from_code == "en" and x.to_code == "vi")
p.install_from_path(pkg.download())
print("installed en->vi")
PY
```

Browse all available pairs at <https://www.argosopentech.com/argospm/index/>. Confirm
what's installed via the worker:

```bash
curl -s http://127.0.0.1:5102/languages    # { "installed":[{from,to}], "available":[...] }
```

### Where it's stored

Argos stores installed packages under its data directory:

- macOS/Linux: `~/.local/share/argos-translate/packages/`
- Windows: `%USERPROFILE%\.local\share\argos-translate\packages\` (or under
  `%LOCALAPPDATA%` depending on the Argos version)

Override with the `ARGOS_PACKAGES_DIR` environment variable.

Missing pair → **`TRANSLATION_PACKAGE_MISSING`**; the worker's error includes the exact
`argospm install translate-<from>_<to>` command (see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#translation_package_missing)).

---

## 3. Piper (text-to-speech)

Piper is the **preferred** local TTS engine. The TTS worker invokes the Piper **binary**
via subprocess (it does **not** pip-install `piper-tts`). If Piper isn't configured, the
worker falls back to system TTS (macOS `say`, Linux `espeak-ng`) and finally a dev
silent/sine WAV so the pipeline still completes.

You need **two** things: the Piper **binary** and a **voice** (`.onnx` + `.onnx.json`).

### Download the binary

Grab a release for your OS from <https://github.com/rhasspy/piper/releases>, unpack it,
and note the executable path:

```bash
export PIPER_BINARY_PATH=/absolute/path/to/piper        # e.g. .../piper/piper
```

### Download a voice

The setup script downloads a default Vietnamese voice (`vi_VN-vais1000-medium`) into
`~/VideoDubber/models/piper/`:

```bash
PIPER_VOICE=vi_VN-vais1000-medium bash scripts/setup-local-models.sh
```

Voices live on Hugging Face under `rhasspy/piper-voices`, laid out as
`<lang>/<locale>/<dataset>/<quality>/<voice>.onnx(.json)`. To fetch one manually:

```bash
mkdir -p ~/VideoDubber/models/piper
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium
curl -fL -o ~/VideoDubber/models/piper/vi_VN-vais1000-medium.onnx       "$BASE/vi_VN-vais1000-medium.onnx"
curl -fL -o ~/VideoDubber/models/piper/vi_VN-vais1000-medium.onnx.json  "$BASE/vi_VN-vais1000-medium.onnx.json"

export PIPER_VOICE_MODEL_PATH=~/VideoDubber/models/piper/vi_VN-vais1000-medium.onnx
```

### How the worker picks a voice (language-aware)

You need `PIPER_BINARY_PATH` plus at least one voice. The worker resolves the
voice **per target language** from the standard Piper filename
(`vi_VN-…onnx` → `vi`), in precedence order:

1. an explicit request voice that is a path to an `.onnx` file,
2. `PIPER_VOICE_MODEL_PATH` (only if its filename matches the language),
3. any matching `*.onnx` in `PIPER_VOICES_DIR`
   (default `~/VideoDubber/models/piper/` — where setup downloads voices).

A voice whose language does not match is **never** used, and the OS engine is
only used when the OS has a voice for that language — so a missing Vietnamese
voice yields silent, flagged placeholders rather than English-sounding speech.
Voice catalogue / samples: <https://rhasspy.github.io/piper-samples/>.

Confirm the worker sees the voice:

```bash
curl -s "http://127.0.0.1:5103/voices?language=vi"
```

- Binary configured but missing/unrunnable → **`PIPER_MISSING`**.
- Voice file missing/unreadable → **`TTS_VOICE_MISSING`**.

See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#piper_missing).

---

## Model storage locations (summary)

| Model | Default location | Override |
|---|---|---|
| faster-whisper | `~/.cache/huggingface/hub/` | `HF_HOME` / `HF_HUB_CACHE` |
| Argos packages | `~/.local/share/argos-translate/packages/` | `ARGOS_PACKAGES_DIR` |
| Piper voices | `~/VideoDubber/models/piper/` | `PIPER_VOICES_DIR` (runtime), `MODELS_DIR` (setup), `PIPER_VOICE_MODEL_PATH` (single voice) |
| Piper binary | wherever you unpacked it | `PIPER_BINARY_PATH` |

---

## Troubleshooting missing-model errors

Each missing-model condition maps to an `ErrorCode` returned by the workers/orchestrator
and a fix:

| ErrorCode | Trigger | Fix |
|---|---|---|
| `STT_MODEL_MISSING` | Whisper model not cached and can't download | Pre-cache the model (§1) or set `FASTER_WHISPER_MODEL` to a model you have. |
| `TRANSLATION_PACKAGE_MISSING` | No Argos package for the requested pair | `argospm install translate-<from>_<to>` (§2); pick a supported pair. |
| `PIPER_MISSING` | `PIPER_BINARY_PATH` unset/invalid | Install the Piper binary and set `PIPER_BINARY_PATH` (§3), or rely on the system/fallback engine. |
| `TTS_VOICE_MISSING` | `PIPER_VOICE_MODEL_PATH` unset/invalid | Download a voice `.onnx`+`.onnx.json` and set `PIPER_VOICE_MODEL_PATH` (§3). |

Full remediation table: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
