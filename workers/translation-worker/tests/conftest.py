"""Shared pytest fixtures and fake backends.

The whole point: run the worker's logic **without** any Argos packages (or even
the ``argostranslate`` library) installed. We inject a fake backend via
``app.translation_service.set_backend``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import translation_service
from app.errors import AppErrorException
from app.main import create_app


class FakeBackend:
    """A deterministic, dependency-free backend for tests.

    ``installed`` is the set of supported ``(from, to)`` base pairs. Translation
    is a trivial, reversible transform so assertions are easy: it upper-cases
    the text and prefixes the target language, while leaving glossary sentinel
    tokens untouched (mirroring how a real NMT engine should leave PUA tokens
    alone).
    """

    id = "fake"
    display_name = "Fake (test)"
    is_local = True

    def __init__(self, installed: set[tuple[str, str]] | None = None) -> None:
        self.installed = installed if installed is not None else {("en", "vi")}
        self.calls: list[tuple[str, str, str]] = []
        self.ensure_calls: list[tuple[str, str]] = []
        self.remove_calls: list[tuple[str, str]] = []
        self.index_refreshed = False

    def installed_pairs(self) -> list[tuple[str, str]]:
        return sorted(self.installed)

    def available_pairs(self) -> list[tuple[str, str]]:
        return [("en", "es"), ("en", "fr"), ("zh", "en")]

    def refresh_index(self) -> None:
        self.index_refreshed = True

    def remove_pair(self, from_lang: str, to_lang: str) -> bool:
        self.remove_calls.append((from_lang, to_lang))
        if (from_lang, to_lang) in self.installed:
            self.installed.discard((from_lang, to_lang))
            return True
        return False

    def ensure_pair(self, from_lang: str, to_lang: str) -> bool:
        """Mimic the real install flow against the fake ``available_pairs``.

        Returns False (no-op) if already installed, True after "installing" an
        available pair, and raises the structured error for an unknown pair.
        """
        self.ensure_calls.append((from_lang, to_lang))
        if (from_lang, to_lang) in self.installed:
            return False
        if (from_lang, to_lang) not in set(self.available_pairs()):
            raise AppErrorException.make(
                code="TRANSLATION_PACKAGE_MISSING",
                message=f"No package published for '{from_lang}' -> '{to_lang}'.",
                status_code=422,
                remediation="Pick an available pair.",
                docs_ref="docs/MODEL_SETUP.md",
            )
        self.installed.add((from_lang, to_lang))
        return True

    def translate(self, text: str, from_lang: str, to_lang: str) -> str:
        self.calls.append((text, from_lang, to_lang))
        if (from_lang, to_lang) not in self.installed:
            raise AppErrorException.make(
                code="TRANSLATION_PACKAGE_MISSING",
                message=f"No installed package for '{from_lang}' -> '{to_lang}'.",
                status_code=422,
                remediation=f"argospm install translate-{from_lang}_{to_lang}",
                docs_ref="docs/MODEL_SETUP.md",
            )
        # Keep empty/whitespace as-is, like the real backend.
        if not text.strip():
            return text
        return f"[{to_lang}] {text.upper()}"


@pytest.fixture()
def fake_backend() -> FakeBackend:
    backend = FakeBackend()
    translation_service.set_backend(backend)
    yield backend
    translation_service.set_backend(None)  # reset to default after each test


@pytest.fixture()
def client(fake_backend: FakeBackend) -> TestClient:
    """A TestClient backed by the fake translation backend."""
    # raise_server_exceptions=False so our 500 handler renders the envelope
    # instead of TestClient re-raising the exception.
    return TestClient(create_app(), raise_server_exceptions=False)
