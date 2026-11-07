"""The GPU (PyTorch) build of VieNeu v3, tested without torch, the SDK or a GPU.

What is pinned here, and why it matters:

* the model snapshots are fetched at fixed commits, because the codec is loaded
  with ``trust_remote_code`` (its repo's Python runs on the user's machine);
* the CUDA-kernel check, whose first version would have refused every RTX 40;
* the batching that is the GPU's entire speed-up (one line at a time it is
  slower than the tuned CPU), and its fallbacks, which must never lose a line;
* ``POST /warmup``, because the GPU model must not load at process start.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from vd_tts_engine import app as app_mod
from vd_tts_engine import engine as engine_mod
from vd_tts_engine import pinned
from vd_tts_engine.app import SegmentIn, SynthesizeRequest, synthesize_segments
from vd_tts_engine.engine import VieNeuEngine, cuda_build_supports, vieneu_device
from vd_tts_engine.wavio import read_wav_duration_ms, write_silent_wav

# torch.cuda.get_arch_list() of the two builds the pack installs, read from
# torch 2.14.1 on 2026-11-07. Note cu126 has no sm_89 and no PTX (compute_XY).
CU126 = ["sm_50", "sm_60", "sm_61", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"]
CU130 = ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


# ---- which cards a build can run -------------------------------------------


@pytest.mark.parametrize(
    "card, capability, cu126, cu130",
    [
        ("GTX 1060", (6, 1), True, False),  # Pascal: cu130 dropped it
        ("GTX 1660", (7, 5), True, True),
        ("RTX 3050", (8, 6), True, True),  # measured on both
        ("RTX 4090", (8, 9), True, True),  # no sm_89 in cu126: runs on sm_86 code
        ("H100", (9, 0), True, True),
        ("RTX 5090", (12, 0), False, True),  # Blackwell: cu126 has no kernel and no PTX
        ("GTX 780", (3, 5), False, False),
    ],
)
def test_cuda_build_supports(card: str, capability: tuple[int, int], cu126: bool, cu130: bool):
    assert cuda_build_supports(capability, CU126) is cu126, card
    assert cuda_build_supports(capability, CU130) is cu130, card


def test_ptx_runs_on_any_newer_card():
    assert cuda_build_supports((12, 0), ["sm_80", "compute_80"]) is True
    assert cuda_build_supports((7, 5), ["compute_80"]) is False


def test_cuda_build_supports_ignores_odd_entries():
    assert cuda_build_supports((8, 6), ["sm_x", "compute_", "", "sm_8"]) is False


def test_vieneu_device_is_cuda_only_when_asked():
    assert vieneu_device({"VIENEU_DEVICE": "cuda"}) == "cuda"
    assert vieneu_device({"VIENEU_DEVICE": " CUDA "}) == "cuda"
    for other in ({"VIENEU_DEVICE": "mps"}, {"VIENEU_DEVICE": ""}, {}):
        assert vieneu_device(other) == "cpu"


# ---- pinned model snapshots -------------------------------------------------


def test_pins_are_commits_not_branches():
    for repo in (pinned.BACKBONE, pinned.CODEC):
        assert re.fullmatch(r"[0-9a-f]{40}", repo.revision), repo.repo_id
    # The codec's .py files are what trust_remote_code executes: they must be fetched.
    assert "*.py" in pinned.CODEC.files


def test_models_root():
    assert pinned.models_root({"VD_PACK_DIR": "/p"}) == Path("/p") / "models"
    assert pinned.models_root({"HF_HOME": str(Path("/p") / "hf")}) == Path("/p") / "models"
    assert pinned.models_root({}) == Path.home() / ".cache" / "vd_tts_engine" / "models"


def _downloader(repo: pinned.PinnedRepo, *, write: tuple[str, ...] | None = None, fail: bool = False):
    calls: list[dict] = []

    def download(**kwargs):
        calls.append(kwargs)
        if fail:
            raise OSError("connection reset")
        dest = Path(kwargs["local_dir"])
        for name in repo.required if write is None else write:
            (dest / name).write_bytes(b"x")

    return download, calls


def test_ensure_downloads_the_pinned_revision_once(tmp_path: Path):
    download, calls = _downloader(pinned.BACKBONE)
    dest = pinned.ensure(pinned.BACKBONE, tmp_path, download=download)
    assert dest == tmp_path / "pnnbao-ump__VieNeu-TTS-v3-Turbo"
    assert calls == [
        {
            "repo_id": pinned.BACKBONE.repo_id,
            "revision": pinned.BACKBONE.revision,
            "allow_patterns": list(pinned.BACKBONE.files),
            "local_dir": str(dest),
        }
    ]
    assert (dest / pinned.MARKER).read_text(encoding="utf-8") == pinned.BACKBONE.revision
    # Offline after the first load: a complete snapshot never touches the network.
    pinned.ensure(pinned.BACKBONE, tmp_path, download=download)
    assert len(calls) == 1


def test_a_pin_bump_downloads_again(tmp_path: Path):
    download, calls = _downloader(pinned.CODEC)
    dest = pinned.ensure(pinned.CODEC, tmp_path, download=download)
    (dest / pinned.MARKER).write_text("0" * 40, encoding="utf-8")  # an older pin
    pinned.ensure(pinned.CODEC, tmp_path, download=download)
    assert len(calls) == 2


def test_an_incomplete_download_is_never_marked_complete(tmp_path: Path):
    download, _ = _downloader(pinned.BACKBONE, write=("config.json",))  # no weights
    with pytest.raises(RuntimeError, match="model.safetensors"):
        pinned.ensure(pinned.BACKBONE, tmp_path, download=download)
    assert not pinned.is_complete(tmp_path / pinned.BACKBONE.dirname, pinned.BACKBONE)


def test_an_interrupted_redownload_invalidates_the_old_marker(tmp_path: Path):
    good, _ = _downloader(pinned.BACKBONE)
    dest = pinned.ensure(pinned.BACKBONE, tmp_path, download=good)
    (dest / pinned.MARKER).write_text("0" * 40, encoding="utf-8")
    broken, _ = _downloader(pinned.BACKBONE, fail=True)
    with pytest.raises(OSError):
        pinned.ensure(pinned.BACKBONE, tmp_path, download=broken)
    # Half-overwritten files must not pass for the old revision either.
    assert not (dest / pinned.MARKER).exists()


def test_ensure_gpu_models_returns_both(tmp_path: Path):
    def download(**kwargs):
        repo = pinned.BACKBONE if kwargs["repo_id"] == pinned.BACKBONE.repo_id else pinned.CODEC
        for name in repo.required:
            (Path(kwargs["local_dir"]) / name).write_bytes(b"x")

    backbone, codec = pinned.ensure_gpu_models(tmp_path, download=download)
    assert backbone.name == pinned.BACKBONE.dirname
    assert codec.name == pinned.CODEC.dirname


# ---- loading on the GPU, and falling back --------------------------------------


def _fake_torch(*, available=True, capability=(8, 6), arch=CU130) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.__version__ = "2.14.1+cu130"
    torch.version = types.SimpleNamespace(cuda="13.0")
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: available,
        get_device_name=lambda _i: "NVIDIA GeForce RTX 3050",
        get_device_capability=lambda _i: capability,
        get_arch_list=lambda: list(arch),
    )
    torch.manual_seed = lambda _s: None
    return torch


class _FactoryLog:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return types.SimpleNamespace(engine="inner-engine", kwargs=kwargs)


@pytest.fixture
def sdk(monkeypatch: pytest.MonkeyPatch):
    """A stand-in `vieneu` SDK: Vieneu() records how it was built."""
    log = _FactoryLog()
    vieneu = types.ModuleType("vieneu")
    vieneu.Vieneu = log
    serve = types.ModuleType("vieneu.v3_turbo_serve")
    serve_engine = types.ModuleType("vieneu.v3_turbo_serve.engine")
    serve_engine.V3TurboBatchEngine = lambda inner: types.SimpleNamespace(inner=inner)
    monkeypatch.setitem(sys.modules, "vieneu", vieneu)
    monkeypatch.setitem(sys.modules, "vieneu.v3_turbo_serve", serve)
    monkeypatch.setitem(sys.modules, "vieneu.v3_turbo_serve.engine", serve_engine)
    monkeypatch.setattr(engine_mod.hfcache, "hub_dir", lambda: None)
    monkeypatch.setattr(pinned, "ensure_gpu_models", lambda _root: (Path("/m/backbone"), Path("/m/codec")))
    monkeypatch.setenv("VIENEU_DEVICE", "cuda")
    return log


def test_loads_the_pinned_pytorch_model_on_the_gpu(sdk: _FactoryLog, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch())
    eng = VieNeuEngine("v3")
    eng._ensure_loaded()
    assert sdk.calls == [
        {"device": "cuda", "backend": "pytorch", "backbone_repo": str(Path("/m/backbone")), "moss_tokenizer": str(Path("/m/codec"))}
    ]
    assert (eng.device, eng.device_name, eng.device_note) == ("cuda", "NVIDIA GeForce RTX 3050", None)
    assert eng._batcher.inner == "inner-engine"


def test_an_unsupported_card_falls_back_to_the_cpu_and_says_why(sdk: _FactoryLog, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(capability=(12, 0), arch=CU126))
    eng = VieNeuEngine("v3")
    eng._ensure_loaded()
    assert sdk.calls == [{}]  # the ONNX (CPU) build: Vieneu() with no arguments
    assert eng.device == "cpu"
    assert eng.device_note.startswith("GPU unavailable, using the CPU instead: ")
    assert "sm_120" in eng.device_note and "not supported by this PyTorch build" in eng.device_note


def test_an_invisible_gpu_falls_back_naming_the_driver(sdk: _FactoryLog, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(available=False))
    eng = VieNeuEngine("v3")
    eng._ensure_loaded()
    assert eng.device == "cpu"
    assert "driver" in eng.device_note


def test_the_cpu_pack_never_touches_torch(sdk: _FactoryLog, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("VIENEU_DEVICE", "cpu")
    monkeypatch.setitem(sys.modules, "torch", None)  # importing it would raise
    eng = VieNeuEngine("v3")
    eng._ensure_loaded()
    assert (eng.device, eng.device_note) == ("cpu", None)


# ---- synth_many: batching on the GPU ----------------------------------------


class _Backend:
    """The SDK surface _synth_batch_gpu and synth() touch."""

    def __init__(self) -> None:
        self.infers: list[str] = []

    def _resolve_v3_ref(self, name, _a, _b):  # noqa: ANN001
        return f"ref:{name}", 7

    def infer(self, text, voice=None):  # noqa: ANN001, ARG002
        self.infers.append(text)
        return ("audio", text)

    def _apply_watermark(self, audio):  # noqa: ANN001
        return audio

    def save(self, audio, out_path):  # noqa: ANN001, ARG002
        write_silent_wav(out_path, 100, sample_rate=48000)


class _Batcher:
    def __init__(self, fail: bool = False) -> None:
        self.batches: list[list[dict]] = []
        self.kwargs: list[dict] = []
        self.fail = fail

    def generate_batch(self, requests, **kwargs):  # noqa: ANN001
        if self.fail:
            raise RuntimeError("CUDA out of memory")
        self.batches.append(requests)
        self.kwargs.append(kwargs)
        return [("wave", r["phonemes"]) for r in requests]


@pytest.fixture
def gpu_engine(monkeypatch: pytest.MonkeyPatch):
    core = types.ModuleType("vieneu_utils.core_utils")
    core.split_text_into_chunks = lambda text, max_chars: [text[i : i + max_chars] for i in range(0, len(text), max_chars)]
    core.join_audio_chunks = lambda parts, sr, silence_p, crossfade_p: ("joined", tuple(parts), sr, silence_p)  # noqa: ARG005
    phon = types.ModuleType("vieneu_utils.phonemize_text")
    phon.phonemize_text_with_emotions = lambda text: f"/{text}/"
    monkeypatch.setitem(sys.modules, "vieneu_utils", types.ModuleType("vieneu_utils"))
    monkeypatch.setitem(sys.modules, "vieneu_utils.core_utils", core)
    monkeypatch.setitem(sys.modules, "vieneu_utils.phonemize_text", phon)

    eng = VieNeuEngine("v3")
    eng._backend = _Backend()
    eng._device = "cuda"
    eng._batcher = _Batcher()
    return eng


def test_lines_are_generated_together_with_the_sdk_sampling(gpu_engine: VieNeuEngine, tmp_path: Path):
    outs = [str(tmp_path / f"{i}.wav") for i in range(3)]
    errors = gpu_engine.synth_many(["Một câu dài hơn nhiều", "  ", "Xin chào"], outs, None, 1.0)
    assert errors[0] is None and errors[2] is None
    assert isinstance(errors[1], ValueError)  # empty text fails alone
    batcher = gpu_engine._batcher
    assert len(batcher.batches) == 1
    # Sorted by phoneme length, so short lines are not padded to the longest.
    assert [r["phonemes"] for r in batcher.batches[0]] == ["/Xin chào/", "/Một câu dài hơn nhiều/"]
    assert batcher.batches[0][0]["ref_codes"] == "ref:Ngọc Lan"
    assert batcher.kwargs == [engine_mod._V3_SAMPLING]
    assert Path(outs[0]).is_file() and Path(outs[2]).is_file() and not Path(outs[1]).exists()
    assert gpu_engine._backend.infers == []  # nothing went the slow way


def test_batches_are_capped_at_24_lines(gpu_engine: VieNeuEngine, tmp_path: Path):
    texts = [f"câu {i}" for i in range(30)]
    gpu_engine.synth_many(texts, [str(tmp_path / f"{i}.wav") for i in range(30)], None, 1.0)
    assert [len(b) for b in gpu_engine._batcher.batches] == [24, 6]


def test_a_long_line_is_split_and_joined_like_infer_does(gpu_engine: VieNeuEngine, tmp_path: Path):
    joined: list[tuple] = []
    gpu_engine._backend.save = lambda audio, path: (joined.append(audio), write_silent_wav(path, 100, sample_rate=48000))
    gpu_engine.synth_many(["a" * 300, "b"], [str(tmp_path / "0.wav"), str(tmp_path / "1.wav")], None, 1.0)
    first = next(j for j in joined if len(j[1]) == 2)  # 300 chars -> two 256-char chunks
    assert first[2:] == (48000, engine_mod._V3_JOIN_SILENCE)


def test_a_failed_batch_falls_back_to_one_line_at_a_time(gpu_engine: VieNeuEngine, tmp_path: Path):
    gpu_engine._batcher = _Batcher(fail=True)
    outs = [str(tmp_path / f"{i}.wav") for i in range(2)]
    assert gpu_engine.synth_many(["một", "hai"], outs, None, 1.0) == [None, None]
    assert gpu_engine._backend.infers == ["một", "hai"]


def test_the_cpu_path_never_batches(gpu_engine: VieNeuEngine, tmp_path: Path):
    gpu_engine._device = "cpu"
    gpu_engine.synth_many(["một", "hai"], [str(tmp_path / "0.wav"), str(tmp_path / "1.wav")], None, 1.0)
    assert gpu_engine._batcher.batches == []
    assert gpu_engine._backend.infers == ["một", "hai"]


# ---- the route: every miss in ONE engine call --------------------------------


class _RouteEngine:
    sample_rate = 48000
    variant = "v3"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def clip_key(self, text: str, voice_id: str | None) -> str:
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")
        return hashlib.sha256(f"{voice_id}|{clean}".encode()).hexdigest()

    def synth_many(self, texts, out_paths, voice_id, speed):  # noqa: ANN001, ARG002
        self.calls.append(list(texts))
        errors: list[BaseException | None] = []
        for text, path in zip(texts, out_paths):
            if text == "FAIL":
                errors.append(RuntimeError("boom"))
            else:
                write_silent_wav(path, 300, sample_rate=48000)
                errors.append(None)
        return errors


def _request(out: Path, *texts: str) -> SynthesizeRequest:
    return SynthesizeRequest(
        language="vi-VN",
        voiceId="vieneu-v3-gia-bao",
        outputDir=str(out),
        segments=[SegmentIn(id=f"seg_{i:04d}", text=t, startMs=i * 1000, endMs=i * 1000 + 800) for i, t in enumerate(texts, 1)],
    )


def test_the_route_sends_all_misses_in_one_call_and_reuses_the_rest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    eng = _RouteEngine()
    monkeypatch.setattr(app_mod, "_engine", eng)

    first = synthesize_segments(_request(tmp_path, "một", "hai", "FAIL", ""))
    assert eng.calls == [["một", "hai", "FAIL"]]  # the empty line never reaches the model
    assert (first.fallbackSegments, first.reusedSegments) == (2, 0)
    # A failed line becomes silence sized to its window.
    assert abs(read_wav_duration_ms(Path(first.segments[2].audioPath)) - 800) <= 5

    second = synthesize_segments(_request(tmp_path, "một", "hai", "ba", "FAIL"))
    assert eng.calls[1] == ["ba", "FAIL"]  # finished lines are reused; a failure is not cached
    assert second.reusedSegments == 2


# ---- warming up: POST /warmup, and never at start on the GPU -----------------


def test_warmup_route_starts_loading_once(monkeypatch: pytest.MonkeyPatch):
    ran: list[int] = []
    done = threading.Event()

    def fake_warmup() -> None:
        ran.append(1)
        done.set()

    monkeypatch.setattr(app_mod, "_warmup", fake_warmup)
    app_mod._warmup_started.clear()
    try:
        assert app_mod.warmup().status == "ok"
        app_mod.warmup()
        assert done.wait(5)
        time.sleep(0.05)
        assert ran == [1]
    finally:
        app_mod._warmup_started.clear()


@pytest.mark.parametrize("device, warms_at_start", [("cuda", False), ("cpu", True), (None, True)])
def test_the_gpu_model_waits_for_post_warmup(monkeypatch: pytest.MonkeyPatch, device: str | None, warms_at_start: bool):
    # Loading at start would put the model on the card while the orchestrator may
    # still hold it for llama.cpp; an out-of-memory then pins the engine to the CPU.
    starts: list[int] = []
    monkeypatch.setattr(app_mod, "_start_warmup", lambda: starts.append(1))
    if device is None:
        monkeypatch.delenv("VIENEU_DEVICE", raising=False)
    else:
        monkeypatch.setenv("VIENEU_DEVICE", device)

    async def run() -> None:
        async with app_mod._lifespan(None):
            pass

    asyncio.run(run())
    assert bool(starts) is warms_at_start


def test_health_reports_where_synthesis_runs(monkeypatch: pytest.MonkeyPatch):
    eng = VieNeuEngine("v3")
    eng._device, eng._device_name, eng._device_note = "cpu", None, "GPU unavailable, using the CPU instead: x"
    monkeypatch.setattr(app_mod, "_engine", eng)
    h = app_mod.health()
    assert (h.device, h.deviceName, h.deviceNote) == ("cpu", None, "GPU unavailable, using the CPU instead: x")
