"""VieNeu preset voice catalogs for the v2 and v3 engine variants.

The vd_tts_engine worker runs ONE of two VieNeu model variants, selected by the
``VIENEU_VARIANT`` env var the orchestrator sets per engine pack:
  - "v3" (default): VieNeu-TTS v3-Turbo, 48 kHz, Apache-2.0. 10 presets,
    default "Ngọc Lan".
  - "v2": VieNeu-TTS v2, 24 kHz. The 7 reference voices come from the model's
    voices.json — license CC BY-NC 4.0 (NON-COMMERCIAL, attribution to
    pnnbao-ump). Default "Ly" (Trúc Ly).

Voice ids are stable (``vieneu-v{N}-<slug>``) for pinning; ``sdk_name`` is the
exact preset key the ``vieneu`` SDK expects (v2: voices.json key like "Ly";
v3: the display name like "Ngọc Lan"). Mirrored read-only in the orchestrator's
``neuralVoicesCatalog.ts`` — keep in sync. The worker's GET /voices is
authoritative at runtime.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

ENGINE_LANGUAGE = "vi-VN"
ENGINE_NAME = "vieneu"
DEFAULT_VARIANT = "v3"


@dataclass(frozen=True)
class NeuralVoice:
    id: str  # stable id for pinning, e.g. "vieneu-v2-ly"
    sdk_name: str  # exact preset key the vieneu SDK expects
    display_name: str
    recommended: bool = False


# --- VieNeu v2 reference voices (voices.json presets; keys ARE the SDK ids) ---
# CC BY-NC 4.0 (non-commercial). default_voice = "Ly".
V2_VOICES: tuple[NeuralVoice, ...] = (
    NeuralVoice("vieneu-v2-ly", "Ly", "Trúc Ly — nữ, miền Bắc (mặc định)", recommended=True),
    NeuralVoice("vieneu-v2-ngoc", "Ngoc", "Bích Ngọc — nữ, miền Bắc"),
    NeuralVoice("vieneu-v2-doan", "Doan", "Thục Đoan — nữ, miền Nam"),
    NeuralVoice("vieneu-v2-binh", "Binh", "Thanh Bình — nam, miền Bắc"),
    NeuralVoice("vieneu-v2-tuyen", "Tuyen", "Phạm Tuyên — nam, miền Bắc"),
    NeuralVoice("vieneu-v2-vinh", "Vinh", "Xuân Vĩnh — nam, miền Nam"),
    NeuralVoice("vieneu-v2-son", "Sơn", "Thái Sơn — nam, miền Nam"),
)

# --- VieNeu v3-Turbo preset voices (Apache-2.0). default "Ngọc Lan". ---
V3_VOICES: tuple[NeuralVoice, ...] = (
    NeuralVoice("vieneu-v3-ngoc-lan", "Ngọc Lan", "Ngọc Lan (mặc định)", recommended=True),
    NeuralVoice("vieneu-v3-ngoc-linh", "Ngọc Linh", "Ngọc Linh"),
    NeuralVoice("vieneu-v3-truc-ly", "Trúc Ly", "Trúc Ly"),
    NeuralVoice("vieneu-v3-my-duyen", "Mỹ Duyên", "Mỹ Duyên"),
    NeuralVoice("vieneu-v3-xuan-vinh", "Xuân Vĩnh", "Xuân Vĩnh"),
    NeuralVoice("vieneu-v3-thai-son", "Thái Sơn", "Thái Sơn"),
    NeuralVoice("vieneu-v3-gia-bao", "Gia Bảo", "Gia Bảo"),
    NeuralVoice("vieneu-v3-duc-tri", "Đức Trí", "Đức Trí"),
    NeuralVoice("vieneu-v3-trong-huu", "Trọng Hữu", "Trọng Hữu"),
    NeuralVoice("vieneu-v3-binh-an", "Bình An", "Bình An"),
)

_VARIANTS: dict[str, tuple[NeuralVoice, ...]] = {"v2": V2_VOICES, "v3": V3_VOICES}


def current_variant() -> str:
    """The variant this worker serves (VIENEU_VARIANT env; defaults to v3)."""
    v = (os.environ.get("VIENEU_VARIANT") or DEFAULT_VARIANT).strip().lower()
    return v if v in _VARIANTS else DEFAULT_VARIANT


def variant_voices(variant: str) -> tuple[NeuralVoice, ...]:
    return _VARIANTS.get(variant, V3_VOICES)


def base_subtag(language: str) -> str:
    return (language.split("-")[0].split("_")[0] if language else "").lower()


def voices_for_language(variant: str, language: str | None) -> list[NeuralVoice]:
    """Voices for a language (matched on the base subtag). VieNeu is Vietnamese."""
    if language and base_subtag(language) != base_subtag(ENGINE_LANGUAGE):
        return []
    return list(variant_voices(variant))


def resolve(variant: str, voice_id: str | None) -> NeuralVoice:
    """Resolve a voice id within the variant's set, defaulting to the recommended.

    Accepts a bare id ("vieneu-v2-ly"), an engine-prefixed id
    ("vieneu:vieneu-v2-ly"), or None.
    """
    vs = variant_voices(variant)
    default = next((v for v in vs if v.recommended), vs[0])
    if not voice_id:
        return default
    vid = voice_id.strip()
    if ":" in vid:
        vid = vid.split(":", 1)[1].strip()
    return {v.id: v for v in vs}.get(vid, default)
