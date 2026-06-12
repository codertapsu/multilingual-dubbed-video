/**
 * Static catalog of the VieNeu neural-TTS preset voices, so the wizard can list
 * and pin a neural voice BEFORE the engine pack is installed (the voices ship
 * bundled in the pack, so unlike Piper voices they are not downloaded
 * individually — the pack is what's gated/installed).
 *
 * Two variants, mirroring the worker's authoritative lists in
 * `workers/tts-engine-neural/vd_tts_engine/voices.py` — keep them in sync:
 *   - "v2": VieNeu v2 reference voices (7; CC BY-NC 4.0 / non-commercial).
 *   - "v3": VieNeu v3-Turbo preset voices (10; Apache-2.0).
 * `url`/`configUrl` are empty and `approxSizeMb` is 0 because these voices are
 * part of the engine pack, not per-voice downloads.
 */
import type { PiperVoiceInfo } from '@videodubber/shared';

/** Which VieNeu variant a voice list belongs to. */
export type NeuralVariant = 'v2' | 'v3';

const NEURAL_LANGUAGE = 'vi-VN';

function neuralVoice(id: string, label: string, recommended = false): PiperVoiceInfo {
  return { id, language: 'vi-VN', label, approxSizeMb: 0, url: '', configUrl: '', languageCode: 'vi_VN', recommended };
}

/** VieNeu v2 reference voices (mirror of voices.py V2_VOICES — 7 presets). */
export const NEURAL_VOICES_V2: readonly PiperVoiceInfo[] = [
  neuralVoice('vieneu-v2-ly', 'Trúc Ly — nữ, miền Bắc (mặc định)', true),
  neuralVoice('vieneu-v2-ngoc', 'Bích Ngọc — nữ, miền Bắc'),
  neuralVoice('vieneu-v2-doan', 'Thục Đoan — nữ, miền Nam'),
  neuralVoice('vieneu-v2-binh', 'Thanh Bình — nam, miền Bắc'),
  neuralVoice('vieneu-v2-tuyen', 'Phạm Tuyên — nam, miền Bắc'),
  neuralVoice('vieneu-v2-vinh', 'Xuân Vĩnh — nam, miền Nam'),
  neuralVoice('vieneu-v2-son', 'Thái Sơn — nam, miền Nam'),
] as const;

/** VieNeu v3-Turbo preset voices (mirror of voices.py V3_VOICES — 10 presets). */
export const NEURAL_VOICES_V3: readonly PiperVoiceInfo[] = [
  neuralVoice('vieneu-v3-ngoc-lan', 'Ngọc Lan — VieNeu (mặc định)', true),
  neuralVoice('vieneu-v3-ngoc-linh', 'Ngọc Linh — VieNeu'),
  neuralVoice('vieneu-v3-truc-ly', 'Trúc Ly — VieNeu'),
  neuralVoice('vieneu-v3-my-duyen', 'Mỹ Duyên — VieNeu'),
  neuralVoice('vieneu-v3-xuan-vinh', 'Xuân Vĩnh — VieNeu'),
  neuralVoice('vieneu-v3-thai-son', 'Thái Sơn — VieNeu'),
  neuralVoice('vieneu-v3-gia-bao', 'Gia Bảo — VieNeu'),
  neuralVoice('vieneu-v3-duc-tri', 'Đức Trí — VieNeu'),
  neuralVoice('vieneu-v3-trong-huu', 'Trọng Hữu — VieNeu'),
  neuralVoice('vieneu-v3-binh-an', 'Bình An — VieNeu'),
] as const;

function baseSubtag(language: string): string {
  return (language.split(/[-_]/)[0] ?? '').toLowerCase();
}

/** Neural voices for a language + variant (Vietnamese only). */
export function listNeuralVoicesForLanguage(language: string, variant: NeuralVariant = 'v3'): PiperVoiceInfo[] {
  if (!language || baseSubtag(language) !== baseSubtag(NEURAL_LANGUAGE)) return [];
  return variant === 'v2' ? [...NEURAL_VOICES_V2] : [...NEURAL_VOICES_V3];
}
