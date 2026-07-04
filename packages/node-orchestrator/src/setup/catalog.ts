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
import { COMMON_LANGUAGES, type ArgosPair, type CommonLanguage, type PiperVoiceInfo, type SetupCatalog, type WhisperModelInfo } from '@videodubber/shared';

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

/**
 * Languages the local Argos engine can translate to/from (the dropdowns should
 * only offer these, so users can't pick a pair Argos can't do). A language is
 * translatable iff it reaches English in {@link ARGOS_AVAILABLE} (the hub) — any
 * two such languages then work via the English pivot. Returns the curated
 * {@link COMMON_LANGUAGES} filtered to that set.
 */
export function translatableLanguages(): CommonLanguage[] {
  const hub = new Set<string>(['en']);
  for (const p of ARGOS_AVAILABLE) {
    if (p.from === 'en') hub.add(p.to);
    if (p.to === 'en') hub.add(p.from);
  }
  const base = (code: string) => (code.split('-')[0] ?? '').toLowerCase();
  return COMMON_LANGUAGES.filter((l) => hub.has(base(l.code)));
}

/** Build the `.onnx` + `.onnx.json` resolve URLs for a piper voice file path. */
function piperUrls(filePath: string): { url: string; configUrl: string } {
  const url = `${PIPER_VOICES_BASE}/${filePath}`;
  return { url, configUrl: `${url}.json` };
}

/**
 * Curated DEFAULT Piper voices — the recommended single-speaker, medium-quality
 * voice per common target language (the best widely-used model for each). These
 * are the "instant, offline" defaults shown first; the FULL per-language catalog
 * (any voice) lives in `voicesCatalog.ts` and is downloaded on demand.
 *
 * Vietnamese note: `vi_VN-vais1000-medium` is the ONLY medium-quality Vietnamese
 * voice Piper ships (the alternatives are low / x_low; `vivos` is also 65-speaker
 * which the dub can't address), so it's the clear VI default.
 */
export const PIPER_VOICES: readonly PiperVoiceInfo[] = [
  {
    id: 'vi_VN-vais1000-medium',
    language: 'vi-VN',
    label: 'Vietnamese — vais1000 (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx'),
  },
  {
    id: 'en_US-lessac-medium',
    language: 'en-US',
    label: 'English (US) — lessac (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('en/en_US/lessac/medium/en_US-lessac-medium.onnx'),
  },
  {
    id: 'en_GB-alan-medium',
    language: 'en-GB',
    label: 'English (GB) — alan (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('en/en_GB/alan/medium/en_GB-alan-medium.onnx'),
  },
  {
    id: 'es_ES-davefx-medium',
    language: 'es',
    label: 'Spanish (ES) — davefx (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('es/es_ES/davefx/medium/es_ES-davefx-medium.onnx'),
  },
  {
    id: 'fr_FR-siwis-medium',
    language: 'fr',
    label: 'French — siwis (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx'),
  },
  {
    id: 'de_DE-thorsten-medium',
    language: 'de',
    label: 'German — thorsten (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx'),
  },
  {
    id: 'zh_CN-huayan-medium',
    language: 'zh-CN',
    label: 'Chinese (CN) — huayan (medium)',
    approxSizeMb: 64,
    quality: 'medium',
    recommended: true,
    ...piperUrls('zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx'),
  },
] as const;

/** Build the full, immutable first-run catalog. */
export function buildCatalog(): SetupCatalog {
  return {
    whisperModels: [...WHISPER_MODELS],
    // Only languages Argos can translate (the onboarding dropdowns use these).
    languages: translatableLanguages(),
    argosAvailable: [...ARGOS_AVAILABLE],
    piperVoices: [...PIPER_VOICES],
  };
}

/** Look up a curated Piper voice by id (used by the installer to validate). */
export function findPiperVoice(voiceId: string): PiperVoiceInfo | undefined {
  return PIPER_VOICES.find((v) => v.id === voiceId);
}

/**
 * The recommended default Piper voice for a target language (exact locale first,
 * then the base subtag) — the voice the TTS worker auto-selects when no voice is
 * pinned. Used to treat that voice as a REQUIRED resource so a default dub never
 * falls through to silent/fallback audio for want of a downloaded voice.
 */
export function recommendedPiperVoice(language: string | undefined): PiperVoiceInfo | undefined {
  if (!language) return undefined;
  const exact = PIPER_VOICES.find((v) => v.language === language && v.recommended);
  if (exact) return exact;
  const baseOf = (lang: string) => (lang.split(/[-_]/)[0] ?? lang).toLowerCase();
  const base = baseOf(language);
  return PIPER_VOICES.find((v) => baseOf(v.language) === base && v.recommended);
}

/** Look up a curated whisper model by id. */
export function findWhisperModel(modelId: string): WhisperModelInfo | undefined {
  return WHISPER_MODELS.find((m) => m.id === modelId);
}
