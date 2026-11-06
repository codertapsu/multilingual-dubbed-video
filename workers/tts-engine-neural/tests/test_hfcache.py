"""The HF shared-blob-store repair (vd_tts_engine/hfcache.py).

huggingface_hub >= 1.33 symlinks each repo's blobs into a cache-wide store
sharded by hash prefix, so an .onnx graph and its external .data land in
different directories and onnxruntime refuses to load them. These tests build
that layout by hand (no network, no huggingface_hub) and pin the repair.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from vd_tts_engine import hfcache

pytestmark = pytest.mark.skipif(os.name == "nt", reason="creating symlinks needs privileges on Windows")


def _shared_store_cache(tmp_path: Path) -> tuple[Path, Path, Path]:
    """hub/blobs/<xx>/<hash> real files + repo blobs/<etag> symlinks + snapshot links."""
    hub = tmp_path / "hub"
    repo = hub / "models--org--model"
    (repo / "blobs").mkdir(parents=True)
    snap = repo / "snapshots" / "rev1" / "onnx"
    snap.mkdir(parents=True)
    for name, shard, payload in (("graph.onnx", "8b", b"graph"), ("weights.data", "26", b"weights")):
        store = hub / "blobs" / shard
        store.mkdir(parents=True, exist_ok=True)
        real = store / f"{shard}{name}-hash"
        real.write_bytes(payload)
        etag = repo / "blobs" / f"etag-{name}"
        etag.symlink_to(os.path.relpath(real, etag.parent))
        (snap / name).symlink_to(os.path.relpath(etag, snap))
    return hub, repo, snap


def test_shared_store_layout_puts_graph_and_weights_in_different_real_dirs(tmp_path: Path) -> None:
    # The precondition the bug needs — guards the fixture itself.
    _hub, _repo, snap = _shared_store_cache(tmp_path)
    graph = Path(os.path.realpath(snap / "graph.onnx"))
    weights = Path(os.path.realpath(snap / "weights.data"))
    assert graph.parent != weights.parent


def test_unshare_brings_every_file_of_a_repo_into_one_real_directory(tmp_path: Path) -> None:
    hub, repo, snap = _shared_store_cache(tmp_path)

    assert hfcache.unshare_repo_blobs(hub) == 2

    graph = Path(os.path.realpath(snap / "graph.onnx"))
    weights = Path(os.path.realpath(snap / "weights.data"))
    # onnxruntime's check: the external data resolves inside the model's dir.
    assert graph.parent == weights.parent == (repo / "blobs").resolve()
    assert graph.read_bytes() == b"graph"
    assert weights.read_bytes() == b"weights"
    # The per-repo blobs are regular files again (the pre-1.33 layout).
    assert not any(p.is_symlink() for p in (repo / "blobs").iterdir())


def test_unshare_is_idempotent_and_leaves_no_temp_files(tmp_path: Path) -> None:
    hub, repo, _snap = _shared_store_cache(tmp_path)
    hfcache.unshare_repo_blobs(hub)

    assert hfcache.unshare_repo_blobs(hub) == 0
    assert not list((repo / "blobs").glob("*.vd-unshare"))


def test_unshare_ignores_dangling_links_and_incomplete_downloads(tmp_path: Path) -> None:
    hub = tmp_path / "hub"
    blobs = hub / "models--org--model" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "dangling").symlink_to("does-not-exist")
    (blobs / "x.incomplete").write_bytes(b"partial")

    assert hfcache.unshare_repo_blobs(hub) == 0
    assert (blobs / "dangling").is_symlink()


def test_missing_hub_is_a_no_op(tmp_path: Path) -> None:
    assert hfcache.unshare_repo_blobs(tmp_path / "nope") == 0


def test_hub_dir_prefers_hf_hub_cache(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "explicit"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    assert hfcache.hub_dir() == tmp_path / "explicit"
    monkeypatch.delenv("HF_HUB_CACHE")
    assert hfcache.hub_dir() == tmp_path / "home" / "hub"


def test_importing_the_engine_opts_out_of_the_shared_store(monkeypatch) -> None:
    monkeypatch.delenv(hfcache.DISABLE_SHARED_BLOBS_ENV, raising=False)
    hfcache.disable_shared_blob_store()
    assert os.environ[hfcache.DISABLE_SHARED_BLOBS_ENV] == "1"


def test_an_explicit_setting_is_respected(monkeypatch) -> None:
    monkeypatch.setenv(hfcache.DISABLE_SHARED_BLOBS_ENV, "0")
    hfcache.disable_shared_blob_store()
    assert os.environ[hfcache.DISABLE_SHARED_BLOBS_ENV] == "0"
