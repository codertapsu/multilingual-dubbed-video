# PyInstaller runtime hook (STT): bake VD_WORKER so the frozen binary needs no
# arguments. Runs BEFORE entry_worker.main(). A caller-provided VD_WORKER wins so
# the binary stays debuggable.
import os

os.environ.setdefault("VD_WORKER", "stt")

# faster_whisper/audio.py does a module-scope `import av`, but this build ships
# no PyAV: it embeds a second FFmpeg (~44 MB) purely to decode audio our media
# worker already produced as 16 kHz mono WAV. whisper_service decodes with the
# stdlib (falling back to the bundled ffmpeg binary), so nothing calls into av —
# a stub satisfies the import without the payload.
import sys
import types

if "av" not in sys.modules:
    _av = types.ModuleType("av")
    _av.__spec__ = types.SimpleNamespace(name="av", loader=None, origin="videodubber-stub")

    def _no_av(*_args, **_kwargs):
        raise RuntimeError(
            "This build decodes audio with the bundled ffmpeg, not PyAV. "
            "Pass a 16 kHz mono WAV, or set FFMPEG_PATH."
        )

    _av.open = _no_av
    _av.error = types.SimpleNamespace(FFmpegError=RuntimeError)
    _av.AudioResampler = _no_av
    sys.modules["av"] = _av
