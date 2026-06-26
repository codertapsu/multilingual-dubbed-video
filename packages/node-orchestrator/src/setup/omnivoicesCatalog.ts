/**
 * Static catalog of the OmniVoice "designed" voices, so the wizard can list and
 * pin a voice BEFORE the engine pack is installed (the voices ship as part of the
 * model in the pack, not as per-voice downloads).
 *
 * Unlike Piper/VieNeu, OmniVoice is massively multilingual with NO fixed preset
 * speakers — each "voice" is a Voice-Design `instruct` prompt — so the SAME set is
 * offered for EVERY target language. Mirror of the worker's authoritative list in
 * `workers/tts-engine-omnivoice/vd_omnivoice/voices.py` — keep them in sync.
 * `url`/`configUrl` are empty and `approxSizeMb` is 0 (part of the engine pack).
 */
import type { LanguageCode, PiperVoiceInfo } from '@videodubber/shared';

/** Designed-voice definitions (mirror of voices.py VOICES). */
const OMNIVOICE_VOICE_DEFS: ReadonlyArray<{ id: string; label: string; recommended?: boolean }> = [
  { id: 'omnivoice-female-calm', label: 'Female — calm narrator (default)', recommended: true },
  { id: 'omnivoice-male-warm', label: 'Male — warm' },
  { id: 'omnivoice-female-bright', label: 'Female — bright' },
  { id: 'omnivoice-male-neutral', label: 'Male — neutral' },
];

/**
 * OmniVoice voices for a language — the SAME designed set for every language
 * (OmniVoice handles ~646 languages with one model). `language` is echoed onto
 * each voice so the UI/types line up with the Piper/VieNeu shape.
 */
export function listOmnivoiceForLanguage(language: string): PiperVoiceInfo[] {
  if (!language) return [];
  return OMNIVOICE_VOICE_DEFS.map((v) => ({
    id: v.id,
    language: language as LanguageCode,
    label: v.label,
    approxSizeMb: 0,
    url: '',
    configUrl: '',
    recommended: v.recommended ?? false,
  }));
}
