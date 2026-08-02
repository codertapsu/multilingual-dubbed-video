# PyInstaller runtime hook (Translation): runs BEFORE entry_worker.main().
#
# Two jobs: name the worker, and keep PyTorch out of this binary.
#
# WHY THE STUB: argostranslate/sbd.py does a bare, module-level `import stanza`,
# and stanza imports torch. That single edge pulled ~580 MB into the bundle
# (torch 319 MB + libtorch_cpu 236 MB + libtorch_python 27 MB) — about 40% of the
# whole app — for sentence-boundary detection. Argos has a second splitter,
# MiniSBD, which runs on the onnxruntime we already ship and produced identical
# splits in A/B testing on ASR-shaped text.
#
# So we register an empty `stanza` module before argostranslate is imported. The
# bare import then succeeds without loading torch, and `stanza.Pipeline` is only
# dereferenced inside StanzaSentencizer, which this build never selects:
# ARGOS_CHUNK_TYPE=MINISBD forces MiniSBDSentencizer (argostranslate.settings),
# and the packages are seeded with a MiniSBD model at install time so nothing is
# fetched mid-dub (see ArgosBackend._seed_minisbd_model).
import os
import sys
import types

os.environ.setdefault("VD_WORKER", "translation")

# Force MiniSBD even for a package that only carries a stanza model, so the
# stubbed stanza can never be selected.
os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")

if "stanza" not in sys.modules:
    _stanza = types.ModuleType("stanza")
    _stanza.__spec__ = types.SimpleNamespace(name="stanza", loader=None, origin="videodubber-stub")
    _stanza.__version__ = "0.0.0-videodubber-stub"

    def _no_stanza(*_args, **_kwargs):
        raise RuntimeError(
            "This build ships MiniSBD for sentence splitting, not stanza "
            "(stanza pulls in PyTorch). Unset ARGOS_CHUNK_TYPE only in a "
            "source checkout where stanza is installed."
        )

    _stanza.Pipeline = _no_stanza
    _stanza.download = _no_stanza
    sys.modules["stanza"] = _stanza
