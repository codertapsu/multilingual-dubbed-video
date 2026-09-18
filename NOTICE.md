# NOTICE

VideoDubber's **own source code** is licensed under the MIT License (see
[`LICENSE`](./LICENSE)).

The shipped **installer** is not only that source code. Since sidecar packaging
landed (v0.1.0) every `.dmg` / `.exe` / `.msi` also *conveys* third-party
binaries, two of which are **GPL**. This file is split accordingly:

- [Redistributed in the installer](#redistributed-in-the-installer) — what a
  `.dmg`/`.exe` actually contains, and the obligations that attach to it.
- [Invoked, not redistributed](#invoked-not-redistributed) — things the *user*
  downloads at runtime, which the installer does not carry.
- [Optional model weights — pass-through obligations](#optional-model-weights--pass-through-obligations)
  — weights with their own non-OSI terms.

> **History.** Until 2026-09 this file claimed FFmpeg and Piper were "invoked,
> not bundled". That was true of the pre-v0.1.0 dev-only layout and has been
> wrong of every published release since: both are `bundle.externalBin`
> sidecars. If you relied on the old text to conclude that no GPL obligations
> attach to redistributing a VideoDubber installer, re-read the section below.

## Reference material

The project [`jianchang512/stt`](https://github.com/jianchang512/stt) — which is
distributed under the **GPL-3.0** license — was studied as a **reference only**
while designing VideoDubber's local speech-to-text and dubbing pipeline.

**No GPL-licensed source code from that project (or any other GPL project) was
copied, adapted, or otherwise incorporated into VideoDubber.** All code in this
repository is original work written for VideoDubber, or uses third-party
dependencies under their own licenses.

Because the VideoDubber **codebase** contains no GPL code, the MIT license
applies to the entire codebase. That is a statement about *this repository*, not
about the distribution: the GPL binaries listed below are separate programs,
aggregated into the installer and executed as separate processes, and they remain
under their own upstream licenses.

---

## Redistributed in the installer

These ship **inside** the `.dmg` / `-setup.exe` / `.msi`. The authoritative list
is `bundle.externalBin` and `bundle.resources` in
[`apps/desktop/src-tauri/tauri.conf.json`](apps/desktop/src-tauri/tauri.conf.json);
keep this table in step with it.

| Component | Where | License | Upstream |
|---|---|---|---|
| **FFmpeg / ffprobe** (`ffmpeg`, `ffprobe` sidecars) | `externalBin` | **GPL-2.0-or-later / GPL-3.0** — these are `-gpl` "full" builds (chosen for libass, needed for burned-in subtitles) | macOS: <https://ffmpeg.martin-riedl.de> · Windows/Linux: <https://github.com/BtbN/FFmpeg-Builds> · sources: <https://ffmpeg.org/download.html> |
| **Piper** (`vd-piper` sidecar) | `externalBin` | **GPL-3.0** (`piper1-gpl`), bundling **espeak-ng** data, also **GPL-3.0** | <https://github.com/OHF-Voice/piper1-gpl> · espeak-ng: <https://github.com/espeak-ng/espeak-ng> |
| **uv** (`vd-uv` sidecar) | `externalBin` | Apache-2.0 OR MIT | <https://github.com/astral-sh/uv> |
| **Node.js runtime** (inside the `videodubber-orchestrator` single-file executable) | `externalBin` | MIT (with OpenSSL — Apache-2.0 — and ICU/Unicode components under their own terms) | <https://github.com/nodejs/node> |
| **CPython** — standalone interpreter (`resources/python`) **and** the copies frozen into the three PyInstaller workers | `resources` | PSF License Agreement 2.0 | <https://github.com/astral-sh/python-build-standalone> · <https://www.python.org> |
| **Python worker dependency stack**, frozen into `resources/workers/vd-{stt,translation,tts}-worker` | `resources` | Permissive: faster-whisper (MIT), CTranslate2 (MIT), onnxruntime (MIT), argostranslate (MIT), MiniSBD, FastAPI (MIT), Starlette (BSD-3-Clause), uvicorn (BSD-3-Clause), pydantic (MIT) — each with its own notices | per package on PyPI |
| **PyInstaller bootloader** (in each frozen worker and in `vd-piper`) | `externalBin` / `resources` | GPL-2.0-or-later **with the PyInstaller bootloader exception**, which permits distributing frozen applications under any license | <https://github.com/pyinstaller/pyinstaller> |
| `resources/engine-src/vd_tts_engine` | `resources` | MIT — first-party VideoDubber source | this repository |
| `resources/default-models` | `resources` | **Empty in published releases.** Only populated when a build sets `BUNDLE_DEFAULT_MODELS=1`; a build that does so additionally conveys those model weights under their own licenses. | — |

### GPL obligations for redistributors

Because the installer conveys **FFmpeg** and **Piper/espeak-ng** binaries under
the GPL, anyone who redistributes a VideoDubber installer takes on the GPL's
source-availability obligation **for those binaries** (GPL-2.0 §3 / GPL-3.0 §6).
The MIT license on VideoDubber's own code is unaffected — the GPL programs are
separate executables invoked as subprocesses, which is aggregation, not a
derived work.

To satisfy it, either ship the corresponding sources alongside, or accompany the
distribution with a written offer. The corresponding sources for the builds this
project uses are published at the upstream URLs in the table above; record the
exact build/version you shipped (the fetch scripts,
[`scripts/package/fetch-ffmpeg.{sh,ps1}`](scripts/package/), pin it) so the offer
is specific rather than a general link.

> This is the one part of this file that is not purely a writing task. Have a
> lawyer review the wording before relying on it for a commercial redistribution.

---

## Invoked, not redistributed

These are **not** in the installer. The user downloads them at runtime, into
their own `~/VideoDubber` folder, through Settings → Engines or the first-run
wizard. They remain under their upstream licenses and are executed as separate
processes.

- **llama.cpp / `llama-server`** — local LLM runtime binary (MIT), downloaded as
  an engine pack from ggml-org's upstream releases.
- **whisper.cpp / `whisper-server`** — accelerated STT runtime (MIT), downloaded
  as an engine pack.
- **Argos Translate language packages** (`.argosmodel`) — fetched on demand from
  the Argos package index; each package carries its own terms.
- **Piper voices** (`.onnx` + `.onnx.json`) — downloaded per target language;
  most are CC-BY or similar, per voice.
- **faster-whisper / Whisper model weights** — downloaded from HuggingFace into
  the app's model cache (MIT for the CTranslate2 conversions; the original
  OpenAI Whisper weights are MIT).
- **Python engine packs** (neural TTS, and any future separation/alignment
  packs) — materialized into a `uv`-managed virtual environment on the user's
  machine from pinned requirements; the packages install from PyPI at that
  point, not from us.

If you redistribute VideoDubber **together with** any of the above (for example
by pre-seeding a machine image), review and comply with each component's own
license terms — at that point they move into the section above.

---

## Optional model weights — pass-through obligations

These are **not** bundled in the installer; the user downloads them on demand as
engine packs. They carry their own licenses, which the app surfaces before
install and which a redistributor must honor.

### TranslateGemma (`translategemma-4b` / `-12b` / `-27b` model packs)

The TranslateGemma weights are provided under the **Gemma Terms of Use**
(<https://ai.google.dev/gemma/terms>) — **not** MIT/Apache. We distribute them as
community **GGUF requants** of Google's `google/translategemma-*-it` models.

- **Commercial use is permitted** by the Gemma Terms.
- Use is subject to Google's **Gemma Prohibited Use Policy**
  (<https://ai.google.dev/gemma/prohibited_use_policy>).
- **Output** (the translations) belongs to the user (Gemma Terms §3.3).
- If you **redistribute** VideoDubber with these weights bundled, the Gemma Terms
  (§3.1/§3.2) require you to: (a) include the notice
  *"Gemma is provided under and subject to the Gemma Terms of Use found at
  ai.google.dev/gemma/terms"*; (b) give recipients a copy of the Gemma Terms; and
  (c) propagate the Use Restrictions to end users (e.g. as an EULA clause).
- The app does **not** auto-download from the gated `google/*` repos; it pulls
  **ungated community GGUF requants** pinned by URL + sha256 in
  `enginePackCatalog.ts`.

> The Gemma Terms were last revised 2026-04-01 — re-check the current text before
> shipping a build that bundles the weights. (A future Gemma-4-based TranslateGemma
> would move to Apache-2.0 and drop these obligations.)

### VieNeu-TTS (`tts-neural` engine pack)

The shipping Vietnamese neural voice pack is **Apache-2.0** (engine code and v3
weights), and uses the MOSS-Audio-Tokenizer-Nano codec and the sea-g2p
phonemizer — verify those components' licenses if you redistribute. Output
carries an imperceptible AI-audio watermark.

> A withdrawn v2 pack (`tts-neural-v2`, in `DISABLED_PACK_IDS`, never offered in
> Settings) bundled **CC BY-NC 4.0** reference voices — non-commercial only, with
> attribution to *pnnbao-ump*. Noted here so the reasoning is not lost if anyone
> considers re-enabling it.

### OmniVoice (`tts-omnivoice` engine pack — Apple Silicon only, ON HOLD)

> **Status:** this pack is currently **excluded from releases** (gated in
> `DISABLED_PACK_IDS`; its worker source is not bundled) while output quality
> stabilizes — see [docs/OMNIVOICE.md](docs/OMNIVOICE.md). The license notes below
> apply whenever it ships again.

The optional OmniVoice neural-TTS engine pack runs k2-fsa's **OmniVoice** on Apple
Silicon via the official **PyTorch** package on the Metal (MPS) backend (the MLX
ports degrade the audio codec). It is **not** bundled — the user installs it on
demand, and the model (`k2-fsa/OmniVoice`) downloads on first use.

- **OmniVoice** code + weights are **Apache-2.0** (k2-fsa).
- **BUT** the model bundles the **HiggsAudio tokenizer**, whose weights are under
  the **Boson Higgs Audio 2 Community License** — a custom, **non-OSI** license
  (Meta-Llama-3-derived) with a **100,000-annual-active-users** commercial gate and
  a no-competing-model clause. This is acceptable for VideoDubber as an open-source,
  non-commercial app, but **a commercial redistributor must review it** (and may
  need a separate license from Boson AI).
- `torch` / `torchaudio` are **BSD-3-Clause**.
- Reference-audio voice cloning is **not** enabled; only "designed" voices
  (the model's trained instruct vocabulary) are offered.

> Re-check the Boson Higgs Audio 2 Community License before shipping a build that
> bundles or auto-downloads these weights.
