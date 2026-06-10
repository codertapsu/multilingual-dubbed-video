"""Cache key + AudioCache behavior tests."""

from __future__ import annotations

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
