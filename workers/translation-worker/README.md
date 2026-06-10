# @videodubber translation-worker

Local/offline-first translation service for **VideoDubber**, built with
**FastAPI** + **Argos Translate**. Runs on **port 5102** and is called by the
node orchestrator during the `translation` pipeline step.

It translates each subtitle/transcript segment **separately** (preserving ids
and ordering), applies an optional glossary, and never sends data off-device
when using the default Argos backend.

## Endpoints

| Method | Path                  | Description                                              |
| ------ | --------------------- | -------------------------------------------------------- |
| GET    | `/health`             | `{ "status": "ok", "installed_pairs": int, "backend": str }` |
| GET    | `/languages`          | `{ "installed": [{from,to}], "available": [{from,to}] }` |
| POST   | `/translate-segments` | Translate a batch of segments (see below)                |

### `POST /translate-segments`

Request body:

```json
{
  "sourceLanguage": "en-US",
  "targetLanguage": "vi-VN",
  "segments": [
    { "id": "seg_0001", "sourceText": "Hello world", "startMs": 0, "endMs": 1000 }
  ],
  "glossary": { "VideoDubber": "VideoDubber" }
}
```

Response:

```json
{ "segments": [ { "id": "seg_0001", "translatedText": "Xin chào thế giới" } ] }
```

Errors use the shared envelope:

```json
{ "error": { "code": "TRANSLATION_PACKAGE_MISSING", "message": "...", "remediation": "...", "docsRef": "docs/MODEL_SETUP.md" } }
```

## Language codes

Codes are normalized to match the shared TS utilities:

- Casing fixed: `EN` → `en`, `vi-vn` → `vi-VN`.
- **Special rule:** `vi-VI` (any case) → `vi-VN` (Vietnamese standard locale).
- For Argos, codes are reduced to the **base subtag**: `vi-VN` → `vi`,
  `en-US` → `en`. Vietnamese uses the base code **`vi`**.

## Setup

```bash
# from workers/translation-worker
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt      # runtime deps
# or:  pip install -e ".[dev]"       # + pytest/httpx for the test suite
```

## Run

```bash
uvicorn app.main:app --port 5102
# host/port also configurable via TRANSLATION_WORKER_HOST / TRANSLATION_WORKER_PORT
```

Quick check:

```bash
curl http://127.0.0.1:5102/health
curl http://127.0.0.1:5102/languages
```

## Installing language packages

Argos Translate needs a `.argosmodel` package **per direction** (e.g. en→vi is
a different package than vi→en). After installing, restart the worker (or it
will pick up new packages on next process start).

**Option A — `argospm` CLI** (ships with `argostranslate`):

```bash
argospm update                  # refresh the package index (needs network)
argospm install translate-en_vi # English -> Vietnamese
argospm install translate-vi_en # Vietnamese -> English
argospm list                    # show installed packages
```

**Option B — Python API** (online index):

```python
import argostranslate.package as pkg
pkg.update_package_index()
available = pkg.get_available_packages()
match = next(p for p in available if p.from_code == "en" and p.to_code == "vi")
pkg.install_from_path(match.download())
```

**Option C — offline, from a downloaded file:**

```python
import argostranslate.package as pkg
pkg.install_from_path("/path/to/translate-en_vi.argosmodel")
```

Set `ARGOS_PACKAGES_DIR` to control where packages are stored/loaded (the
desktop app points this at its app-data folder). See `docs/MODEL_SETUP.md` for
the project's bundled-model workflow.

## Glossary behavior

The optional `glossary` maps a **source term** to the exact **target term** to
appear in the output. The worker uses a **sentinel-token** strategy:

1. **PRE-protect** — replace each glossary source term (case-insensitive,
   whole-word) with an opaque Private-Use-Area sentinel the NMT engine leaves
   alone.
2. **Translate** the protected text.
3. **POST-restore** — replace sentinels with the glossary target value.

**Limitations** (documented on purpose): whole-word matching is weak for
space-less scripts (zh/ja/th source); grammatical agreement around an inserted
term is not adjusted; the term is inserted verbatim. See `app/glossary.py`.

## Cloud backends (future / optional)

Argos is the **default and only fully-implemented** backend. `app/providers.py`
contains placeholder scaffolds — `DeepLBackend` (`DEEPL_API_KEY`),
`GoogleBackend` (`GOOGLE_APPLICATION_CREDENTIALS`), `AzureBackend`
(`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`), `OpenAIBackend` (`OPENAI_API_KEY`)
— that raise `NotImplementedError` until wired up. No SDKs or keys are required
for local use.

## Tests

```bash
pytest
```

Tests inject a **fake backend** (`tests/conftest.py`) so the full suite runs
**without any Argos packages installed**. They cover health, `/languages`
shape, id/order preservation, glossary application, per-segment translation,
language normalization, and the structured `TRANSLATION_PACKAGE_MISSING` error.
```
