/**
 * The curated first-run download catalog.
 *
 * This is intentionally a static, hand-maintained list (not fetched from the
 * network) so the wizard can render instantly and offline, and so the set of
 * "supported" downloads is reviewable in code. The installer validates the
 * user's selection against this catalog before downloading anything.
 *
 * Sources:
 *   - Whisper models are faster-whisper model ids (downloaded into the HF cache
 *     by the STT worker). Sizes are approximate on-disk footprints.
 *   - Argos pairs are directed language pairs known to exist in the Argos
 *     package index.
 *   - Piper voices resolve to the rhasspy/piper-voices HuggingFace repo using
 *     the `/resolve/main/...` download URLs (the `.onnx` model + `.onnx.json`).
 */
import { COMMON_LANGUAGES, type ArgosPair, type PiperVoiceInfo, type SetupCatalog, type WhisperModelInfo } from '@videodubber/shared';

/** Base URL for raw file downloads from the rhasspy/piper-voices repo. */
const PIPER_VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** Curated faster-whisper models (smallest -> largest). `large-v3-turbo` is the
 * recommended default on capable machines: ~large-v2 accuracy at 6-8x speed. */
export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
  { id: 'tiny', label: 'Tiny (fastest, lowest accuracy)', approxSizeMb: 75 },
  { id: 'base', label: 'Base (balanced; good on 8 GB)', approxSizeMb: 145 },
  { id: 'small', label: 'Small (better accuracy)', approxSizeMb: 484 },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo (recommended: near-best accuracy, 6-8x faster)',
    approxSizeMb: 1620,
    recommended: true,
  },
  { id: 'distil-large-v3.5', label: 'Distil Large v3.5 (English only, fastest large)', approxSizeMb: 760 },
  { id: 'medium', label: 'Medium (high accuracy, slower)', approxSizeMb: 1530 },
  { id: 'large-v3', label: 'Large v3 (best accuracy, slowest)', approxSizeMb: 3090 },
  // Vietnamese-specialist (VinAI PhoWhisper); pin when the SOURCE video is vi.
  { id: 'phowhisper-medium', label: 'PhoWhisper Medium (best for Vietnamese-source audio)', approxSizeMb: 1530 },
  { id: 'phowhisper-large', label: 'PhoWhisper Large (Vietnamese-source, highest accuracy)', approxSizeMb: 3090 },
] as const;

/**
 * Curated, known-downloadable Argos translation pairs.
 *
 * English is the hub for Argos: most pairs route through English, so we offer
 * en->X (and X->en) for the common targets plus a couple of direct pairs.
 */
export const ARGOS_AVAILABLE: readonly ArgosPair[] = [
  { from: 'en', to: 'vi' },
  { from: 'vi', to: 'en' },
  { from: 'en', to: 'es' },
  { from: 'es', to: 'en' },
  { from: 'en', to: 'fr' },
  { from: 'fr', to: 'en' },
  { from: 'en', to: 'de' },
  { from: 'de', to: 'en' },
  { from: 'en', to: 'pt' },
  { from: 'pt', to: 'en' },
  { from: 'en', to: 'ru' },
  { from: 'ru', to: 'en' },
  { from: 'en', to: 'ja' },
  { from: 'ja', to: 'en' },
  { from: 'en', to: 'ko' },
  { from: 'ko', to: 'en' },
  { from: 'en', to: 'zh' },
  { from: 'zh', to: 'en' },
  { from: 'en', to: 'ar' },
  { from: 'ar', to: 'en' },
  { from: 'en', to: 'hi' },
  { from: 'hi', to: 'en' },
  { from: 'en', to: 'id' },
  { from: 'id', to: 'en' },
] as const;

/** Build the `.onnx` + `.onnx.json` resolve URLs for a piper voice file path. */
function piperUrls(filePath: string): { url: string; configUrl: string } {
  const url = `${PIPER_VOICES_BASE}/${filePath}`;
  return { url, configUrl: `${url}.json` };
}

/** Curated Piper voices (incl. the Vietnamese vais1000 medium voice). */
export const PIPER_VOICES: readonly PiperVoiceInfo[] = [
  {
    id: 'vi_VN-vais1000-medium',
    language: 'vi-VN',
    label: 'Vietnamese — vais1000 (medium)',
    approxSizeMb: 64,
    ...piperUrls('vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx'),
  },
  {
    id: 'en_US-lessac-medium',
    language: 'en-US',
    label: 'English (US) — lessac (medium)',
    approxSizeMb: 64,
    ...piperUrls('en/en_US/lessac/medium/en_US-lessac-medium.onnx'),
  },
  {
    id: 'es_ES-davefx-medium',
    language: 'es',
    label: 'Spanish (ES) — davefx (medium)',
    approxSizeMb: 64,
    ...piperUrls('es/es_ES/davefx/medium/es_ES-davefx-medium.onnx'),
  },
  {
    id: 'fr_FR-siwis-medium',
    language: 'fr',
    label: 'French — siwis (medium)',
    approxSizeMb: 64,
    ...piperUrls('fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx'),
  },
  {
    id: 'de_DE-thorsten-medium',
    language: 'de',
    label: 'German — thorsten (medium)',
    approxSizeMb: 64,
    ...piperUrls('de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx'),
  },
] as const;

/** Build the full, immutable first-run catalog. */
export function buildCatalog(): SetupCatalog {
  return {
    whisperModels: [...WHISPER_MODELS],
    languages: [...COMMON_LANGUAGES],
    argosAvailable: [...ARGOS_AVAILABLE],
    piperVoices: [...PIPER_VOICES],
  };
}

/** Look up a curated Piper voice by id (used by the installer to validate). */
export function findPiperVoice(voiceId: string): PiperVoiceInfo | undefined {
  return PIPER_VOICES.find((v) => v.id === voiceId);
}

/** Look up a curated whisper model by id. */
export function findWhisperModel(modelId: string): WhisperModelInfo | undefined {
  return WHISPER_MODELS.find((m) => m.id === modelId);
}
