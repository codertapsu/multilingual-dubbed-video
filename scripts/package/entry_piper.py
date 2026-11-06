"""PyInstaller entry point for the frozen `vd-piper` CLI sidecar.

This freezes the piper-tts console script (`piper`) into a single self-
contained executable so the packaged desktop app can synthesize neural speech
without a Python installation. The TTS worker invokes it as a SEPARATE process
(`vd-piper --model voice.onnx --output_file out.wav`, text on stdin) — exactly
like the dev venv's `piper` script — which also keeps the GPL-licensed
piper/espeak-ng code out of the MIT worker process (mere aggregation, same
posture as the bundled ffmpeg).

BATCH MODE (`--vd-batch`). Spawning one process per subtitle line cost ~0.7 s
of interpreter start + voice-model load PER LINE, measured on an M4 Pro: the
shipped one-process-per-line pool managed 4.0 lines/s, while the same voice
kept loaded in ONE process synthesizes 16.3 lines/s. (More persistent
processes are SLOWER — 2 → 14.3, 6 → 7.3 lines/s — because ONNX Runtime
already uses every core inside one process.) So the worker keeps one of these
alive per voice and streams requests to it:

    stdin  (one JSON object per line):
        {"text": "...", "output_file": "/abs/out.wav", "length_scale": 1.0}
    stdout (one JSON object per line):
        {"ready": true, "protocol": 1}            -- once, after the model loads
        {"ok": true}                               -- per request
        {"ok": false, "error": "..."}

The WAV is written to `<out>.partial` and renamed only when complete, so a
killed process never leaves a truncated clip that looks finished.
`--vd-batch-probe` prints the protocol version and exits, so the worker can
tell this build from an older vd-piper (or the upstream `piper` script in a dev
venv) without starting a model.
"""

from __future__ import annotations

import json
import os
import sys

BATCH_PROTOCOL = 1

# Built windowed (console=False) to avoid a console window on Windows. If launched
# without inherited stdio handles, sys.stdout/stderr can be None and piper's logging
# would crash; guard before running. (The TTS worker always pipes stdio, so normally
# a no-op.) piper reads text on stdin and writes audio to --output_file.
for _name in ("stdout", "stderr"):
    if getattr(sys, _name, None) is None:
        setattr(sys, _name, open(os.devnull, "w", encoding="utf-8"))


def _arg(flag: str, short: str | None = None) -> str | None:
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a in (flag, short) and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None


def run_batch() -> int:
    """Serve JSON-lines synthesis requests with ONE loaded voice (see module doc)."""
    import wave

    from piper import PiperVoice, SynthesisConfig

    # Text is UTF-8 regardless of the console code page (Windows defaults to
    # cp1252, which cannot encode Vietnamese).
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

    model = _arg("--model", "-m")
    if not model:
        print(json.dumps({"ready": False, "error": "--model is required"}), flush=True)
        return 2
    try:
        voice = PiperVoice.load(model, config_path=_arg("--config", "-c"))
    except Exception as exc:  # noqa: BLE001 - reported to the worker, then exit
        print(json.dumps({"ready": False, "error": f"could not load voice: {exc}"[:500]}), flush=True)
        return 1
    print(json.dumps({"ready": True, "protocol": BATCH_PROTOCOL}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        partial = None
        try:
            req = json.loads(line)
            out = str(req["output_file"])
            text = str(req.get("text") or "")
            scale = req.get("length_scale")
            config = SynthesisConfig(length_scale=float(scale)) if scale else None
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            partial = out + ".partial"
            with wave.open(partial, "wb") as wav:
                voice.synthesize_wav(text, wav, syn_config=config)
            os.replace(partial, out)
            print(json.dumps({"ok": True}), flush=True)
        except Exception as exc:  # noqa: BLE001 - one bad line must not end the session
            # Text that yields no audio (e.g. empty) fails inside wave's close
            # ("# channels not specified") after the file was created; don't
            # leave that 0-byte partial in the project's TTS directory.
            if partial is not None:
                try:
                    os.remove(partial)
                except OSError:
                    pass
            print(json.dumps({"ok": False, "error": str(exc)[:500]}), flush=True)
    return 0


if __name__ == "__main__":
    if "--vd-batch-probe" in sys.argv:
        print(f"vd-batch/{BATCH_PROTOCOL}", flush=True)
        sys.exit(0)
    if "--vd-batch" in sys.argv:
        sys.exit(run_batch())
    from piper.__main__ import main

    sys.exit(main())
