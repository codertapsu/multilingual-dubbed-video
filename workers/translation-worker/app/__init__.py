"""VideoDubber translation worker.

A small FastAPI service (default port 5102) that performs local/offline-first
translation using Argos Translate. It exposes:

    GET  /health              -> liveness + installed package count
    GET  /languages           -> installed + available language pairs
    POST /translate-segments  -> translate a list of subtitle segments

See ``app.main`` for the application factory and route wiring.
"""

__version__ = "0.1.0"
