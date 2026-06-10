"""VideoDubber STT worker.

A small, local-first FastAPI service that turns audio into timed transcript
segments using `faster-whisper`. It is one of several language workers in the
VideoDubber pipeline and is designed to run fully offline once a Whisper model
has been downloaded to the local cache.

Modules
-------
- :mod:`app.config`          Environment-driven configuration.
- :mod:`app.lang`            Language-code normalization (mirrors the TS contract).
- :mod:`app.errors`          Structured ``AppError`` model + FastAPI handlers.
- :mod:`app.schemas`         Pydantic v2 request/response models.
- :mod:`app.whisper_service` Lazy-loaded, cached faster-whisper wrapper.
- :mod:`app.main`            FastAPI application (``/health``, ``/transcribe``).
- :mod:`app.download_model`  Optional CLI helper to pre-cache a model.
"""

__version__ = "0.1.0"
