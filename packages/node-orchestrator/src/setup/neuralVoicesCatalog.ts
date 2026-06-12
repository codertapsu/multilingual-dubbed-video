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

/** Build a neural (VieNeu) voice entry — voices ship in the pack, not per-voice. */
function neuralVoice(id: string, label: string, recommended = false): PiperVoiceInfo {
  return { id, language: 'vi-VN', label, approxSizeMb: 0, url: '', configUrl: '', languageCode: 'vi_VN', recommended };
}

/** VieNeu v3-Turbo preset voices (mirror of voices.py VOICES — 10 presets). */
export const NEURAL_VOICES: readonly PiperVoiceInfo[] = [
  neuralVoice('vieneu-ngoc-lan', 'Ngọc Lan — VieNeu (mặc định)', true),
  neuralVoice('vieneu-ngoc-linh', 'Ngọc Linh — VieNeu'),
  neuralVoice('vieneu-truc-ly', 'Trúc Ly — VieNeu'),
  neuralVoice('vieneu-my-duyen', 'Mỹ Duyên — VieNeu'),
  neuralVoice('vieneu-xuan-vinh', 'Xuân Vĩnh — VieNeu'),
  neuralVoice('vieneu-thai-son', 'Thái Sơn — VieNeu'),
  neuralVoice('vieneu-gia-bao', 'Gia Bảo — VieNeu'),
  neuralVoice('vieneu-duc-tri', 'Đức Trí — VieNeu'),
  neuralVoice('vieneu-trong-huu', 'Trọng Hữu — VieNeu'),
  neuralVoice('vieneu-binh-an', 'Bình An — VieNeu'),
] as const;

function baseSubtag(language: string): string {
  return (language.split(/[-_]/)[0] ?? '').toLowerCase();
}

/** Neural voices for a language (Vietnamese only); matched on the base subtag. */
export function listNeuralVoicesForLanguage(language: string): PiperVoiceInfo[] {
  if (!language) return [];
  return baseSubtag(language) === baseSubtag(NEURAL_LANGUAGE) ? [...NEURAL_VOICES] : [];
}
