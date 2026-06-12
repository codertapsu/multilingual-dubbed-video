"""The VieNeu preset voice catalog the engine advertises.

VieNeu-TTS ships a set of preset Vietnamese speaker voices (instant voice
cloning conditioned on a short reference clip bundled in the model repo). We
surface them as stable voice ids of the form ``vieneu-<slug>`` so a project can
pin one (``settings.ttsVoiceId``) and the orchestrator/UI can list them.

Each entry's ``ref`` is the preset key looked up in the model's ``voices.json``
to resolve the reference clip at synthesis time (see ``engine.py``). The same
list is mirrored (read-only) in the orchestrator's ``neuralVoicesCatalog.ts`` so
the wizard can show these voices BEFORE the pack is installed — keep them in
sync.
"""

from __future__ import annotations

from dataclasses import dataclass

# Language this engine speaks (VieNeu is Vietnamese-native). Used to filter
# GET /voices?language=… on the base subtag.
ENGINE_LANGUAGE = "vi-VN"
ENGINE_NAME = "vieneu"


@dataclass(frozen=True)
class NeuralVoice:
    id: str
    display_name: str
    gender: str  # "female" | "male"
    region: str  # "north" | "south" | "central"
    ref: str  # preset key resolved against the model's voices.json
    recommended: bool = False


# Preset Vietnamese voices. `ref` keys map to the model repo's voices.json; the
# engine falls back to its first available preset if a key is absent, so the set
# stays functional even as the upstream preset list evolves.
VOICES: tuple[NeuralVoice, ...] = (
    NeuralVoice("vieneu-ngoc-huyen", "Ngọc Huyền (nữ, miền Bắc)", "female", "north", "ngoc_huyen", recommended=True),
    NeuralVoice("vieneu-xuan-vinh", "Xuân Vĩnh (nam, miền Bắc)", "male", "north", "xuan_vinh"),
    NeuralVoice("vieneu-ngoc-lan", "Ngọc Lan (nữ, miền Nam)", "female", "south", "ngoc_lan"),
    NeuralVoice("vieneu-minh-quan", "Minh Quân (nam, miền Nam)", "male", "south", "minh_quan"),
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

    Accepts a bare id ("vieneu-ngoc-huyen"), an engine-prefixed id
    ("vieneu:vieneu-ngoc-huyen" / "neutts:…"), or None.
    """
    default = next((v for v in VOICES if v.recommended), VOICES[0])
    if not voice_id:
        return default
    vid = voice_id.strip()
    if ":" in vid:
        vid = vid.split(":", 1)[1].strip()
    return _BY_ID.get(vid, default)
