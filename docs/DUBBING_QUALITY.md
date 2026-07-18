# Dubbing quality: natural tone + context-aware translation

Status: **Phase A + B1 + B2 implemented** (2026-07). This doc records the
diagnosis, what shipped, how to tune/disable it, and the remaining roadmap.

## The problem

Two user-visible defects, one root cause — every stage operated on isolated
Whisper cues:

1. **Robotic overall tone.** Each subtitle cue was synthesized as an
   independent TTS call, so the voice re-sampled its intonation at every cue:
   a sentence-final pitch fall every ~2 seconds, uncorrelated pace/energy
   across cues, hard silence between clips, and `atempo` artifacts on
   time-stretched lines.
2. **Wrong Vietnamese pronouns.** Cues were translated with no surrounding
   context, so xưng hô (thầy/cô, anh/chị, em, bạn, con…) defaulted to generic
   forms and flip-flopped between lines. A single cue cannot determine who is
   speaking to whom.

## What shipped

### A. Prosody / audio cohesion

| Change | Where | Notes |
|---|---|---|
| **Synthesis grouping** — consecutive same-speaker cues with < 750 ms gaps are merged (≤ 4 cues, ≤ 320 chars, ≤ 20 s) and synthesized as ONE utterance, placed at the group start. Intonation now only resets at real pauses/speaker changes. | `packages/node-orchestrator/src/pipeline/grouping.ts`, runner `stepTts`/`stepAlignment` | Plan persisted to `audio/synthesis_groups.json` (group id = first member id → same WAV paths). Editing one line in the editor **degroups** its group (each member re-synthesized individually). Setting `synthesisGrouping: false` restores cue-by-cue synthesis; env tunables `VD_TTS_GROUP_GAP_MS`, `VD_TTS_GROUP_MAX_SEGMENTS`, `VD_TTS_GROUP_MAX_CHARS`, `VD_TTS_GROUP_MAX_WINDOW_MS`. |
| **Native-rate refit** — lines needing > 1.05× compression are re-synthesized AT the required speaking rate on engines with native rate control (Piper `length_scale`, OpenAI `speed`) instead of being time-stretched. | runner `nativeRateResynthesis`, `TtsProvider.supportsSpeedControl` | VieNeu ignores `speed` by design → skipped there (its fits still use the stretcher). |
| **Rubber Band time-stretch** — residual stretches use ffmpeg's `rubberband` filter (formant-preserving) when the ffmpeg build has librubberband, or a standalone `rubberband` CLI (R3 `--fine --formant`) on PATH / `RUBBERBAND_PATH`; `atempo` remains the fallback. `auto` switches to Rubber Band beyond ±10%. | `workers/media-worker/src/stretch.ts`, `tts-timeline.ts` | Wired to the existing `timeStretchEngine` setting (`auto` default \| `rubberband` \| `ffmpeg-atempo`). Capabilities probed once per process. Rubber Band is GPL → subprocess/filter only, never linked. |
| **Join smoothing** — 12/18 ms micro-fades at every clip head/tail kill clicks and DC steps at boundaries. | `tts-timeline.ts` `buildFadeChain` | Skipped on clips < 80 ms. |
| **Room tone** — when the original soundtrack is removed, a pink-noise bed at ≈ −55 dBFS runs under the dub so pauses are never digital black. | `workers/media-worker/src/mix.ts` | Only in `originalAudioMode: 'remove'`; disable with `roomTone: false`. |
| **Language-aware length budgets** — translation prompts now budget in target-language units: Vietnamese **syllables** (whitespace-countable — vi is the ideal case), Chinese/Japanese **characters**, otherwise words. | `llmTranslationProvider.ts` `speechBudget` | Feeds both the batch prompt and the raw TranslateGemma "fit" sentence, and therefore also the auto-fit shrink loop. |

### B. Context-aware translation (LLM paths)

Applies to cloud LLMs (OpenAI/Gemini/Anthropic) and local chat models
(Ollama / llama.cpp `chat-json-batch`). **Not** to Argos/LibreTranslate (no
prompt), and **not** to TranslateGemma's `raw-segment` path — its trained
template accepts exactly one source text and treats anything else as text to
translate (officially confirmed: no system prompts, no glossaries, ~2K input).

- **Transcript analysis pass** (1 extra request per project, ≥ 8 segments):
  builds a "character sheet" — synopsis, cast, glossary, and a target-language
  **pronoun/address plan**. For Vietnamese it explicitly infers relationships
  and fixes the xưng hô per speaker pair ("học sinh → giáo viên: gọi 'thầy',
  xưng 'em'"), with instructions never to default to bạn/tôi when a
  relationship is inferable.
- **Scene-aware batching**: batches never span a ≥ 6 s silence, so consistency
  instructions apply to lines that belong together.
- **Rolling context**: each batch prompt carries the analysis block + the last
  5 already-translated pairs from the previous batch (+ a scene-change note
  when applicable).
- Strict-JSON output shape is unchanged (`{"segments":[{id,text}]}`), so
  parsing/fallback behavior is identical; an analysis failure silently degrades
  to context-free translation.
- Kill switch: `VD_TRANSLATION_CONTEXT=off`.

Module: `packages/node-orchestrator/src/providers/translation/translationContext.ts`.

### B2. The character sheet ("Cast & translation context") + offline tiers

- **Persistent, user-editable character sheet** (`TranslationDocContext`):
  the first context-aware translation run persists the generated analysis to
  `subtitles/translation_context.json`; every later translation (full runs,
  auto-fit, per-line "tighten to fit") passes it back verbatim, so it is
  authoritative. The editor shows a **Cast & translation context** card
  (synopsis, pronoun/address plan, cast, glossary) with **Save** and
  **Save & re-translate** — fix "gọi 'thầy', xưng 'em'" once, apply it to the
  whole video. API: `GET/PUT /projects/:id/translation-context`.
- **Fully-offline context-aware tiers** (both need a llama.cpp runtime pack +
  a `chat-gemma3-4b`/`-12b` model pack — Gemma 3 INSTRUCT, ungated ggml-org
  GGUFs, sha256-pinned; TranslateGemma structurally can't follow the sheet):
  - `llama-cpp-chat` — Gemma 3 chat translates scene batches with the sheet.
  - `argos-llm-repair` — **Argos drafts instantly, Gemma 3 repairs** pronouns/
    terminology/cohesion with document context (the research-backed best
    pronoun quality per compute; drafts are kept wherever the repair reply is
    missing/malformed).
  The shared llama.cpp runtime restarts automatically when a provider needs a
  different GGUF (engineManager keys running servers by model now).
- **Per-speaker voices wired**: synthesis groups carry `speakerId`; the TTS
  step partitions units by `settings.speakerVoices` assignment (falling back
  to the project voice), and single-segment regeneration + native-rate/refit
  re-synthesis honor the same mapping. Live as soon as segments carry
  speaker ids (diarization pack, or an STT provider that diarizes).

### B3. Robustness against weak-model output (post-mortem fixes)

A real zh→vi run with `llama-cpp-chat` (Gemma 3 4B) exposed how small local
models violate the batch contract: **169/795 lines came back untranslated**
(skipped lines / whole batches → the silent per-line source-text fallback),
plus trailing bracketed duplicates ("X. [X.]"), budget-hint echoes
("… (4 syllables)"), and raw hanzi names in Vietnamese lines. Fixes:

- **Reply sanitizer** (`sanitizeTranslatedLine`, applied on every parse path):
  strips seg-id echoes, whole-line quote wrappers, trailing bracket/paren
  duplicates of the line, and trailing budget-hint echoes — while preserving
  legitimate brackets.
- **Recovery ladder** (`recoverBatch`): unresolved lines (missing, empty, or
  the source echoed back) get ONE emphatic batch retry over just those lines,
  then — on local transports — per-line RAW prompts (a bare instruction with a
  plain-text reply: no JSON contract left to violate). Cloud paths use the
  retry rung only (their JSON mode is pinned and compliance is strong).
- **Prompt hardening**: explicit "every line must be rendered in the target
  language — transliterate names (Chinese → Sino-Vietnamese)" and "never copy
  the bracketed timing hints/ids into the output" rules; the analysis pass now
  demands target-language name renderings in the cast + glossary (spoken dubs
  can't pronounce source-script characters).
- **Repair guard**: an `argos-llm-repair` "repair" that merely echoes the
  SOURCE keeps the Argos draft instead.
- **Visibility**: the translation step now WARNS with counts + example ids
  when lines look untranslated (translation identical to the source across
  different languages), and the editor flags each such row with an
  **"Untranslated?"** badge.

### B4. Voice-subtitle sync + voice consistency (post-mortem fixes)

A real zh→vi run with VieNeu v3 exposed two issues:

- **Voice drifted from the subtitles inside merged groups** (192/520 grouped
  cues had the voice leading its subtitle by >400 ms; worst −10 s): a group is
  read as ONE continuous utterance from the group start, so when the
  translated pace deviates from the original cue spacing, mid-group words play
  before/after their cues. Fixes: tighter planning caps (window 20 s → 12 s,
  chars 320 → 240 — also keeps every group inside VieNeu's 256-char internal
  chunk limit), plus a **post-synthesis drift guard**: with real durations
  known, `estimateGroupDriftMs` bounds each multi-cue group's worst
  voice-vs-subtitle drift and groups exceeding `VD_TTS_GROUP_MAX_DRIFT_MS`
  (default 700 ms) are **degrouped and re-synthesized cue-by-cue**. Replayed
  on the failing project: 90 groups degroup, 131 keep the prosody win with
  residual drift ≤ 700 ms.
- **The voice audibly changed between lines** ("two different speakers"):
  VieNeu v3 samples its speech tokens at temperature 0.8 via the GLOBAL
  unseeded numpy RNG (`np.random.choice`, no seed parameter) — every utterance
  re-rolls the delivery. `vd_tts_engine` now **pins all RNGs to a per-voice
  seed before every synthesis call** (same voice → same sampling stream), the
  OmniVoice trick. Additionally, **auto-fit now also shortens lines that only
  fit with a heavy stretch** (> 1.25×, targeting ≤ 1.15×) instead of just
  timing-conflicts — pace whiplash between a 1.5× line and natural-rate
  neighbours was the other half of the "different speaker" impression.

### B5. Optional "Review & refine" pipeline step + voice-synced subtitles

- **`refine` step** (between Translate and TTS, 9-step pipeline now): when
  `settings.refineProviderId` names a context-capable LLM (cloud
  OpenAI/Anthropic/Gemini, or the local Gemma 3 chat model), the whole
  translated transcript is re-read with the character sheet + scene context
  and each line is polished — pronouns/terms of address, terminology,
  naturalness — returning lines unchanged when already good. Unset = the step
  completes instantly. Most valuable when Translation runs on a context-free
  engine (Argos, TranslateGemma). Output: updated `translated.json` + sidecars
  and `subtitles/refine_report.json` (reviewed/changed counts; also the
  step's resume marker). The shared review core (`refinement.ts`) also powers
  `argos-llm-repair`. Older projects' `pipeline.json` files are normalized on
  load (missing steps inserted as pending).
- **Voice-synced subtitles** (`syncSubtitlesToVoice`, default on): after
  alignment, cues inside merged synthesis groups are re-timed in the SRT/VTT
  sidecars (and thus burned-in subs) to when the dub voice actually speaks
  them — the canonical segment timings in `translated.json` are untouched, so
  the editor and re-runs are unaffected. Fixes the residual "voice slightly
  before the subtitle" cases the drift cap tolerates. Retimed cues are
  clamped in one timeline-ordered pass so none overlaps the next (within OR
  across groups, even when alignment accepted overflow), and the overrides are
  persisted to `subtitles/cue_timing.json` so an editor edit / per-segment
  refit reapplies them instead of reverting the whole track to source timing
  (degrouping a group clears its members' overrides).

### B6. Transcript-review checkpoint (new projects)

`settings.reviewBeforeSynthesis` (wizard checkbox, default off): the pipeline
pauses right after the transcript is translated (and refined, when configured)
— before ANY voice is synthesized. The processing screen shows a "Transcript
ready for review" card and the editor a "Reviewing before synthesis" banner:
the user reviews/edits the segments (and the cast & pronoun sheet), then
**Continue dubbing** resumes at the TTS step (unsaved edits are saved first).
A plain "Run" on the paused project also continues; a retry from Translation
re-runs the text steps and pauses again. State: `PipelineState.awaitingReview`
(persisted; cleared when the next run starts).

### Behavioral notes

- `translated.aligned.json` now contains one entry per **synthesis unit**
  (group), keyed by the first member's segment id. Cues merged into a group
  show alignment status on their first line in the editor.
- TTS resumability checks group WAVs when `synthesis_groups.json` exists and
  falls back to the legacy per-segment check for older projects.
- Auto-fit re-translates a conflicted group's members with proportionally
  shrunk budgets, rebuilds the group text, and re-synthesizes the unit.

## Research basis (condensed)

- Multi-sentence synthesis units measurably beat sentence-by-sentence prosody
  (Amazon, [arXiv 2206.14643](https://arxiv.org/pdf/2206.14643)).
- Speech stretch quality: Rubber Band > SoundTouch > `atempo`; keep within
  ~0.9–1.15× before artifacts.
- Structured context (cast/pronoun map + a ~5-pair rolling window) fixes
  discourse errors; raw neighboring lines alone are largely ignored by models
  (Karpinska & Iyyer 2023; Koneru et al. NAACL 2024 — best published pronoun
  scores use a draft + context-aware repair; DelTA, ICLR 2025 — proper-noun
  memory). Scene chunking beats whole-document (line drops/desync).
- Vietnamese is syllable-timed and whitespace-syllabified → exact isometric
  budgets ([IWSLT isometric MT](https://arxiv.org/pdf/2112.08548) line of work).

## Follow-up roadmap (researched, not yet implemented)

1. **Diarization engine pack** → real `speakerId`s: pyannote
   `speaker-diarization-community-1` (CC-BY-4.0) or 3.1 (MIT) in the
   `vd_whisperx` stub; senko (MIT) as the fast Apple-Silicon path. The
   consumer side is READY: per-speaker voices and the speaker-pair pronoun
   map light up as soon as segments carry speaker ids. (Deliberately not
   built blind — heavy ML packs get built + validated on real hardware, not
   shipped as stubs.)
2. **Engines**: track VieNeu v3-Turbo to stable (Apache-2.0; the only
   commercially-clean neural Vietnamese cloning today) + per-speaker reference
   cloning + prompt chaining behind a "cohesion" toggle; Kokoro-82M ONNX
   (Apache) as the above-Piper tier for its 8 languages; verify Chatterbox
   Multilingual v3's Vietnamese claim (MIT). Avoid: XTTS/viXTTS (CPML,
   orphaned), F5-TTS vi finetunes / Fish / SeamlessExpressive (all NC).
3. **Prosody transfer** from source audio (emotion/energy classifier → engine
   style controls) once an engine with style controls ships.
4. **Speaker-voice assignment UI** (a per-speaker voice picker in the editor)
   once diarization produces speakers to assign.
