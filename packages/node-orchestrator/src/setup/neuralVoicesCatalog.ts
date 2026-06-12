/**
 * Static catalog of the VieNeu neural-TTS preset voices, so the wizard can list
 * and pin a neural voice BEFORE the `tts-neural` engine pack is installed (the
 * voices ship bundled in the pack, so unlike Piper voices they are not
 * downloaded individually — the pack is what's gated/installed).
 *
 * This MIRRORS the worker's authoritative list in
 * `workers/tts-engine-neural/vd_tts_engine/voices.py` — keep the two in sync.
 * `url`/`configUrl` are empty and `approxSizeMb` is 0 because these voices are
 * part of the engine pack, not per-voice downloads.
 */
import type { PiperVoiceInfo } from '@videodubber/shared';

/** The neural engine speaks Vietnamese. */
const NEURAL_LANGUAGE = 'vi-VN';

/** VieNeu preset voices (mirror of voices.py VOICES). */
export const NEURAL_VOICES: readonly PiperVoiceInfo[] = [
  {
    id: 'vieneu-ngoc-huyen',
    language: 'vi-VN',
    label: 'Ngọc Huyền — VieNeu (nữ, miền Bắc)',
    approxSizeMb: 0,
    url: '',
    configUrl: '',
    languageCode: 'vi_VN',
    recommended: true,
  },
  {
    id: 'vieneu-xuan-vinh',
    language: 'vi-VN',
    label: 'Xuân Vĩnh — VieNeu (nam, miền Bắc)',
    approxSizeMb: 0,
    url: '',
    configUrl: '',
    languageCode: 'vi_VN',
  },
  {
    id: 'vieneu-ngoc-lan',
    language: 'vi-VN',
    label: 'Ngọc Lan — VieNeu (nữ, miền Nam)',
    approxSizeMb: 0,
    url: '',
    configUrl: '',
    languageCode: 'vi_VN',
  },
  {
    id: 'vieneu-minh-quan',
    language: 'vi-VN',
    label: 'Minh Quân — VieNeu (nam, miền Nam)',
    approxSizeMb: 0,
    url: '',
    configUrl: '',
    languageCode: 'vi_VN',
  },
] as const;

function baseSubtag(language: string): string {
  return (language.split(/[-_]/)[0] ?? '').toLowerCase();
}

/** Neural voices for a language (Vietnamese only); matched on the base subtag. */
export function listNeuralVoicesForLanguage(language: string): PiperVoiceInfo[] {
  if (!language) return [];
  return baseSubtag(language) === baseSubtag(NEURAL_LANGUAGE) ? [...NEURAL_VOICES] : [];
}
