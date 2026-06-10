"""Translation backends.

The worker is local/offline-first: :class:`ArgosBackend` (Argos Translate) is
the default and only fully-implemented backend. The cloud backends are
*placeholder scaffolds* that raise ``NotImplementedError`` and document the
environment variables they will eventually read. They exist so the wiring and
provider-id contract is in place for a future enhancement, without pulling in
heavy SDKs or secrets today.

A backend's job is narrow: translate a *single already-protected* string from
one base language to another. Segment iteration, id/order preservation, and
glossary protect/restore all happen one layer up in
``app.translation_service``.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

from .errors import AppErrorException

logger = logging.getLogger("translation_worker.providers")

# Docs link surfaced in remediation messages.
_MODEL_SETUP_DOC = "docs/MODEL_SETUP.md"


@runtime_checkable
class TranslationBackend(Protocol):
    """Protocol every translation backend implements.

    Implementations should be cheap to construct; expensive setup (loading
    models) belongs in a cached factory in ``translation_service``.
    """

    id: str
    display_name: str
    is_local: bool

    def installed_pairs(self) -> list[tuple[str, str]]:
        """Return installed ``(from_base, to_base)`` language pairs."""
        ...

    def available_pairs(self) -> list[tuple[str, str]]:
        """Return downloadable/available ``(from_base, to_base)`` pairs (may be empty)."""
        ...

    def translate(self, text: str, from_lang: str, to_lang: str) -> str:
        """Translate a single string between two base language subtags.

        Raises an :class:`AppErrorException` (``TRANSLATION_PACKAGE_MISSING``)
        if the language pair is not available.
        """
        ...


class ArgosBackend:
    """Local, offline neural translation via Argos Translate.

    The ``argostranslate`` library is imported lazily so the module (and the
    test suite) can load without the package installed. Installed languages are
    cached on first use; call :meth:`refresh` after installing new packages.
    """

    id = "argos"
    display_name = "Argos Translate (local)"
    is_local = True

    def __init__(self) -> None:
        self._loaded = False
        # argostranslate Language objects, cached after first load.
        self._languages: list = []

    # -- lazy loading -----------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        try:
            from argostranslate import translate as argos_translate  # type: ignore
        except Exception as exc:  # pragma: no cover - import failure path
            raise AppErrorException.make(
                code="TRANSLATION_PACKAGE_MISSING",
                message="Argos Translate is not installed in this environment.",
                status_code=503,
                cause=str(exc),
                remediation=(
                    "Install the translation engine: `pip install argostranslate`, "
                    "then install at least one language package. See "
                    f"{_MODEL_SETUP_DOC}."
                ),
                docs_ref=_MODEL_SETUP_DOC,
            ) from exc

        self._languages = list(argos_translate.get_installed_languages())
        self._loaded = True
        logger.info("Argos: loaded %d installed language(s)", len(self._languages))

    def refresh(self) -> None:
        """Force a reload of installed languages (after installing packages)."""
        self._loaded = False
        self._languages = []
        self._ensure_loaded()

    # -- introspection ----------------------------------------------------

    def installed_pairs(self) -> list[tuple[str, str]]:
        self._ensure_loaded()
        pairs: list[tuple[str, str]] = []
        for lang in self._languages:
            for translation in getattr(lang, "translations", []):
                from_code = getattr(lang, "code", None)
                to_code = getattr(getattr(translation, "to_lang", None), "code", None)
                if from_code and to_code:
                    pairs.append((from_code, to_code))
        return pairs

    def available_pairs(self) -> list[tuple[str, str]]:
        """List remotely-available pairs from the Argos package index.

        Best-effort and offline-tolerant: requires a prior
        ``argostranslate.package.update_package_index()`` (network). Returns an
        empty list if the index is unavailable, so the worker never blocks on
        the network.
        """
        try:
            from argostranslate import package as argos_package  # type: ignore

            available = argos_package.get_available_packages()
        except Exception as exc:  # offline / not installed -> just report none
            logger.debug("Argos: available package index unavailable: %s", exc)
            return []

        pairs: list[tuple[str, str]] = []
        for pkg in available:
            from_code = getattr(pkg, "from_code", None)
            to_code = getattr(pkg, "to_code", None)
            if from_code and to_code:
                pairs.append((from_code, to_code))
        return pairs

    # -- translation ------------------------------------------------------

    def translate(self, text: str, from_lang: str, to_lang: str) -> str:
        self._ensure_loaded()

        if not text.strip():
            return text  # nothing to do; preserve empty/whitespace segments

        from_obj = self._find_language(from_lang)
        to_obj = self._find_language(to_lang)
        translation = None
        if from_obj is not None and to_obj is not None:
            translation = from_obj.get_translation(to_obj)

        if translation is None:
            raise self._missing_package_error(from_lang, to_lang)

        return translation.translate(text)

    # -- helpers ----------------------------------------------------------

    def _find_language(self, code: str):
        for lang in self._languages:
            if getattr(lang, "code", None) == code:
                return lang
        return None

    @staticmethod
    def _missing_package_error(from_lang: str, to_lang: str) -> AppErrorException:
        """Build the structured TRANSLATION_PACKAGE_MISSING error."""
        return AppErrorException.make(
            code="TRANSLATION_PACKAGE_MISSING",
            message=(
                f"No installed Argos translation package for '{from_lang}' -> '{to_lang}'."
            ),
            status_code=422,
            remediation=(
                "Install the language package, then restart the worker. Options:\n"
                f"  • CLI:    argospm install translate-{from_lang}_{to_lang}\n"
                "  • Python: argostranslate.package.update_package_index(); "
                "then install_from_path() the matching .argosmodel\n"
                f"  • GUI:    Argos Translate app -> Manage Packages\n"
                f"See {_MODEL_SETUP_DOC} for offline install instructions."
            ),
            docs_ref=_MODEL_SETUP_DOC,
        )


# ----------------------------------------------------------------------------
# Cloud provider placeholders (FUTURE / optional). Each documents its env vars
# and raises NotImplementedError until wired up. Argos remains the default.
# ----------------------------------------------------------------------------


class _UnimplementedCloudBackend:
    """Shared base for not-yet-implemented cloud backends."""

    id = "cloud"
    display_name = "Cloud (unimplemented)"
    is_local = False
    #: Human-readable list of env vars the future implementation will read.
    env_vars: tuple[str, ...] = ()

    def installed_pairs(self) -> list[tuple[str, str]]:
        return []

    def available_pairs(self) -> list[tuple[str, str]]:
        return []

    def translate(self, text: str, from_lang: str, to_lang: str) -> str:  # noqa: ARG002
        raise NotImplementedError(
            f"{self.display_name} backend is a placeholder. "
            f"TODO: implement using env vars: {', '.join(self.env_vars) or '(none)'}."
        )


class DeepLBackend(_UnimplementedCloudBackend):
    """TODO: implement DeepL translation. Reads ``DEEPL_API_KEY``."""

    id = "deepl"
    display_name = "DeepL (cloud)"
    env_vars = ("DEEPL_API_KEY",)


class GoogleBackend(_UnimplementedCloudBackend):
    """TODO: implement Google Cloud Translation.

    Reads ``GOOGLE_APPLICATION_CREDENTIALS`` (path to service-account JSON).
    """

    id = "google"
    display_name = "Google Cloud Translation (cloud)"
    env_vars = ("GOOGLE_APPLICATION_CREDENTIALS",)


class AzureBackend(_UnimplementedCloudBackend):
    """TODO: implement Azure Translator.

    Reads ``AZURE_SPEECH_KEY`` / ``AZURE_SPEECH_REGION`` (shared Azure creds).
    """

    id = "azure"
    display_name = "Azure Translator (cloud)"
    env_vars = ("AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION")


class OpenAIBackend(_UnimplementedCloudBackend):
    """TODO: implement LLM-based translation via OpenAI. Reads ``OPENAI_API_KEY``."""

    id = "openai"
    display_name = "OpenAI (cloud)"
    env_vars = ("OPENAI_API_KEY",)


#: Registry of known backend classes by id (Argos is the only local default).
BACKEND_REGISTRY: dict[str, type] = {
    ArgosBackend.id: ArgosBackend,
    DeepLBackend.id: DeepLBackend,
    GoogleBackend.id: GoogleBackend,
    AzureBackend.id: AzureBackend,
    OpenAIBackend.id: OpenAIBackend,
}
