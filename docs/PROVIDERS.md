# Providers

VideoDubber's three replaceable capabilities — **speech-to-text (STT)**,
**translation**, and **text-to-speech (TTS)** — are implemented behind small TypeScript
interfaces and selected per project by id. The default is **always local**. Cloud
providers are optional, opt-in scaffolds.

---

## Cost-first philosophy

> **Prefer local. Cloud is opt-in only.**

- The default `processingMode` is **`local`**: faster-whisper + Argos Translate +
  Piper/system/fallback. Zero marginal cost, fully offline, nothing leaves your machine.
- A future **`cloud-enhanced`** mode lets you opt **specific steps** into higher-quality
  cloud providers, gated by the relevant API key. You never have to send everything to
  the cloud — you choose per capability.
- Cloud helps most when **quality** matters more than cost: a hard-to-transcribe accent
  (cloud STT), an unusual or low-resource language pair (cloud MT), or a more natural
  target voice (cloud TTS). For most local-language dubbing, the local stack is
  sufficient and free.
- **No keys, no cloud.** If a cloud key is absent, that provider is simply unavailable;
  the app stays fully functional on local engines.

---

## Local provider defaults

| Capability | Provider id | Engine | Worker / port | `isLocal` |
|---|---|---|---|---|
| STT | `faster-whisper` | faster-whisper (CTranslate2, int8 CPU) | STT worker `:5101` | ✅ |
| Translation | `argos` | Argos Translate (offline neural MT) | Translation worker `:5102` | ✅ |
| TTS | `local` | Piper → system (`say`/`espeak-ng`) → silent/sine fallback | TTS worker `:5103` | ✅ |

Implementations:

- `packages/node-orchestrator/src/providers/stt/fasterWhisperProvider.ts`
- `packages/node-orchestrator/src/providers/translation/argosProvider.ts`
- `packages/node-orchestrator/src/providers/tts/localTtsProvider.ts`
- Shared HTTP client: `packages/node-orchestrator/src/providers/workerHttp.ts`
- Registry / selection: `packages/node-orchestrator/src/providers/registry.ts`

The TTS worker chooses an engine at run time in this priority order:

1. **Piper** — when `PIPER_BINARY_PATH` + `PIPER_VOICE_MODEL_PATH` are set.
2. **System TTS** — macOS `say` (aiff → wav), Linux `espeak-ng`.
3. **Dev fallback** — a silent (or soft sine) WAV sized to the segment window so the
   alignment / mix / render steps still run.

---

## The provider interface contract

All three interfaces live in `@videodubber/shared` and share the same shape: an id, a
display name, an `isLocal` flag, and one async method.

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

I/O types (also in `@videodubber/shared`):

- **STT** — `SttInput { audioPath, language?, model, wordTimestamps }` →
  `SttResult { segments, detectedLanguage, durationMs }`.
- **Translation** — `TranslationInput { sourceLanguage, targetLanguage, segments[], glossary? }`
  → `TranslationResult { segments:[{ id, translatedText }] }` (ids/order preserved).
- **TTS** — `TtsInput { language, voiceId?, segments[], outputDir, speed? }` →
  `TtsResult { segments: TtsSegment[] }`.

The orchestrator's registry picks an implementation by the `sttProviderId`,
`translationProviderId`, and `ttsProviderId` fields of `ProjectSettings`. To add a
provider, implement the interface and register it in `registry.ts`.

---

## Optional cloud providers (placeholder architecture)

Cloud adapters are **scaffolded placeholders** — they implement the interfaces but are
not functional and are not wired into the default pipeline. They live in:

```
packages/node-orchestrator/src/providers/cloudPlaceholders.ts
```

Each adapter carries clear `TODO`s and reads its API key from the environment. They are
intended for the future `cloud-enhanced` processing mode. Activating them is an explicit,
key-gated opt-in; absent a key, the provider stays unavailable and local providers are
used.

### Cloud env vars + what data each would send

> ⚠️ Enabling any of these sends data off your machine to a third party. Only set a key
> if you intend to use that provider, and review the provider's privacy/data-retention
> terms first. **Never commit real keys.** VideoDubber does not log secrets.

| Provider | Env var(s) | Could power | Data that would be sent |
|---|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | STT (Whisper API), translation (chat), TTS | Extracted **audio** for STT; **source text** for translation; **target text** for TTS. |
| **DeepL** | `DEEPL_API_KEY` | Translation | **Source segment text** (+ optional glossary). No audio. |
| **Google Cloud** | `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON path) | STT, translation, TTS | **Audio** (Speech-to-Text); **source text** (Translation); **target text** (Text-to-Speech). |
| **Azure Speech** | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | STT, TTS | **Audio** (STT); **target text** (neural TTS). |
| **ElevenLabs** | `ELEVENLABS_API_KEY` | TTS | **Target text** and chosen voice id. (Voice cloning is **out of scope** — see below.) |

Minimization principles for any cloud path:

- Only the data strictly needed for that step is sent (audio for STT, text for MT/TTS).
- The original video file is **never** uploaded; at most the extracted audio for STT.
- Local processing remains the default and the fallback.

### Voice cloning is excluded

None of the cloud TTS scaffolds enable **voice cloning**. Cloning a real person's voice
requires that person's **explicit, documented consent** and a legal review, and is
deliberately not part of VideoDubber. See [`ROADMAP.md`](ROADMAP.md) and the disclaimer
in the [README](../README.md#legal--usage-disclaimer).

---

## Choosing providers in a project

`ProjectSettings` carries the selection:

```jsonc
{
  "processingMode": "local",          // "local" | "cloud-enhanced"
  "sttProviderId": "faster-whisper",
  "translationProviderId": "argos",
  "ttsProviderId": "local",
  "ttsVoiceId": "vi_VN-vais1000-medium",  // optional
  "sttModel": "small"                      // optional
}
```

Keep `processingMode: "local"` for the free, offline, private default. See
[`MODEL_SETUP.md`](MODEL_SETUP.md) for getting the local models, and
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for provider-related error codes.
