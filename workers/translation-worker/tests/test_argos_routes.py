"""Chinese -> Vietnamese, and every other pair Argos only serves through English.

The 0.11.0 test build: first-run setup installed zh->en, then en->vi, in one
worker process, and translating zh->vi still failed with "No installed Argos
translation package" until the app restarted. Argos caches each package's
translation module-wide, still linked to the Language objects of the call that
first built it, so its pivot graph was built from the stale English, which had
no route to Vietnamese. Reproduced on the real packages; these tests pin both
halves of the fix without needing them.
"""

from __future__ import annotations

import sys
import types

import pytest

from app import providers
from app.providers import ArgosBackend


class _Translation:
    def __init__(self, to: str) -> None:
        self.to = to

    def translate(self, text: str) -> str:
        return f"{text}>{self.to}"


class _Language:
    def __init__(self, code: str, routes: dict[str, _Translation]) -> None:
        self.code = code
        self._routes = routes

    def get_translation(self, to: _Language):  # noqa: ANN201 - mirrors Argos
        return self._routes.get(to.code)


def _backend(*languages: _Language) -> ArgosBackend:
    backend = ArgosBackend()
    backend._loaded = True
    backend._languages = list(languages)
    return backend


def test_chains_through_english_when_argos_has_no_route() -> None:
    # Exactly the stale graph: zh knows English, English knows Vietnamese,
    # but zh itself was never given the zh->vi pivot.
    zh = _Language("zh", {"en": _Translation("en")})
    en = _Language("en", {"vi": _Translation("vi")})
    vi = _Language("vi", {})
    assert _backend(zh, en, vi).translate("你好", "zh", "vi") == "你好>en>vi"


def test_prefers_argos_own_route() -> None:
    zh = _Language("zh", {"en": _Translation("en"), "vi": _Translation("vi-direct")})
    en = _Language("en", {"vi": _Translation("vi")})
    vi = _Language("vi", {})
    assert _backend(zh, en, vi).translate("你好", "zh", "vi") == "你好>vi-direct"


def test_a_missing_english_leg_is_still_reported() -> None:
    zh = _Language("zh", {"en": _Translation("en")})
    en = _Language("en", {})  # en->vi never installed
    vi = _Language("vi", {})
    with pytest.raises(Exception, match="zh"):
        _backend(zh, en, vi).translate("你好", "zh", "vi")


def test_refresh_drops_argos_stale_translation_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    cleared: list[str] = []

    def get_installed_languages() -> list:
        return []

    get_installed_languages.cache_clear = lambda: cleared.append("languages")  # type: ignore[attr-defined]
    fake = types.ModuleType("argostranslate.translate")
    fake.installed_translates = ["stale zh->en"]  # type: ignore[attr-defined]
    fake.get_installed_languages = get_installed_languages  # type: ignore[attr-defined]
    package = types.ModuleType("argostranslate")
    package.translate = fake  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "argostranslate", package)
    monkeypatch.setitem(sys.modules, "argostranslate.translate", fake)
    monkeypatch.setattr(ArgosBackend, "_seed_missing_minisbd_models", lambda self: None)

    ArgosBackend().refresh()

    assert fake.installed_translates == []  # type: ignore[attr-defined]
    assert cleared == ["languages"]


def test_the_installed_app_names_both_english_legs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    err = providers.ArgosBackend._missing_package_error("zh", "vi").error
    assert "zh → en and en → vi" in (err.remediation or "")
    assert "Settings → Translation packs" in (err.remediation or "")
    assert "argospm" not in (err.remediation or "")
