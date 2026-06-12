"""The VieNeu v3-Turbo preset voice catalog the engine advertises.

VieNeu-TTS v3-Turbo ships named preset Vietnamese speaker voices addressed by
name (no reference clip needed). We surface them as stable voice ids of the form
``vieneu-<slug>`` so a project can pin one (``settings.ttsVoiceId``) and the
orchestrator/UI can list them; ``sdk_name`` is the exact preset name passed to
``vieneu``'s ``infer(voice=…)``.

This is mirrored (read-only) in the orchestrator's ``neuralVoicesCatalog.ts`` so
the wizard can show these voices BEFORE the pack is installed — keep them in
sync. The worker's ``GET /voices`` is authoritative at runtime.
"""

from __future__ import annotations

from dataclasses import dataclass

# Language this engine speaks (VieNeu is Vietnamese-native; v3 also code-switches
# English). Used to filter GET /voices?language=… on the base subtag.
ENGINE_LANGUAGE = "vi-VN"
ENGINE_NAME = "vieneu"


@dataclass(frozen=True)
class NeuralVoice:
    id: str  # stable id for pinning, e.g. "vieneu-ngoc-lan"
    sdk_name: str  # exact preset name passed to vieneu .infer(voice=…)
    display_name: str
    recommended: bool = False


# The 10 v3-Turbo preset voices. `sdk_name` must match the SDK's preset names;
# the engine falls back to the SDK default voice if a name is rejected, so the
# set stays functional even as the upstream preset list evolves.
VOICES: tuple[NeuralVoice, ...] = (
    NeuralVoice("vieneu-ngoc-lan", "Ngọc Lan", "Ngọc Lan (mặc định)", recommended=True),
    NeuralVoice("vieneu-ngoc-linh", "Ngọc Linh", "Ngọc Linh"),
    NeuralVoice("vieneu-truc-ly", "Trúc Ly", "Trúc Ly"),
    NeuralVoice("vieneu-my-duyen", "Mỹ Duyên", "Mỹ Duyên"),
    NeuralVoice("vieneu-xuan-vinh", "Xuân Vĩnh", "Xuân Vĩnh"),
    NeuralVoice("vieneu-thai-son", "Thái Sơn", "Thái Sơn"),
    NeuralVoice("vieneu-gia-bao", "Gia Bảo", "Gia Bảo"),
    NeuralVoice("vieneu-duc-tri", "Đức Trí", "Đức Trí"),
    NeuralVoice("vieneu-trong-huu", "Trọng Hữu", "Trọng Hữu"),
    NeuralVoice("vieneu-binh-an", "Bình An", "Bình An"),
)

_BY_ID = {v.id: v for v in VOICES}


def base_subtag(language: str) -> str:
    return (language.split("-")[0].split("_")[0] if language else "").lower()


def voices_for_language(language: str | None) -> list[NeuralVoice]:
    """Voices for a language (matched on the base subtag). VieNeu is Vietnamese."""
    if not language:
        return list(VOICES)
    if base_subtag(language) == base_subtag(ENGINE_LANGUAGE):
        return list(VOICES)
    return []


def resolve(voice_id: str | None) -> NeuralVoice:
    """Resolve a voice id to a preset, defaulting to the recommended one.

    Accepts a bare id ("vieneu-ngoc-lan"), an engine-prefixed id
    ("vieneu:vieneu-ngoc-lan"), or None.
    """
    default = next((v for v in VOICES if v.recommended), VOICES[0])
    if not voice_id:
        return default
    vid = voice_id.strip()
    if ":" in vid:
        vid = vid.split(":", 1)[1].strip()
    return _BY_ID.get(vid, default)
