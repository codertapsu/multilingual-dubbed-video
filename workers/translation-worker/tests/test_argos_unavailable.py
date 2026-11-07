"""What the user is told when Argos Translate cannot be imported.

In the installed app the engine is bundled, so an import failure is a broken
install. The 0.11.0 test build answered "DLL load failed while importing
_sentencepiece" with "Install the translation engine: `pip install
argostranslate`", advice no user of the installed app can follow.
"""

from __future__ import annotations

import sys

import pytest

from app.providers import argos_unavailable

_DLL_FAILURE = ImportError("DLL load failed while importing _sentencepiece: The specified module could not be found.")


def test_the_installed_app_never_tells_users_to_pip_install(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    err = argos_unavailable(_DLL_FAILURE).error
    assert err.code == "TRANSLATION_PACKAGE_MISSING"
    assert "pip" not in (err.remediation or "")
    assert "install the latest version over it" in (err.remediation or "")
    # The real cause travels with it, for the bug report the remediation asks for.
    assert err.cause is not None and "_sentencepiece" in err.cause
    assert err.docsRef == "docs/TROUBLESHOOTING.md#translation-package-missing"


def test_a_source_checkout_still_gets_the_pip_instruction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    err = argos_unavailable(ImportError("No module named 'argostranslate'")).error
    assert "pip install argostranslate" in (err.remediation or "")
