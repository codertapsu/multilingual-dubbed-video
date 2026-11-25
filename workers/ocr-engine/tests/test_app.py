"""The HTTP face: /health, and /read over a raw frames file in slices (the recogniser faked)."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

import vd_ocr.app as app_module
from test_core import band


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def text_rec(self, images):
        self.calls += 1
        return [(f"第{i}句", 0.9) for i in range(len(images))], 0.01


@pytest.fixture()
def client(monkeypatch):
    engine = FakeEngine()
    monkeypatch.setattr(app_module, "_recogniser", lambda: engine)
    return TestClient(app_module.app), engine


def test_health(client):
    c, _ = client
    body = c.get("/health").json()
    assert body["ok"] is True and "PP-OCRv4" in body["engine"]


def test_read_in_slices(tmp_path, client):
    c, engine = client
    frames = np.stack([band([(200, 20, 400, 44)]), band([]), band([(100, 20, 300, 44)])])
    path = tmp_path / "frames.u8"
    frames.tofile(path)
    first = c.post("/read", json={"framesPath": str(path), "width": 600, "height": 60, "offset": 0, "count": 2}).json()
    assert [(r["index"], r["text"]) for r in first["results"]] == [(0, "第0句"), (1, "")]
    rest = c.post("/read", json={"framesPath": str(path), "width": 600, "height": 60, "offset": 2}).json()
    assert [(r["index"], r["text"]) for r in rest["results"]] == [(2, "第0句")]
    assert engine.calls == 2


def test_read_refuses_what_is_not_there(tmp_path, client):
    c, _ = client
    assert c.post("/read", json={"framesPath": str(tmp_path / "none.u8"), "width": 600, "height": 60}).status_code == 400
    path = tmp_path / "frames.u8"
    np.zeros((2, 60, 600), dtype=np.uint8).tofile(path)
    assert c.post("/read", json={"framesPath": str(path), "width": 600, "height": 60, "offset": 5}).status_code == 400
