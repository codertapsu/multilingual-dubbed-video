# Engine packs — hosting & pinning the download URLs

Engine packs are the optional, downloaded-on-demand engines that capable
machines can add from **Settings → Engines** (accelerated whisper.cpp, local-LLM
translation, neural TTS, vocal separation, forced alignment). The base app never
needs them — they're purely additive. This doc is for **maintainers**: where the
URLs live, what you must host yourself, and how to pin checksums.

> TL;DR — edit one file: **`packages/node-orchestrator/src/engines/enginePackCatalog.ts`**.
> Every native pack points at a real upstream binary; **nothing is self-hosted
> today**. The seven GGUF model packs pin community requants on HuggingFace, which
> is the one thing that genuinely breaks — see
> [§3 Re-pinning a model pack](#3-re-pinning-a-model-pack-whose-upstream-vanished).
> The Python packs need no URLs at all.

---

## 1. Where the URLs live

All download URLs are in the `ENGINE_PACKS` array in
[`enginePackCatalog.ts`](../packages/node-orchestrator/src/engines/enginePackCatalog.ts).
At the top of that file are the only knobs you normally touch:

```ts
const LLAMA_CPP   = 'b9592';     // ggml-org/llama.cpp release tag
const WHISPER_CPP = 'v1.8.6';    // ggml-org/whisper.cpp release tag
```

Each pack lists one or more `artifacts`, each with a `url`, an optional `sha256`,
and `archive: true` (extract the archive into the pack dir). To change a pack:
bump the version constant, or edit the artifact `url`/`sha256` directly.

> **`SELF_HOSTED_BASE` and `VIDEODUBBER_ENGINE_BASE` no longer exist.** Neither
> name appears anywhere in `packages/`, `apps/` or `scripts/`. They were removed
> along with the `whisper-cpp-metal` pack; this doc kept describing them for
> months, which is how its longest section became a half-day of work for a pack
> that can never load.

### CUDA packs: bump the driver floor with the toolkit

The two CUDA packs also declare `minNvidiaDriver`, driven by two more constants:

```ts
const CUDA_TOOLKIT      = '12.4';    // appears in every CUDA artifact URL
const CUDA_MIN_DRIVER_WIN = '551.61'; // the Windows driver that ships it
```

**If you rebuild a CUDA pack against a different toolkit, move both.** A CUDA
binary on a driver older than its toolkit does not fail to load — it enumerates
the GPU, loads the model, allocates every buffer and only then aborts inside
`CUDA_CHECK`, with nothing in the message naming a driver. (Measured: a GTX 1650
aborted every run on 546.29 and served the byte-for-byte identical allocation on
610.88.) NVIDIA's documented "minor version compatibility" does not save you
here.

`engines.test.ts` parses the toolkit back out of each pack's artifact URLs and
asserts it maps to the declared floor, so a rebuild that forgets this fails the
suite rather than shipping a silent crash. Extend the `TOOLKIT_TO_DRIVER` table
there when you move to a new toolkit
([version table](https://developer.nvidia.com/cuda-toolkit-archive)).

---

## 2. The catalog, pack by pack

All 18 ids in `ENGINE_PACKS`, so a reader can tell at a glance what needs
maintenance. Keep this table in step with `enginePackCatalog.ts`.

**Native runtimes** — downloaded binaries, pinned by URL + sha256.

| Pack | Platform | Source | Action needed |
|---|---|---|---|
| `whisper-cpp-cuda` | Windows x64 | **upstream** ggml-org/whisper.cpp (cuBLAS) | none |
| `llama-cpp-metal` | macOS arm64 | **upstream** ggml-org/llama.cpp | none |
| `llama-cpp-cuda` | Windows x64 | **upstream** (binary + cudart) | none |
| `llama-cpp-vulkan` | Windows x64 | **upstream** | none |
| `llama-cpp-linux` | Linux x64 | **upstream** | none |

**GGUF model packs** — weights the `llama-cpp` runtime loads. These pin
**community requants** on HuggingFace, so an upstream deletion breaks the install;
this is the class of breakage that actually happens. See §3.

| Pack | Weights | License field to keep set |
|---|---|---|
| `translategemma-4b` / `-12b` / `-27b` | TranslateGemma requants | `licenseCategory: 'commercial-restricted'` + the Gemma note |
| `chat-gemma3-4b` / `-12b` | Gemma 3 instruct requants | `licenseCategory: 'commercial-restricted'` + the Gemma note |
| `chat-gemma4-12b` / `-26b-a4b` | Gemma 4 instruct requants (**Apache-2.0** — no Gemma ToU) | no restriction |

**Python packs** — no URLs; `uv` materializes them from a locked requirement set.

| Pack | Platform | Status |
|---|---|---|
| `tts-neural` | all | ships — VieNeu-TTS v3-Turbo, Vietnamese |
| `tts-neural-v2` | Windows | **disabled** (`DISABLED_PACK_IDS`) — unvalidated path, Windows-only wheels, CC BY-NC voices; superseded by `tts-neural` |
| `tts-omnivoice` | macOS arm64 | **ON HOLD** (`DISABLED_PACK_IDS`) pending output-quality work; see [OMNIVOICE.md](OMNIVOICE.md) |
| `separation-audio` | all | **disabled** — its `vd_separator` worker is an unimplemented stub |
| `alignment-whisperx` | all | **disabled** — its `vd_whisperx` worker is an unimplemented stub |
| `translation-libretranslate` | all | ships — offline LibreTranslate as an alternative MT tier |

> **There is no macOS Metal whisper.cpp pack.** ggml-org publishes whisper.cpp
> binaries for Windows only, and the `whisper-cpp-metal` id that this doc used to
> describe — along with a whole self-hosting runbook for it — is **not in
> `ENGINE_PACKS`**. On Apple Silicon, STT uses batched faster-whisper. If you ever
> want that pack back, the historical build recipe is in this file's git history
> (`git log -p -- docs/ENGINE_PACKS.md`).

---

## 3. Re-pinning a model pack whose upstream vanished

The seven GGUF packs pin a single file on HuggingFace by URL + sha256, and those
files can be renamed, re-quantized or deleted — at which point the pack's install
fails for every user at once. This is the most likely real breakage in the catalog
and it has no automated guard, so here is the procedure.

Know which kind of pin you are repairing before you start, because the risk is not
uniform:

| Packs | Uploader | Quant |
|---|---|---|
| `translategemma-4b` | `mradermacher` (individual) | `Q4_K_M` |
| `translategemma-12b` / `-27b` | `bullerwins` (individual) | `Q4_K_M` |
| `chat-gemma3-4b` / `-12b` | `ggml-org` (first-party llama.cpp org) | `Q4_K_M` |
| `chat-gemma4-12b` / `-26b-a4b` | `ggml-org` | **`Q4_0`** — ggml-org publishes Q4_0/Q8_0 only for Gemma 4, no Q4_K_M |

Only the three TranslateGemma packs are community requants by an individual; the
Gemma 3/4 packs come from `ggml-org` itself and are the least likely to vanish.

1. **Confirm it's gone**, not a transient 5xx:
   ```bash
   curl -sI "<the url in enginePackCatalog.ts>" | head -1
   ```
2. **Find a replacement requant** of the *same base model at the same quant level* —
   the level in the table above, which is also the pack's `version` field, not a
   blanket `Q4_K_M`. Prefer an uploader with a long history and a model card that
   names the source repo. Do not silently switch quant levels: `minRamMb` and
   `approxSizeMb` are sized for the current one, and `version` is what the UI shows.
3. **Download it once and hash it**:
   ```bash
   curl -fL -o candidate.gguf "<new url>"
   shasum -a 256 candidate.gguf
   ```
4. **Smoke it** before pinning: install the pack, run a short dub, and confirm the
   output is coherent in the target language. A requant from a different base model
   will load happily and translate badly, so nothing but reading the output catches
   this.

   > **`LLAMACPP_MODEL` will not select it.** The managed llama.cpp path loads the
   > model **by file**, via `resolveLocalLlmModelPath`; `LLAMACPP_MODEL` is only the
   > label reported back in provider metadata (see the comment above it in
   > `providers/registry.ts`). Which GGUF actually loads is decided by
   > `pickInstalledLocalLlmModel` / the chat equivalent in `packSelection.ts`: the
   > **most capable installed pack the machine fits**, ranked
   > `translategemma-27b → -12b → -4b` for translation and
   > `chat-gemma4-26b-a4b → chat-gemma4-12b → chat-gemma3-12b → chat-gemma3-4b`
   > for the context-aware tiers. So to smoke a specific pack, **remove the
   > higher-ranked packs of that family first** — otherwise you will test the old
   > pin and pass.
5. **Edit the pack**: replace the `url` and `sha256`, and update `approxSizeMb` if
   the file size moved materially.
6. **Keep the license fields.** Every TranslateGemma and Gemma 3 pack must keep
   `licenseCategory: 'commercial-restricted'` and the Gemma terms note — that is
   what the UI surfaces before install and what [`../NOTICE.md`](../NOTICE.md)
   documents as a pass-through obligation. Gemma 4 packs are Apache-2.0 and must
   **not** carry it. Getting this wrong is a licensing bug, not a cosmetic one.
7. Run `pnpm test` — `engines.test.ts` guards the catalog's internal consistency.

---

## 4. Pinning checksums (recommended)

The installer downloads and then **runs** these binaries, so verify them:

- When an artifact's `sha256` is set, the installer aborts on a mismatch and
  discards the download.
- When it's empty, the installer still installs but logs
  `No checksum pinned for <id>; installed unverified`.

Compute a hash with `shasum -a 256 <file>` (macOS/Linux) or
`Get-FileHash <file> -Algorithm SHA256` (PowerShell) and paste it into the
artifact's `sha256`. For upstream ggml-org assets, download the asset once,
hash it, and pin it (GitHub release assets are immutable per tag).

---

## 5. The Python packs need no URLs

`tts-neural`, `separation-audio`, and `alignment-whisperx` use `uv-env://…`
markers, not downloads. The bundled **`uv`** builds a self-contained Python
environment from a locked, per-platform requirement set (in
[`uvRequirements.ts`](../packages/node-orchestrator/src/engines/uvRequirements.ts))
and `uv` fetches its own CPython — so there is nothing to host. To change what
these install, edit the requirement sets there. The model weights (voices,
separation/alignment checkpoints) download from their hubs on first use, like the
Whisper models. `tts-neural` is VieNeu‑TTS v3‑Turbo via the `vieneu` PyPI package
(torch‑free ONNX); end‑user setup is in
[`VIENEU_TTS_SETUP.md`](VIENEU_TTS_SETUP.md). uv docs: <https://docs.astral.sh/uv/>.

---

## 6. Verify a pack end to end

```bash
# Run the orchestrator (dev) or use the installed app, then:
curl -s localhost:5100/engines | python3 -m json.tool            # available + installed
curl -s localhost:5100/engines/prerequisites | python3 -m json.tool  # uv / ollama status
curl -s -XPOST localhost:5100/engines/install -d '{"packId":"llama-cpp-metal"}' \
  -H content-type:application/json
# watch progress:
curl -s localhost:5100/engines/events
```

Then open **Settings → Engines** — an installed pack flips to "installed", and a
project that selects its provider (e.g. translation = `llama-cpp`) will start the
engine on demand.

---

## 7. Upstream references

- llama.cpp releases (prebuilt binaries): <https://github.com/ggml-org/llama.cpp/releases>
- whisper.cpp (build + Windows binaries): <https://github.com/ggml-org/whisper.cpp>
- GitHub Releases (hosting assets): <https://docs.github.com/en/repositories/releasing-projects-on-github>
- uv (Python env manager): <https://docs.astral.sh/uv/>
- Engine selection rationale + per-tier matrix: [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md)
- Provider/engine architecture: [`PROVIDERS.md`](PROVIDERS.md#engine-packs)
