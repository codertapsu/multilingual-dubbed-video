# OmniVoice engine pack — status: ON HOLD (not in releases)

> **TL;DR.** The OmniVoice neural-TTS pack (`tts-omnivoice`, Apple Silicon only)
> was fully reworked onto the official **PyTorch/MPS** pipeline and its two known
> root-cause bugs are fixed, but overall output quality is still **not stable
> enough to ship**. The pack is therefore **excluded from releases**: it is gated
> out of the Settings → Engines catalog and its worker source is not bundled.
> The code stays in-tree so work can resume at any time. This file is the single
> place that tracks its status.

## Where it stands

| Aspect | State |
| --- | --- |
| Worker (`workers/tts-engine-omnivoice/`) | Complete rewrite on the official `omnivoice` PyTorch package, `device_map="mps"`, fp16 — the same pipeline as the k2-fsa HF Space. 18 unit tests pass. |
| Root cause #1 — degraded audio | **Fixed.** The earlier MLX port (`mlx-audio`, bf16) degraded the HiggsAudio codec; the PyTorch/MPS path does not. Confirmed by A/B listening (PyTorch clearly better). |
| Root cause #2 — rejected voices | **Fixed.** Voice-Design instructs use a CLOSED trained vocabulary (gender / age / pitch / whisper / accent). Invalid tags (e.g. "bright") made the model reject the instruct. All 4 curated voices now use valid attributes only. |
| Dependency pinning | `torch==2.12.1` pairs with `torchaudio==2.11.0` (torchaudio lags torch by a minor version; there is no torchaudio 2.12.x). Pinned in `uvRequirements.ts`. |
| Per-voice consistency | Per-voice torch seeds + an audibility re-roll loop; validated on a synthetic Vietnamese set (F0 std ~24 Hz, no gender flips, no inaudible segments). |
| **Remaining problem** | Overall naturalness/quality is still inconsistent across real-world content — not yet at the bar for a release. |

## How it is kept out of releases

Two independent gates (both must be reverted to re-enable):

1. **Catalog gate** — `tts-omnivoice` is in `DISABLED_PACK_IDS`
   ([enginePackCatalog.ts](../packages/node-orchestrator/src/engines/enginePackCatalog.ts)),
   so it never appears in Settings → Engines and cannot be installed.
2. **Bundle gate** — `vd_omnivoice` is NOT staged into the app bundle
   ([stage-engine-src.mjs](../scripts/package/stage-engine-src.mjs) omits it), so
   released apps do not carry its source at all.

Everything else (worker source, tests, `uvRequirements.ts` deps, the `omnivoice`
provider) stays in-tree and functional for development.

## Working on it in dev

Dev mode does not use the bundled engine-src (the orchestrator falls back to the
repo path), so the worker itself still runs for development/testing:

```bash
cd workers/tts-engine-omnivoice
uv venv && uv pip install -e '.[omnivoice,dev]'
pytest                     # 18 tests
python -m vd_omnivoice --port 5199   # manual server for listening tests
```

To hear it inside the app during development, temporarily remove
`'tts-omnivoice'` from `DISABLED_PACK_IDS` (do NOT commit that) and install the
pack from Settings → Engines.

## Re-enable checklist (when quality is fixed)

1. Remove `'tts-omnivoice'` from `DISABLED_PACK_IDS` in `enginePackCatalog.ts`.
2. Re-add `workers/tts-engine-omnivoice/vd_omnivoice` to `SOURCES` in
   `scripts/package/stage-engine-src.mjs`.
3. Flip the availability expectations in
   `packages/node-orchestrator/src/engines/engines.test.ts`
   (the "OmniVoice TTS pack" test: `darwin/arm64` back to `toContain`).
4. Update this file, `docs/PROVIDERS.md`, and `docs/ENGINE_PACKS.md`.
5. Validate on real content: consistency across segments, no inaudible output,
   no language leakage, and an A/B against the HF Space on the same text.

## History (for context)

- **v0.1.0–v0.2.0** — pack shipped disabled; the first implementation used the
  MLX port, which produced audibly degraded ("terrible") output vs the HF Space.
- **Post-v0.2.0** — deep-dive found the two root causes above; worker rewritten
  on official PyTorch/MPS; both fixes validated with the real engine.
- **Current** — quality still inconsistent on real content; held out of releases
  until it clears the bar. No timeline committed.
