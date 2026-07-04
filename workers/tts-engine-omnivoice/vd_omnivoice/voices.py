"""OmniVoice "designed voice" catalog + language mapping.

Unlike Piper (per-language preset voices) or VieNeu (Vietnamese only), OmniVoice
is a massively multilingual zero-shot model: one model speaks 600+ languages and
there are no fixed preset speakers. We therefore expose a small set of DESIGNED
voices — each a Voice-Design ``instruct`` (trained speaker ATTRIBUTES) plus a
fixed random seed so the same speaker timbre is reproduced across every segment of
a dub (a different speaker per line would make the dub incoherent). The same voice
set is offered for ANY target language.

Reference-audio voice cloning (matching the original speaker) is a deliberate
FUTURE addition via ``ref_audio`` / ``ref_text``; this catalog is Voice-Design only.
"""

from __future__ import annotations

from dataclasses import dataclass

ENGINE_NAME = "omnivoice"
# OmniVoice is multilingual; the worker reports this sentinel rather than a single
# language. The voice list is the same for every language the model supports.
ENGINE_LANGUAGE = "multi"


@dataclass(frozen=True)
class DesignedVoice:
    id: str  # stable id for pinning, e.g. "omnivoice-female-calm"
    instruct: str  # OmniVoice "Voice Design" prompt describing the speaker
    display_name: str
    # Fixed seed so the zero-shot speaker identity is reproduced for every segment
    # (consistency across a dub), not re-sampled per line.
    seed: int
    recommended: bool = False


# Each ``instruct`` MUST use ONLY OmniVoice's TRAINED Voice-Design attributes —
# the model VALIDATES the instruct against a closed vocabulary and raises on any
# unknown tag (see omnivoice/utils/voice_design.py). Valid categories, one tag each:
#   gender : male | female
#   age    : child | teenager | young adult | middle-aged | elderly
#   pitch  : very low | low | moderate | high | very high  (+ " pitch")
#   style  : whisper
#   accent : american/british/…/japanese accent   dialect (ZH): 四川话, …
# Made-up descriptors ("bright", "warm", "calm", "neutral", "gentle", "clear",
# "natural") are NOT trained tags — they push the model out of distribution and
# degrade quality. The PITCH tag also anchors gender so the speaker doesn't drift
# male<->female across a dub's segments. Verified consistent (F0 std ~24, no
# gender flips), audible, leak-free, and intelligible on the PyTorch/MPS pipeline.
VOICES: tuple[DesignedVoice, ...] = (
    DesignedVoice(
        "omnivoice-female-calm",
        "female, middle-aged, moderate pitch",
        "Female — calm narrator (default)",
        seed=7,
        recommended=True,
    ),
    DesignedVoice(
        "omnivoice-male-warm",
        "male, middle-aged, low pitch",
        "Male — warm",
        seed=13,
    ),
    DesignedVoice(
        "omnivoice-female-bright",
        "female, young adult, high pitch",
        "Female — bright",
        seed=21,
    ),
    DesignedVoice(
        "omnivoice-male-neutral",
        "male, young adult, moderate pitch",
        "Male — neutral",
        seed=34,
    ),
)


def base_subtag(language: str | None) -> str:
    return (language.split("-")[0].split("_")[0] if language else "").lower()


# BCP-47 base subtag -> the language NAME OmniVoice's `language` param expects
# (the capitalized English name from docs/lang_id_name_map.tsv, e.g. "Vietnamese").
# OmniVoice covers 600+ languages; this maps the app's common set. An UNKNOWN
# subtag maps to None -> we pass no language and the model AUTO-DETECTS from the
# text (more robust than forcing a wrong language).
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "vi": "Vietnamese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "ar": "Arabic",
    "hi": "Hindi",
    "id": "Indonesian",
    "th": "Thai",
    "nl": "Dutch",
    "pl": "Polish",
    "tr": "Turkish",
}


def language_name(language: str | None) -> str | None:
    """Map a BCP-47-ish code (e.g. 'vi-VN') to OmniVoice's language name, or None
    (unknown -> let the model auto-detect from the text)."""
    return _LANGUAGE_NAMES.get(base_subtag(language))


def voices_for_language(_language: str | None = None) -> list[DesignedVoice]:
    """OmniVoice is multilingual, so the designed-voice set is the same for every
    language. (`language` is accepted for contract symmetry with the other TTS
    workers, which filter by language.)"""
    return list(VOICES)


def resolve(voice_id: str | None) -> DesignedVoice:
    """Resolve a voice id to a DesignedVoice, defaulting to the recommended one.

    Accepts a bare id ("omnivoice-female-calm"), an engine-prefixed id
    ("omnivoice:omnivoice-female-calm"), or None.
    """
    default = next((v for v in VOICES if v.recommended), VOICES[0])
    if not voice_id:
        return default
    vid = voice_id.strip()
    if ":" in vid:
        vid = vid.split(":", 1)[1].strip()
    return {v.id: v for v in VOICES}.get(vid, default)
