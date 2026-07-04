# Providers — local & cloud, per phase

VideoDubber's pipeline has four user-visible phases. Three of them — **speech-to-text
(STT)**, **translation**, and **text-to-speech (TTS)** — are implemented behind small
TypeScript interfaces and selected **per phase, per project** by id. The fourth,
**rendering**, always runs locally (FFmpeg): your video file never leaves the machine.

The default is **always local**. Cloud providers are optional, per-phase, key-gated
opt-ins — mix and match freely (e.g. local STT + cloud translation + local TTS).

---

## Local vs cloud — how to choose

| | Local (default) | Cloud |
|---|---|---|
| Cost | Free after model download | Pay per use (API pricing) |
| Privacy | Nothing leaves the machine | That phase's data is uploaded |
| Hardware | Needs RAM/CPU (see below) | Works on any machine |
| Offline | ✅ | Needs internet |
| Quality | Good; depends on model size | Often best-in-class |

The app helps you choose: **Settings → This computer** shows what was detected
(RAM, CPU, GPU) and a hardware-aware recommendation (which local Whisper model
fits, and whether cloud is advisable for STT/translation on this machine).
Defaults are saved in **Settings → Processing defaults** and can be overridden
per project in the new-project wizard — and changed again at any time.

---

## Provider catalog

| Phase | Provider id | Engine | Runs | Needs |
|---|---|---|---|---|
| STT | `faster-whisper` | faster-whisper (CTranslate2, int8/CUDA), worker `:5101` | local | — |
| STT | `whisper-cpp` | whisper.cpp server (Metal/CUDA/Vulkan) — accelerated Whisper | local | engine pack |
| STT | `openai-stt` | OpenAI `whisper-1` transcription API | cloud | OpenAI key |
| Translation | `argos` | Argos Translate (offline neural MT), worker `:5102` | local | — |
| Translation | `ollama` | Local LLM via Ollama (default `translategemma:4b`) | local | Ollama daemon |
| Translation | `llama-cpp` | Local LLM via bundled `llama-server` (TranslateGemma) | local | runtime + model pack |
| Translation | `openai-translate` | OpenAI chat model (default `gpt-4o-mini`) | cloud | OpenAI key |
| Translation | `anthropic-translate` | Anthropic Claude (default `claude-haiku-4-5`) | cloud | Anthropic key |
| Translation | `gemini-translate` | Google Gemini (default `gemini-2.0-flash`) | cloud | Gemini key |
| TTS | `piper-local` | Piper → system voice → silent fallback, worker `:5103` | local | — |
| TTS | `neural-tts` | Neural voices (Kokoro / VieNeu / Chatterbox / Qwen3-TTS) | local | engine pack |
| TTS | `omnivoice` | OmniVoice multilingual neural voices (600+ languages; Apple Silicon / PyTorch MPS) — **on hold, not in releases** ([OMNIVOICE.md](OMNIVOICE.md)) | local | engine pack (disabled) |
| TTS | `openai-tts` | OpenAI speech API (default `gpt-4o-mini-tts`) | cloud | OpenAI key |
| Rendering | — | FFmpeg (bundled, libass; opt-in HW encode) | **always local** | — |

The local STT/translation/TTS upgrades (`whisper-cpp`, `llama-cpp`, `neural-tts`)
and the optional **vocal separation** and **forced alignment + diarization**
stages ship as **engine packs** — see below.

## Engine packs

VideoDubber's base installer stays small (faster-whisper CPU, Argos, Piper,
FFmpeg). Heavier, optional, accelerated engines download on demand as **engine
packs** and run only when a project uses them — so capable machines can opt into
the best available engines without bloating the install. Manage them in
**Settings → Engines**; packs marked “recommended” suit the current machine
(detected from RAM/CPU/GPU). See [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md)
for the per-hardware-tier matrix behind the recommendations.

| Pack | Provides | Delivery |
|---|---|---|
| `whisper-cpp-metal` / `-cuda` / `-vulkan` | Accelerated STT (`whisper-cpp`) | native binary |
| `llama-cpp-metal` / `-cuda` / `-vulkan` | Local LLM translation **runtime** (`llama-cpp`) | native binary |
| `translategemma-4b` / `-12b` / `-27b` | **TranslateGemma** GGUF weights the runtime loads (4B from 8 GB; 12B/27B with a GPU/Apple-Silicon) | model download |
| `tts-neural` | Neural multilingual + Vietnamese voices (`neural-tts`) | uv-managed Python env |
| `tts-omnivoice` | **OmniVoice** multilingual neural voices, 600+ languages (`omnivoice`) — Apple Silicon / PyTorch MPS. **On hold**: gated out of releases pending output-quality work; see [OMNIVOICE.md](OMNIVOICE.md) | uv-managed Python env |
| `separation-audio` | Vocal/M&E separation for the “replace voices” mix | uv-managed Python env |
| `alignment-whisperx` | Word-accurate timing + speaker diarization | uv-managed Python env |

How packs run:
- **Native-binary packs** (whisper.cpp, llama.cpp) are downloaded, checksum-verified,
  extracted, and spawned as OpenAI-compatible local servers — exactly like the
  bundled FFmpeg. No Python involved.
- **`uv-env` packs** materialize a self-contained Python environment via
  [uv](https://docs.astral.sh/uv/) (the ComfyUI-Desktop pattern), so torch/ONNX
  stacks that don't freeze well still install cleanly. The installed app **bundles
  uv** (and uv fetches its own Python), so nothing needs to be preinstalled; in a
  dev/source build, install uv and the rest of the app keeps working regardless.

> **Maintainers:** the download URLs live in `enginePackCatalog.ts`. The
> `llama-cpp-*` packs use upstream binaries; the macOS Metal whisper.cpp binary
> must be built and self-hosted (ggml-org ships whisper.cpp binaries for Windows
> only). The `translategemma-*` model packs pin **community GGUF requants** (no
> official Google GGUF exists) by URL + sha256. See
> **[`ENGINE_PACKS.md`](ENGINE_PACKS.md)** for where to host and how to pin
> URLs/checksums.

> **License — TranslateGemma weights:** unlike the MIT/Apache engines, the
> TranslateGemma GGUFs are under the **Gemma Terms of Use**
> ([ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms)), **not**
> MIT/Apache. Commercial use **is** permitted, but the terms come with Google's
> **Prohibited Use Policy** that the app must pass through. The catalog flags these
> packs `licenseCategory: 'commercial-restricted'` and shows the Gemma notice
> before install; if you redistribute VideoDubber **with** the weights bundled,
> you must also ship the Gemma Terms + the NOTICE string and reflect the Use Policy
> in your EULA (see [`../NOTICE.md`](../NOTICE.md)). Argos and LibreTranslate carry
> no such obligation, which is why they stay the defaults.

The orchestrator's **EngineManager** starts a pack's server on demand, waits for
health, and — because the dubbing pipeline runs one heavy phase at a time —
**unloads other heavy engines first** (the sequential memory policy), so a 32 GB
machine can run the best STT → translation → TTS chain without exhausting RAM/VRAM.
On shutdown every engine process is stopped.

### Cloud-vs-local availability

`GET /providers` reports each provider's `available` flag:
- cloud provider → its API key is configured;
- engine-pack provider → a matching pack is installed;
- plain local provider → always available.

The wizard and Settings disable any option that isn't usable yet and tell you
what it needs (“needs API key” / “needs engine pack”).

Implementations:

- Local: `packages/node-orchestrator/src/providers/{stt,translation,tts}/…`
- Cloud: `openaiSttProvider.ts`, `llmTranslationProvider.ts`, `openaiTtsProvider.ts`
  plus the shared plumbing in `providers/cloud/cloudHttp.ts`
- Registry / selection: `packages/node-orchestrator/src/providers/registry.ts`
- `GET /providers` lists every provider with an `available` flag (local providers are
  always available; cloud ones only when their key is configured).

The local TTS worker resolves a voice **per target language** from
`PIPER_VOICES_DIR` and never reads text with a wrong-language voice — see
[`MODEL_SETUP.md` §3](MODEL_SETUP.md#3-piper-text-to-speech).

### Why the cloud adapters are SDK-free

Every cloud call is a plain `fetch` from the orchestrator. No provider SDKs are
bundled, so the **installer carries zero cloud weight** and nothing cloud-related
is even constructed until a project actually selects a cloud provider. This is the
project's lazy-loading rule: bundle what every user needs (the balanced local
engines); load anything optional on demand (models on first run, cloud per call).

---

## Cloud API keys

Add keys in **Settings → Cloud API keys**. Storage rules:

- Keys live **only** in `~/VideoDubber/credentials.json` (owner-only `0600`
  permissions), written atomically. They are **never** committed, logged, or
  returned by the API — `GET /credentials` only ever shows a masked form
  (`sk-…h1Q4`).
- Environment variables work as a read-only fallback for development:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`.
- Each service row has a **Test** button (`POST /credentials/test`) that makes the
  cheapest authenticated call (model listing) to verify the key.
- A custom `baseUrl` per service is supported (e.g. an OpenAI-compatible proxy or
  a local OpenAI-compatible server), as is a `model` override.

> ⚠️ Using a cloud provider sends that phase's data to the service: the extracted
> **audio track** for cloud STT, the **transcript text** for cloud translation, the
> **translated text** for cloud TTS. The video file itself is never uploaded.
> Review the provider's data-retention terms before enabling.

### Voice cloning is excluded

The cloud TTS adapter uses stock voices only. Cloning a real person's voice requires
that person's explicit, documented consent and a legal review, and is deliberately not
part of VideoDubber. See [`ROADMAP.md`](ROADMAP.md).

---

## Hardware-aware setup

`GET /system` probes the machine (total RAM, CPU model/cores, GPUs — best-effort via
`system_profiler` on macOS / `nvidia-smi` elsewhere) and returns a recommendation from
a pure, unit-tested function (`src/system/systemProfile.ts`):

| Machine | Tier | Local STT model | Cloud advice |
|---|---|---|---|
| < 8 GB RAM | constrained | `tiny` | Cloud STT + translation recommended |
| 8–16 GB | balanced | `base` | Local is fine |
| 16–32 GB | performance | `small` (`medium` on Apple Silicon) | Local preferred |
| ≥ 32 GB | performance | `medium` (`large-v3` possible, slow on CPU) | Local preferred |
| < 4 CPU cores | — | — | Cloud STT suggested for long videos |

TTS never gets a cloud suggestion on hardware grounds — Piper is light; cloud TTS is a
voice-quality preference.

---

## The provider interface contract

All three interfaces live in `@videodubber/shared`; orchestrator-side providers
additionally accept an optional `AbortSignal` (see `providers/types.ts`):

```ts
interface SttProvider {
  id: string; displayName: string; isLocal: boolean;
  transcribe(input: SttInput): Promise<SttResult>;
}

interface TranslationProvider {
  id: string; displayName: string; isLocal: boolean;
  translateSegments(input: TranslationInput): Promise<TranslationResult>;
}

interface TtsProvider {
  id: string; displayName: string; isLocal: boolean;
  synthesizeSegments(input: TtsInput): Promise<TtsResult>;
}
```

To add a provider: implement the interface (set `credentialService` if it needs a
cloud key), register it in `registry.ts`, and it appears in every picker
automatically. The LLM translation provider is the template to copy for new
chat-based services — one class covers OpenAI, Claude and Gemini through per-service
request builders.

---

## Choosing providers in a project

`ProjectSettings` carries the selection; the wizard seeds it from
**Settings → Processing defaults** (stored in `preferences.json` as
`providerDefaults`):

```jsonc
{
  "processingMode": "cloud-enhanced",      // DERIVED: any cloud phase => cloud-enhanced
  "sttProviderId": "faster-whisper",       // local STT
  "translationProviderId": "gemini-translate", // cloud translation
  "ttsProviderId": "piper-local",          // local TTS
  "sttModel": "base"
}
```

`processingMode` is informational — it is derived from the per-phase choices so
projects honestly record whether anything left the machine.

---

## Cloud troubleshooting

| Error code | Meaning | Fix |
|---|---|---|
| `CLOUD_CREDENTIALS_MISSING` | The phase uses a cloud provider but no key is configured | Add the key in Settings → Cloud API keys, or switch the phase to a local provider |
| `CLOUD_REQUEST_FAILED` (HTTP 401/403) | The service rejected the key | Re-check the key with the Test button; regenerate it if needed |
| `CLOUD_REQUEST_FAILED` (other) | Quota, rate limit, network, or service outage | Retry; check the provider's status page and your plan/quota |
| `WORKER_TIMEOUT` | The service didn't answer in time | Retry; long audio uploads need a stable connection |
| `ENGINE_PACK_MISSING` | The phase uses an engine that isn't installed | Install the engine pack in Settings → Engines, or pick another provider |
| `ENGINE_PACK_FAILED` | A pack download/verify/build failed | Check network + disk; retry. Corrupt downloads are discarded automatically |
| `ENGINE_UNAVAILABLE` | A local engine process didn't start/respond | Retry; if it persists, reinstall the pack or switch to a CPU provider |

All cloud and engine failures are per-step: the pipeline is resumable, so fixing the
key/pack and retrying the failed step continues from where it stopped. The bundled
local CPU providers (faster-whisper, Argos, Piper) always work offline — switching a
phase back to one of them and retrying is the universal fallback.
