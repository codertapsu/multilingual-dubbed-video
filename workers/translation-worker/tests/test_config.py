"""Settings -> environment propagation.

The device knob shipped broken: the worker exported ``ARGOS_DEVICE`` while
argostranslate 1.11.0 reads ``ARGOS_DEVICE_TYPE`` (settings.py:167), so setting
it left Argos on the CPU with no warning. These tests pin the env var NAMES,
because that is the whole contract — a typo here is invisible at runtime.
"""

from __future__ import annotations

import pytest

from app.config import Settings, get_settings


_ARGOS_ENV = ("ARGOS_DEVICE", "ARGOS_DEVICE_TYPE", "ARGOS_PACKAGES_DIR")


@pytest.fixture(autouse=True)
def _clean_argos_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate these tests from — and from leaking into — the real environment.

    ``apply_to_environment`` writes ``os.environ`` directly, which monkeypatch
    cannot roll back, and argostranslate reads ``ARGOS_DEVICE_TYPE`` ONCE at
    import time. Leaving "cuda" behind therefore made the real-Argos glossary
    tests fail with "This CTranslate2 package was not compiled with CUDA
    support", depending purely on file order. Clean up on both sides.
    """
    import os

    saved = {name: os.environ.get(name) for name in _ARGOS_ENV}
    for name in _ARGOS_ENV:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    get_settings.cache_clear()


def test_device_is_exported_under_the_name_argostranslate_reads() -> None:
    import os

    Settings(argos_device="cuda").apply_to_environment()
    assert os.environ["ARGOS_DEVICE_TYPE"] == "cuda"
    # The worker's own input name stays set too, for anything else inspecting it.
    assert os.environ["ARGOS_DEVICE"] == "cuda"


def test_device_type_is_accepted_as_input_too(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARGOS_DEVICE_TYPE", "cpu")
    get_settings.cache_clear()
    assert get_settings().argos_device == "cpu"


def test_argos_device_wins_when_both_are_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARGOS_DEVICE", "cuda")
    monkeypatch.setenv("ARGOS_DEVICE_TYPE", "cpu")
    get_settings.cache_clear()
    assert get_settings().argos_device == "cuda"


def test_unset_device_touches_nothing() -> None:
    import os

    Settings().apply_to_environment()
    assert "ARGOS_DEVICE_TYPE" not in os.environ
    assert "ARGOS_DEVICE" not in os.environ
