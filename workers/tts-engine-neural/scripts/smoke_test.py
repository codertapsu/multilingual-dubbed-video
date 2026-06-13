"""VieNeu install + synth smoke test (run in CI against a real uv venv).

Exercises OUR integration code path (vd_tts_engine.engine.VieNeuEngine), not a
synthetic one, so it validates exactly what the app does for the variant the
engine pack selects via VIENEU_VARIANT (v2 or v3):

  1. `vieneu` installed + importable (the pinned set resolved on this OS/arch).
  2. `VieNeuEngine().synth(...)` loads the variant's `Vieneu()` and synthesizes
     one Vietnamese sentence with that variant's recommended preset voice (the
     same call engine.py makes in production).
  3. The output sample rate matches the variant (v3 = 48 kHz, v2 = 24 kHz),
     confirming the right model loaded.
  4. (Informational) our voices.py preset names for the variant vs the SDK's
     preset list, so a drift in upstream preset names is visible in the CI log.

Exits non-zero on any hard failure. Run:
  VIENEU_VARIANT=v3 PYTHONPATH=workers/tts-engine-neural <venv>/python \
    workers/tts-engine-neural/scripts/smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Force UTF-8 stdio before any print(): Windows defaults the console to cp1252,
# which raises UnicodeEncodeError on the Vietnamese voice names / "…" we print.
# The CI job and the bundled app set PYTHONUTF8=1 too; this makes the script
# robust even when run directly without that env.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

from vd_tts_engine import voices
from vd_tts_engine.engine import VieNeuEngine

TEXT = "Xin chào, đây là một bài kiểm tra giọng nói tiếng Việt."


def main() -> int:
    import vieneu  # noqa: PLC0415

    print("vieneu version:", getattr(vieneu, "__version__", "?"))

    engine = VieNeuEngine()  # variant comes from VIENEU_VARIANT (default v3)
    variant = engine.variant
    print(f"variant: {variant} (expected sample rate {engine.sample_rate} Hz)")

    if not engine.available():
        print("FAIL: vieneu is not importable in this venv")
        return 1

    preset_voices = voices.variant_voices(variant)
    recommended = next(v for v in preset_voices if v.recommended)
    out = Path("smoke_out.wav").resolve()
    print(f"synthesizing with voice id={recommended.id!r} sdk_name={recommended.sdk_name!r} …")
    engine.synth(TEXT, str(out), recommended.id, 1.0)

    if not out.is_file() or out.stat().st_size < 1024:
        print(f"FAIL: no audio written to {out}")
        return 1

    # Read the real sample rate / duration (soundfile handles any WAV subtype).
    import soundfile as sf  # noqa: PLC0415

    info = sf.info(str(out))
    dur = info.frames / info.samplerate if info.samplerate else 0
    print(f"wrote {out.name}: {info.samplerate} Hz, {info.frames} frames, {dur:.2f}s")
    if info.samplerate != engine.sample_rate:
        print(f"FAIL: expected {engine.sample_rate} Hz for variant {variant}; got {info.samplerate} Hz")
        return 1
    if dur < 0.3:
        print(f"FAIL: suspiciously short audio ({dur:.2f}s)")
        return 1

    _report_preset_names(engine, variant)

    print("SMOKE OK")
    return 0


def _report_preset_names(engine: VieNeuEngine, variant: str) -> None:
    """Informational: compare our voices.py SDK names against the SDK's presets."""
    try:
        presets = list(engine._backend.list_preset_voices())  # type: ignore[union-attr]
        sdk_names: set[str] = set()
        for p in presets:
            if isinstance(p, (list, tuple)):
                sdk_names.update(str(x) for x in p)
            else:
                sdk_names.add(str(p))
        ours = [v.sdk_name for v in voices.variant_voices(variant)]
        missing = [n for n in ours if n not in sdk_names]
        print("SDK preset values:", sorted(sdk_names))
        print(f"our voices.py {variant} sdk_names:", ours)
        print("our names NOT found in SDK presets:", missing or "(none)")
    except Exception as exc:  # noqa: BLE001
        print("preset-name comparison skipped:", exc)


if __name__ == "__main__":
    sys.exit(main())
