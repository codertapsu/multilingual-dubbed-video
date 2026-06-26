"""OmniVoice "designed voice" catalog + language mapping.

Unlike Piper (per-language preset voices) or VieNeu (Vietnamese only), OmniVoice
is a massively multilingual zero-shot model: one model speaks ~646 languages and
there are no fixed preset speakers. We therefore expose a small set of DESIGNED
voices — each a natural-language ``instruct`` description (OmniVoice "Voice
Design") plus a fixed random seed so the same speaker timbre is reproduced across
every segment of a dub (a different speaker per line would make the dub
incoherent). The same voice set is offered for ANY target language.

Reference-audio voice cloning (matching the original speaker) is a deliberate
FUTURE addition — the current MLX checkpoint ships an incomplete audio-encoder,
so cloning is not wired yet (see engine.py).
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


# Each ``instruct`` is OmniVoice's official Voice-Design format: SHORT,
# comma-separated speaker ATTRIBUTES (gender, age, pitch, style) — per
# k2-fsa/OmniVoice docs/voice-design.md ("female, young adult, high pitch").
# Two hard-won rules, both verified on the bf16 checkpoint with dub-fitting on:
#
#   1. Keep it to a few attribute words. A long DESCRIPTIVE SENTENCE (e.g. "A
#      calm, clear adult female narrator voice, natural and friendly.") gets
#      VOCALISED into the speech when an explicit duration_s is also passed
#      (the dub-fitting path always passes one) — the words "calm clear adult
#      ... friendly" leak into the audio. Terse attributes do not leak.
#
#   2. Anchor PITCH explicitly ("high pitch" for female, "low pitch" for male).
#      Vague pitch ("medium pitch"/"neutral") lets the zero-shot speaker DRIFT
#      across segments — in one real dub the sentence-style "bright female"
#      prompt produced 7 MALE-voiced segments out of 16 sampled (F0 ~95 Hz in a
#      "female" voice). A firm pitch anchor pins gender: std drops from ~89 Hz
#      to ~10–42 Hz and male/female flips disappear. (True per-speaker pinning
#      would need reference-audio cloning, but this checkpoint omits the audio
#      encoder; the attribute anchor is the best available proxy.)
#
# Verified leak-free + intelligible (Whisper) and audible across real segments.
VOICES: tuple[DesignedVoice, ...] = (
    DesignedVoice(
        "omnivoice-female-calm",
        "female, adult, high pitch, gentle",
        "Female — calm narrator (default)",
        seed=7,
        recommended=True,
    ),
    DesignedVoice(
        "omnivoice-male-warm",
        "male, adult, low pitch, warm",
        "Male — warm",
        seed=13,
    ),
    DesignedVoice(
        "omnivoice-female-bright",
        "female, young adult, high pitch, bright",
        "Female — bright",
        seed=21,
    ),
    DesignedVoice(
        "omnivoice-male-neutral",
        "male, adult, low pitch, clear",
        "Male — neutral",
        seed=34,
    ),
)


def base_subtag(language: str | None) -> str:
    return (language.split("-")[0].split("_")[0] if language else "").lower()


# BCP-47 base subtag -> the language NAME mlx-audio's OmniVoice `language` param
# expects (lowercase English name). OmniVoice covers ~646 languages; this maps the
# app's common set. Unknown subtags fall back to English (the model still runs).
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "english",
    "vi": "vietnamese",
    "es": "spanish",
    "fr": "french",
    "de": "german",
    "it": "italian",
    "pt": "portuguese",
    "ru": "russian",
    "ja": "japanese",
    "ko": "korean",
    "zh": "chinese",
    "ar": "arabic",
    "hi": "hindi",
    "id": "indonesian",
    "th": "thai",
    "nl": "dutch",
    "pl": "polish",
    "tr": "turkish",
    "uk": "ukrainian",
    "cs": "czech",
    "sv": "swedish",
    "ro": "romanian",
    "el": "greek",
    "he": "hebrew",
    "fi": "finnish",
    "da": "danish",
    "no": "norwegian",
    "hu": "hungarian",
    "ms": "malay",
    "fa": "persian",
    "ta": "tamil",
    "bn": "bengali",
    "uk_UA": "ukrainian",
}

DEFAULT_LANGUAGE_NAME = "english"


def language_name(language: str | None) -> str:
    """Map a BCP-47-ish code (e.g. 'vi-VN') to OmniVoice's language name."""
    return _LANGUAGE_NAMES.get(base_subtag(language), DEFAULT_LANGUAGE_NAME)


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
