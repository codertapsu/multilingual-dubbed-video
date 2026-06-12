"""VieNeu install + synth smoke test (run in CI against a real uv venv).

Exercises OUR integration code path (vd_tts_engine.engine.VieNeuEngine), not a
synthetic one, so it validates exactly what the app does:

  1. `vieneu` installed + importable (the pinned set resolved on this OS/arch).
  2. `VieNeuEngine().synth(...)` loads `Vieneu()` and synthesizes one Vietnamese
     sentence with our recommended preset voice (the same infer(voice=…) call
     engine.py makes in production).
  3. The output is 48 kHz — the signature of v3-Turbo, which confirms the bare
     `Vieneu()` default is v3-Turbo (not the 24 kHz v2 line).
  4. (Informational) our voices.py preset names vs the SDK's preset list, so a
     drift in upstream preset names is visible in the CI log.

Exits non-zero on any hard failure. Run:
  PYTHONPATH=workers/tts-engine-neural <venv>/python workers/tts-engine-neural/scripts/smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from vd_tts_engine import voices
from vd_tts_engine.engine import VieNeuEngine

TEXT = "Xin chào, đây là một bài kiểm tra giọng nói tiếng Việt."


def main() -> int:
    import vieneu  # noqa: PLC0415

    print("vieneu version:", getattr(vieneu, "__version__", "?"))

    engine = VieNeuEngine()
    if not engine.available():
        print("FAIL: vieneu is not importable in this venv")
        return 1

    recommended = next(v for v in voices.VOICES if v.recommended)
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
    if info.samplerate != 48000:
        print(f"FAIL: expected 48 kHz (v3-Turbo); got {info.samplerate} Hz — Vieneu() default may not be v3-Turbo")
        return 1
    if dur < 0.3:
        print(f"FAIL: suspiciously short audio ({dur:.2f}s)")
        return 1

    _report_preset_names(engine)

    print("SMOKE OK")
    return 0


def _report_preset_names(engine: VieNeuEngine) -> None:
    """Informational: compare our voices.py SDK names against the SDK's presets."""
    try:
        presets = list(engine._backend.list_preset_voices())  # type: ignore[union-attr]
        sdk_names: set[str] = set()
        for p in presets:
            if isinstance(p, (list, tuple)):
                sdk_names.update(str(x) for x in p)
            else:
                sdk_names.add(str(p))
        ours = [v.sdk_name for v in voices.VOICES]
        missing = [n for n in ours if n not in sdk_names]
        print("SDK preset values:", sorted(sdk_names))
        print("our voices.py sdk_names:", ours)
        print("our names NOT found in SDK presets:", missing or "(none)")
    except Exception as exc:  # noqa: BLE001
        print("preset-name comparison skipped:", exc)


if __name__ == "__main__":
    sys.exit(main())
