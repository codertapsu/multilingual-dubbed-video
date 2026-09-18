# Model setup

VideoDubber's local engines need three kinds of models:

1. A **faster-whisper** speech-to-text model. Two different defaults are in play and
   both are intentional: the orchestrator falls back to `small` when nothing is set
   (`FASTER_WHISPER_MODEL`), while the **first-run wizard recommends
   `large-v3-turbo`** on a capable machine. A packaged app therefore normally ends
   up on `large-v3-turbo`, not `small`.
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

<a id="stt-model"></a>

## 1. faster-whisper (speech-to-text)

### Model sizes

The curated list the wizard shows comes from `WHISPER_MODELS` in
`packages/node-orchestrator/src/setup/catalog.ts` — keep this table in step with it.

| Model | Size (approx) | Notes |
|---|---|---|
| `tiny` | ~75 MB | fastest, lowest accuracy; quick smoke tests |
| `base` | ~145 MB | balanced; good on 8 GB |
| `small` | ~484 MB | better accuracy; the orchestrator's env fallback |
| `large-v3-turbo` | ~1.62 GB | **recommended** — near-best accuracy at 6–8× the speed of `large-v3` |
| `distil-large-v3.5` | ~760 MB | English only, fastest large |
| `medium` | ~1.53 GB | high accuracy, slower |
| `large-v3` | ~3.09 GB | best accuracy, slowest; needs RAM/VRAM |
| `phowhisper-medium` | ~1.53 GB | VinAI PhoWhisper — pick when the **source** audio is Vietnamese |
| `phowhisper-large` | ~3.09 GB | PhoWhisper, highest accuracy for Vietnamese-source audio |

*(There is no model id `turbo`; that row was a fiction, and the table was missing
`large-v3-turbo`, `distil-large-v3.5` and both PhoWhisper entries — i.e. the
recommended default and the Vietnamese specialists, which is most of the reason to
read this table at all.)*

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

faster-whisper downloads CTranslate2 model weights via Hugging Face Hub. **Where they
land depends on how you run VideoDubber**, and getting this wrong is the usual cause
of "the wizard sits at 0%" and "I deleted the HF cache and the models are still
there":

- **Packaged app** — `<config>/models/huggingface`, i.e. `~/VideoDubber/models/huggingface`
  (`%USERPROFILE%\VideoDubber\models\huggingface` on Windows). The desktop shell
  exports that path as **both** `STT_MODEL_CACHE_DIR` and `HF_HOME` so everything the
  app downloads lives under one deletable folder, never your global HF cache.
- **Dev / from source** — the HF default, `~/.cache/huggingface/hub/`
  (`%USERPROFILE%\.cache\huggingface\hub\` on Windows), unless you set otherwise.

Override with `STT_MODEL_CACHE_DIR`, `HF_HUB_CACHE` or `HF_HOME` — in that priority
order. The orchestrator's progress poller resolves the cache with the **same**
priority as the STT worker (`config.ts`); if the two disagree the poller watches the
wrong directory and reports 0% forever.

Missing/undownloadable model → **`STT_MODEL_MISSING`** (see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#stt_model_missing)).

---

<a id="translation-package"></a>

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

<a id="piper"></a>
<a id="tts-voice"></a>

## 3. Piper (text-to-speech)

Piper is the **preferred** local TTS engine. The TTS worker invokes the Piper **binary**
via subprocess. The *dev* worker does **not** pip-install `piper-tts` — you supply the
binary (below). The *release* build does ship one: `scripts/package/vd-piper.spec`
freezes the `piper-tts` (piper1-gpl) console script into the `vd-piper` sidecar, so an
installed app needs nothing here. If Piper isn't configured, the
worker falls back to system TTS (macOS `say`, Linux `espeak-ng`) and finally a dev
silent/sine WAV so the pipeline still completes.

You need **two** things: the Piper **binary** and a **voice** (`.onnx` + `.onnx.json`).

### Download the binary

Grab a release for your OS from <https://github.com/OHF-Voice/piper1-gpl/releases>,
unpack it, and note the executable path. (The old `rhasspy/piper` repository was
archived read-only on 2025-10-06 — "Development has moved" — and its last binaries
predate what the packaged app ships, so links to it send people to a dead end.)

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
| faster-whisper | packaged: `~/VideoDubber/models/huggingface` · dev: `~/.cache/huggingface/hub/` | `STT_MODEL_CACHE_DIR` → `HF_HUB_CACHE` → `HF_HOME` |
| Argos packages | packaged: `~/VideoDubber/models/argos` · dev: `~/.local/share/argos-translate/packages/` | `ARGOS_PACKAGES_DIR` |
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
