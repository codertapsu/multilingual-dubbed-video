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
