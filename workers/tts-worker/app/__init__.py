"""VideoDubber TTS worker.

A small FastAPI service that turns translated text segments into per-segment
WAV files. It is local/offline-first and degrades gracefully:

    Piper (binary)  ->  system TTS (macOS `say` / linux `espeak-ng`)  ->  dev fallback

The dev fallback writes a silent (or soft sine) WAV sized to the segment window
and has ZERO external dependencies, so the entire dubbing pipeline is testable
without installing any TTS engine.

NOTE on consent/legal: this worker performs generic text-to-speech only. It does
NOT perform voice cloning / speaker imitation. Adding voice cloning would require
explicit, informed consent from the speaker being cloned.
"""

__version__ = "0.1.0"
