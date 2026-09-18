"""The TTS worker must stay answerable while it is synthesizing.

Regression test for a shipped bug: `/synthesize-segments` was declared
`async def` but its body is fully synchronous, so the whole batch ran ON the
event loop. `GET /health` then did not answer until the last segment was
written — minutes, on a long video — while the orchestrator probes health with
a 3 s budget and gates readiness on that same probe. A worker that was busy
dubbing was therefore reported dead, and a second run was blocked behind it.

The test drives the real ASGI app through httpx so the route dispatch (coroutine
vs threadpool) is exercised for real; a TestClient call is synchronous and could
not observe overlap.
"""

from __future__ import annotations

import asyncio
import threading

import httpx

# How long the fake synthesis blocks. Comfortably longer than the orchestrator's
# 3 s health budget would be slow to test; 1.5 s is enough to prove the loop is
# free, since the broken version blocks for the FULL duration.
_BLOCK_S = 1.5
# The health probe must answer well inside the orchestrator's real budget.
_HEALTH_BUDGET_S = 1.0


class _BlockingService:
    """Stands in for TtsService: blocks the calling thread like a real engine."""

    def __init__(self) -> None:
        self.entered = threading.Event()

    def synthesize_segments(self, **_kwargs):
        from app.tts_service import SynthesisBatch

        self.entered.set()
        threading.Event().wait(_BLOCK_S)  # a real engine subprocess, in effect
        return SynthesisBatch("fallback", 0, [])


def test_health_answers_while_a_batch_is_synthesizing(client, tmp_path, monkeypatch):
    import app.main as main_mod

    blocking = _BlockingService()
    monkeypatch.setattr(main_mod, "service", blocking)

    payload = {
        "language": "vi-VN",
        "voiceId": "fallback",
        "outputDir": str(tmp_path / "out"),
        "speed": 1.0,
        "segments": [
            {"id": "seg_0001", "text": "xin chào", "startMs": 0, "endMs": 1000},
        ],
    }

    async def scenario() -> tuple[float, bool]:
        transport = httpx.ASGITransport(app=main_mod.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://tts") as http:
            batch = asyncio.create_task(
                http.post("/synthesize-segments", json=payload, timeout=30.0)
            )
            # Wait until the batch is genuinely inside the blocking call.
            for _ in range(200):
                if blocking.entered.is_set():
                    break
                await asyncio.sleep(0.01)
            assert blocking.entered.is_set(), "synthesis never started"

            started = asyncio.get_running_loop().time()
            health = await asyncio.wait_for(http.get("/health"), timeout=_HEALTH_BUDGET_S)
            elapsed = asyncio.get_running_loop().time() - started

            assert health.status_code == 200
            assert health.json()["status"] == "ok"

            # The load-bearing assertion. "It answered quickly" is not enough:
            # with the broken `async def`, the loop is pinned until the batch
            # finishes, so by the time anything else runs the batch is already
            # DONE and a subsequent /health looks instant. Health has to come
            # back while the batch is still in flight.
            still_running = not batch.done()

            assert (await batch).status_code == 200
            return elapsed, still_running

    elapsed, still_running = asyncio.run(scenario())
    assert still_running, "/health only answered after the batch had finished"
    assert elapsed < _BLOCK_S, f"/health waited {elapsed:.2f}s on the batch"


# Every route whose body can block the calling thread. `/health` is on the list
# because `registry.capabilities()` calls `SystemEngine.available()`, which on
# Windows spawns PowerShell once to enumerate the SAPI voices — as a coroutine
# that ran ON the event loop, so the endpoint that exists to answer inside the
# orchestrator's 3 s budget was itself what blocked it.
_BLOCKING_ROUTES = ("/synthesize-segments", "/voices", "/health")


def test_blocking_routes_are_not_coroutines():
    """Belt and braces: `async def` here is the bug, so pin it structurally.

    The timing test above proves today's behaviour; this one names the cause, so
    a future edit that re-adds `async` fails with an explanation rather than an
    intermittent timeout.
    """
    import inspect

    import app.main as main_mod

    seen = set()
    for route in main_mod.app.routes:
        path = getattr(route, "path", None)
        if path in _BLOCKING_ROUTES:
            seen.add(path)
            assert not inspect.iscoroutinefunction(route.endpoint), (
                f"{path} must be a plain `def` so FastAPI runs it in the "
                "threadpool — its body blocks."
            )
    # A renamed route must fail loudly rather than silently checking nothing.
    assert seen == set(_BLOCKING_ROUTES), f"routes not found: {set(_BLOCKING_ROUTES) - seen}"
