"""Cache key + AudioCache behavior tests."""

from __future__ import annotations

import os

from app.cache import AudioCache, cache_key
from app.wavutil import write_silent_wav


def test_cache_key_is_deterministic_and_field_sensitive():
    a = cache_key("seg_0001", "hello", "fallback", 1.0)
    b = cache_key("seg_0001", "hello", "fallback", 1.0)
    assert a == b

    # Changing any field changes the key.
    assert cache_key("seg_0002", "hello", "fallback", 1.0) != a
    assert cache_key("seg_0001", "world", "fallback", 1.0) != a
    assert cache_key("seg_0001", "hello", "piper", 1.0) != a
    assert cache_key("seg_0001", "hello", "fallback", 1.5) != a


def test_cache_key_no_field_concat_collision():
    # ("a","bc") vs ("ab","c") must NOT collide thanks to NUL separators.
    assert cache_key("a", "bc", None, 1.0) != cache_key("ab", "c", None, 1.0)


def test_audiocache_put_get_materialize(tmp_path):
    cache = AudioCache(tmp_path / "cache")
    src = tmp_path / "src.wav"
    write_silent_wav(src, 300)

    key = cache_key("seg_0001", "hi", None, 1.0)
    assert cache.get(key) is None

    cached = cache.put(key, src)
    assert cached.is_file()
    assert cache.get(key) is not None

    dest = tmp_path / "out" / "segment_0001.wav"
    placed = cache.materialize(cached, dest)
    assert placed.exists()
    # The materialized file should resolve to the same content.
    assert placed.read_bytes() == src.read_bytes()


def test_materialize_always_copies_never_symlinks(tmp_path):
    # A symlinked segment file makes a project directory non-self-contained:
    # clearing the cache from Settings would orphan every rendered project.
    cache = AudioCache(tmp_path / "cache")
    src = tmp_path / "src.wav"
    write_silent_wav(src, 200)
    cached = cache.put(cache_key("seg_0001", "hi", None, 1.0), src)

    dest = tmp_path / "out" / "segment_0001.wav"
    cache.materialize(cached, dest)

    assert not dest.is_symlink()
    assert dest.read_bytes() == src.read_bytes()
    # Deleting the cache entry must not affect the project's copy.
    cached.unlink()
    assert dest.read_bytes() == src.read_bytes()


def test_put_prunes_least_recently_used_entries(tmp_path):
    src = tmp_path / "src.wav"
    write_silent_wav(src, 500)
    entry_size = src.stat().st_size

    # Budget for ~2 entries, then write 3.
    cache = AudioCache(tmp_path / "cache", max_bytes=entry_size * 2 + 1)
    keys = [cache_key(f"seg_{n:04d}", "hi", None, 1.0) for n in range(3)]

    for n, key in enumerate(keys):
        cache.put(key, src)
        # Space out access times so "least recently used" is well-defined on
        # filesystems with coarse timestamps.
        os.utime(cache.get(key), (1_700_000_000 + n, 1_700_000_000 + n))

    assert cache.total_bytes() <= cache.max_bytes
    assert cache.get(keys[0]) is None  # oldest access evicted
    assert cache.get(keys[2]) is not None


def test_get_refreshes_recency_so_reused_clips_survive(tmp_path):
    src = tmp_path / "src.wav"
    write_silent_wav(src, 500)
    entry_size = src.stat().st_size
    cache = AudioCache(tmp_path / "cache", max_bytes=entry_size * 2 + 1)

    old_key = cache_key("seg_0001", "hi", None, 1.0)
    mid_key = cache_key("seg_0002", "hi", None, 1.0)
    cache.put(old_key, src)
    os.utime(cache._path_for(old_key), (1_700_000_000, 1_700_000_000))
    cache.put(mid_key, src)
    os.utime(cache._path_for(mid_key), (1_700_000_001, 1_700_000_001))

    cache.get(old_key)  # a hit bumps it back to most-recently-used
    cache.put(cache_key("seg_0003", "hi", None, 1.0), src)

    assert cache.get(old_key) is not None
    assert cache.get(mid_key) is None


def test_unbounded_cache_never_evicts(tmp_path):
    src = tmp_path / "src.wav"
    write_silent_wav(src, 500)
    cache = AudioCache(tmp_path / "cache")  # max_bytes=0 -> unbounded
    for n in range(5):
        cache.put(cache_key(f"seg_{n:04d}", "hi", None, 1.0), src)
    assert cache.prune() == 0
    assert len(list((tmp_path / "cache").glob("*.wav"))) == 5
