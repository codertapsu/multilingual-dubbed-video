# NOTICE

VideoDubber is licensed under the MIT License (see [`LICENSE`](./LICENSE)).

## Reference material

The project [`jianchang512/stt`](https://github.com/jianchang512/stt) — which is
distributed under the **GPL-3.0** license — was studied as a **reference only**
while designing VideoDubber's local speech-to-text and dubbing pipeline.

**No GPL-licensed source code from that project (or any other GPL project) was
copied, adapted, or otherwise incorporated into VideoDubber.** All code in this
repository is original work written for VideoDubber, or uses third-party
dependencies under their own permissive licenses (e.g. faster-whisper, Argos
Translate, Piper, FFmpeg as an external binary invoked via subprocess).

Because VideoDubber contains no GPL code, the MIT license applies to the entire
VideoDubber codebase. External tools such as FFmpeg are invoked as separate
processes and are not linked into or redistributed as part of this project; they
remain under their respective upstream licenses.

## Third-party components (invoked, not bundled)

- **FFmpeg / ffprobe** — invoked as external binaries; not redistributed here.
- **faster-whisper** — speech-to-text models/runtime (see upstream license).
- **Argos Translate** — offline translation (MIT engine; see upstream license).
- **Piper** — neural text-to-speech (see upstream license).
- **llama.cpp / `llama-server`** — local LLM runtime binary (MIT), downloaded as an
  engine pack from ggml-org's upstream releases.

If you redistribute VideoDubber together with any of the above, review and
comply with each component's own license terms.

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
