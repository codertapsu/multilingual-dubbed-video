# Plan: production hardening after the 10-hour series (field report, 2026-11-21)

Source: the `claude-dubber` session's report,
`D:\development\claude-dubber\reports\videodubber-feedback-2026-11-21.md` (a 10-hour Bilibili
drama, zh → vi-VN, 17 parts of 30–40 min, VieNeu-TTS 3.8 with cloned voices, burned-in subtitles,
greeting; Windows 11, RTX 3050 8 GB, 32 GB RAM; driven over MCP on 0.16.1). Reference workaround
scripts: `%TEMP%\vd-scripts` (Python). This plan was checked against the code and the logs; what
was verified is marked.

## What the report found, checked

| # | Finding | Checked | Root cause in the code |
|---|---|---|---|
| B1 | The backend died at 04:51:00 UTC with 0xC0000409 (fast-fail/abort) after ~18 h, with 2 long downloads, a llama.cpp translation and 4 VieNeu GPU fallbacks in the 12 min before | Yes: `videodubber-orchestrator.log` line 966, no stderr line before it | Nothing records why: no Node fatal-error report, no heap snapshot, no memory/lag log. The shell (`sidecar.rs` `pipe_command_events_to_log`) logs `Terminated` and does nothing else: no restart, no state for the UI, which then says "The built-in backend did not start" (`ipc.service.ts`) for every unreachable backend. The download path streams to disk (no whole-file reads found; the queue file is written on state changes, not progress) |
| B2 | Speaker detection on 10 h: one `/diarize` call, 2 h 56 min, HTTP 500, no speakers | Yes | `vd_diarize/core.py` runs one sherpa-onnx `process()` with FastClustering over the whole file (≈2.3 GB of float32 samples before clustering; O(N²) clustering). The timeout scales to ~6 h. Engine stderr after start-up is kept only as a 4 KB in-memory tail for start failures (`engineManager.ts`), so the traceback was lost. The progress shows step 3 "Transcribe" throughout |
| B3 | The series started all 17 parts without review, from a transcript with failed speakers and loops | Yes | `POST /downloads/dub` defaults `series.autoStart` to **true**, and so does `create_project`'s schema. Parts get a snapshot of the parent's settings at `createParts`; later changes never reach them; there is no re-cut. Cut windows spread ±((max−min)/2 + 1 min) around evenly spaced targets, so parts can fall outside [min, max] (43.1, 43.4, 26.0 min) |
| B4 | whisper.cpp large-v3 hallucination loops: 56 ranges, ~151 min of 10 h, plus credit-line hallucinations | Yes (no detector exists) | whisper.cpp is called with `temperature=0` and the engine's default context; nothing checks the text |
| B5 | "could not start … reinstall" when the GPU is merely busy; a voice preview's "anonymous" GPU claim never released; a render waits ~2 h | Yes | `ensureRunningFirstUsable` logs the reinstall warning for `ENGINE_BUSY` too. Work outside a run claims the heavy lane as `anonymous` and only `stopAll()` clears it. Admission (`scheduler/admit.ts`) is first-come with a points budget, and the first held run reserves its points, so a render-only run (already classified light) still waits for a slot |
| B6 | VieNeu speaks "…", "-", "♪", zero-width text as "Ơ…" or gibberish | Reported | TTS sends any non-empty text |
| B7 | MCP: no sub-step/ETA, no tools to re-detect speakers, apply settings to all parts, rebuild parts, replace a range of lines, read engine errors, see queue reasons or the GPU owner | Yes | — |

## Phases

Effort: S < 1 day, M 1–3 days, L > 3 days (with tests).

### Phase 1 — Never lose the backend silently (B1, request 4) — first

1.1 **Leave evidence (S).** At start-up the orchestrator turns on Node's diagnostic reports
(`process.report.reportOnFatalError`, `reportOnUncaughtException`, `directory = <logs>/crash`),
`v8.setHeapSnapshotNearHeapLimit(1)` into the same folder, logs the heap limit, and makes stderr
blocking so the last lines before a crash reach the log.

1.2 **Watch itself (S).** Every 60 s while any job runs: RSS, heap, external/array buffers, active
handles, event-loop delay p99 (`monitorEventLoopDelay`); a warning above 1 s of lag. The last hour
is kept for the diagnostics (Phase 7).

1.3 **Shell watchdog (M, Rust).** When the orchestrator exits while the app is not quitting: log
the code with its meaning (0xC0000409 = fast-fail/abort), write `<logs>/backend-crash.json`
{at, code, uptime}, restart it with backoff (2 s, 10 s, 60 s; stop after 3 in 10 min). The
restarted backend continues the dubs the crash interrupted (they are settled `paused` by
`reconcileQueue` today) and the downloads (already resumed).

1.4 **Say what happened (S).** A `backend_state` command (starting / running / crashed with code
and time / restarting / failed) and an event; the UI tells "never started", "crashed at 04:51
(code …, restarting)" and "not responding" apart, each with its own advice.

1.5 **Less load while dubbing (S).** Downloads: at most 1 at a time while a heavy step runs (a
setting, Phase 8); progress stays throttled.

1.6 **Reproduce (S).** A soak script: a series dub + 10 long downloads + `/health` and `/packages`
polled every 3 s, memory and lag recorded, for an hour on this Windows machine. With 1.1 in place,
the next crash leaves a report even if this one does not reproduce.

### Phase 2 — Speaker detection that scales (B2)

2.1 **Chunked detection (L).** Port the validated method (`diar_chunks.py`, `diar_link.py`,
`local_pitch.py`): 10-minute chunks with the same models and config; per local speaker a voice
print (duration-weighted mean of L2-normalised embeddings of its longest clean pieces, ≤ 45 s,
each ≤ 8 s) and its pitch; linking across chunks by average-linkage on cosine distance (0.35) with
the pitch penalty and cannot-links (same chunk, both ≥ 15 s, similarity < 0.78); prints under 3 s
join the nearest group afterwards; at most 100 speakers, the tail merged into the nearest. The
engine gets `POST /diarize-chunk` (turns + prints) and `POST /link`; the orchestrator runs the
chunks with progress ("Detecting speakers 12/60"), a checkpoint per chunk (resumable, like
translation), a timeout per chunk instead of one of ~6 h. Audio under 20 min keeps one pass.

2.2 **Gender from voice prints (M)**, not pitch (shouting men measured 300–400 Hz), for the default
voice per speaker.

2.3 **Failure is loud (S).** "Speaker detection failed: the dub uses one voice" as a project warning
(Processing, Editor, `get_project`), with **Re-detect speakers** (route + editor button + MCP
`detect_speakers`). Engine stderr goes to a log file (Phase 7.2), so the next HTTP 500 has its
traceback.

2.4 **Sub-steps (S).** The STT step reports its parts: "Transcribing 6/60", "Detecting speakers
12/60", "Checking for loops".

### Phase 3 — Transcripts without hallucination loops (B4)

3.1 **Detector (M, pure, tested).** After each STT chunk: runs of the same line at a near-constant
step (≥ 4, e.g. exactly 1.00 s), low diversity in a 60 s window (unique/total), and known
hallucination phrases (credit lines: "请不吝点赞 订阅 转发 打赏", "字幕by", "Amara.org",
"优优独播剧场"…, a list per language).

3.2 **Repair (M).** Re-decode a flagged range without context (whisper.cpp `max_context=0` if the
pinned server takes it per request, else a second instance started with `-mc 0`; faster-whisper
`condition_on_previous_text=False`), with temperature fallback; keep the re-decode when the loop is
gone, else drop the hallucinated lines and flag the range.

3.3 **Visible and editable (M).** Flagged ranges in the editor's Issues and in `get_transcript`;
MCP `replace_lines({fromMs, toMs, lines})` (today no tool can add or remove lines).

3.4 **Source corrections (S).** A "heard as → is" list in the character sheet (枪人 → 羌人),
applied to the source text before translation.

### Phase 4 — Series you can trust (B3)

4.1 **Review gate (S).** A series starts its parts by itself only when the analysis is clean: no
speaker-detection failure when detection was asked for, no unrepaired loops. Otherwise it stops at
review and says why. The MCP default stays "start by itself" (Mother Claude's skill relies on it),
gated the same way; the skill learns that a series may stop at review.

4.2 **Lengths within bounds (M).** Cuts chosen as a path through the candidate pauses that keeps
every part within [min, max] when the pauses allow (dynamic programming over candidates, the AI
choosing among the admissible ones); a part outside the bounds is explained in the plan notes.

4.3 **Rebuild parts (M).** "Rebuild parts from the series transcript" for parts not translated yet
(or whose translation the user discards): the same slicing as `partTranscript`, stale checkpoints
moved aside. Series screen + MCP `rebuild_parts`.

4.4 **Settings for all parts (S).** "Apply to all parts" on the series screen and
`update_settings({applyToParts: true})`, speaker voices included; parts made later take the
parent's current settings.

4.5 **Names in titles (S).** Part titles and summaries use the shared character sheet's names;
one retry when the AI gives no usable cut.

### Phase 5 — GPU lane, engines and the queue (B5, B6)

5.1 **Busy is not broken (S).** "The GPU is busy with ‹owner› (translating part 10): this step
runs on the CPU build" as information; "could not start … reinstall" only for a real failure,
with the engine's last output. MCP results mention a CPU fallback.

5.2 **No orphan claims (S).** Previews and other work outside a run take an owner of their own
("preview:‹voice›"), released when they end and after a timeout; a lane whose owner is no live run
or editor action is released.

5.3 **Light lane (S).** Runs that only mix and render (ffmpeg) are admitted on a small budget of
their own, never behind a reservation for a heavy run.

5.4 **Lane owner and reasons visible (S)** in the queue view and `get_status` / a new `get_queue`.

5.5 **No speech without letters (S).** Lines with no letters (punctuation, symbols, zero-width)
become silence, marked "no speech", never synthesized.

5.6 **8 GB and the 27B model (S).** Recommend TranslateGemma 12B on 8 GB (fit check); show
measured throughput and an ETA.

### Phase 6 — MCP (B7, request 2)

6.1 `get_project`: sub-step, progress, ETA from measured rates, and the warnings list.
6.2 New tools: `detect_speakers`, `rebuild_parts`, `replace_lines`, `get_queue`, `get_diagnostics`;
`update_settings` takes `applyToParts`.
6.3 Instructions: speaker ids decide the Vietnamese forms of address in translation, so speakers
must be detected before translating; the character sheet maps speaker ids to character names.
6.4 Every tool error: cause, remedy, and a log reference (correlation id, Phase 7.1).

### Phase 7 — Error tracking and diagnostics (request 3, section D)

7.1 **Structured log (M).** `logs/orchestrator.jsonl`: level, time, correlation ids (project,
run, HTTP request, MCP request via `X-Request-Id` from the plugin), size rotation (5 × 20 MB).
7.2 **Every child's output (S).** Engines' stdout/stderr to `logs/engines/‹pack›.log` (rotated),
exit codes logged; workers' tracebacks in their logs and in the error detail.
7.3 **Health view (M).** Settings → Diagnostics: uptime, lag, memory, GPU memory (nvidia-smi) and
lane owner, the queue with reasons, engines and fallbacks, recent warnings and errors.
7.4 **Support bundle (S).** "Export support bundle" (zip: log tails, crash reports, versions,
redacted settings, queue, engines, recent errors), and MCP `get_diagnostics`.
7.5 **Degradations as warnings (S).** A project's warnings (speaker detection failed → one voice;
GPU busy → CPU; loops repaired/left; parts outside bounds) persisted with the pipeline and shown.

### Phase 8 — Settings and UX (requests 1 and 5, section C)

8.1 **Settings as sections (L).** A left navigation: General (language, projects and output
folders, updates) · Dubbing defaults (languages, subtitles, mix, logo & greeting, series) ·
Engines & models (one page per function) · Voices · Downloads (logins, concurrency, while dubbing)
· Performance (GPU/CPU, concurrent dubs, heavy-lane policy) · Diagnostics · Advanced. A search box,
a one-line explanation per option, basic/advanced disclosure, reset per section.
8.2 **Engine families (M).** Cards per family with their variants (installed, size, VRAM need,
"recommended for this PC") and one active choice per function: Whisper (whisper.cpp runtime with
large-v3, large-v3-turbo; PhoWhisper; faster-whisper), TranslateGemma (4B, 12B, 27B) and chat/review
models, VieNeu (TTS 3.8, Neural v3, classic) then the other voices.
8.3 **UX pass over every screen (M).** Consistent vi/en terms, why a control is disabled, empty
states, the next step always visible (the user's request 1).

## Releases

Proposed: **0.17.0** = Phases 1, 5, 4.1–4.2, 4.4, 6.1, 6.3, 7.2, 7.5 (stability and correctness,
the fixes production needs now); **0.18.0** = Phases 2, 3, 4.3, 4.5, the rest of 6 and 7;
**0.19.0** = Phase 8. Or everything in one release, as with 0.16 (about 4–6 weeks of work at this
plan's effort estimates, so the first fixes would wait).

## Decisions for the user

1. Releases: in three steps as above (recommended: the crash and series fixes reach production
   first) or all at once.
2. A series made over MCP: start its parts by itself only when the analysis is clean (recommended)
   or always stop for review.
3. Downloads while a dub runs: 1 at a time (recommended), pause them during heavy steps, or no
   limit.
4. After a backend crash: restart and continue the interrupted dubs by itself (recommended) or
   restart and leave them paused.
5. Hallucination loops: repair automatically and flag what is left (recommended) or flag only.

## Decisions (2026-11-21) and refinements agreed with `claude-dubber`

The user agreed to every recommendation and asked for **one release (0.17.0) with all phases**.
Downloads while dubbing, by the user's rule: on a powerful machine they run in parallel with
dubbing coming first (paused during GPU-heavy steps); otherwise one task at a time. Refined with
the production data from the 10-hour run (the GPU lane was held 95 % of step time on 8 GB, and
pausing downloads frees nothing on the GPU itself):

- **Powerful** = an NVIDIA GPU with ≥ 12 GB, or Apple Silicon with ≥ 32 GB, *and* capacity ≥ 2.
  An 8 GB card is "one task at a time": no download while a dub runs, and one at a time otherwise.
- In parallel mode a download also pauses under pressure (event-loop lag p99 > 500 ms, free RAM
  < 15 %) and during disk-heavy steps (extract-audio, audio-mix, render). A resumed download
  re-resolves its signed links first, then resumes with Range.
- Settings → Downloads: Automatic (by hardware) · Pause during heavy steps · One task at a time ·
  No limit.

MCP (from the production run): `detect_speakers` starts a job (detection and assignment only,
never STT; per-line voice overrides kept; voices remapped by voice print), `get_speakers`
(minutes, lines, pitch, gender with confidence, sample lines, voice), `cast_voices` (profiles
first, by gender; profiles store gender, pitch and a voice print), default voices per gender and
a same-gender tail merge past 100 speakers, `replace_lines` (speakerId, returns new ids),
`retranscribe_range`, `rebuild_parts` (refreshes the character sheet, per-part report),
`applyToParts` with per-part results (also `set_translation_context`), pause/start of a series
parent act on all parts in order, `get_queue` (reasons, lane owner, budget, ETA),
`get_diagnostics` (disk per project, free disk, fallbacks, crashes, engine stderr),
`export_transcript` (a file path for large transcripts), warnings in `get_project`/`get_series`,
and `dub_downloads`/`create_project` echo `autoStart` and the gate.

Speaker detection: thresholds derived per file from its own distributions (fallback 0.35/0.78);
pitch only as a soft gender guard; the seed-and-grow gender rule, with "child?" left unassigned;
≤ 8 print pieces per local speaker; lines outside the strict rule get the largest overlap /
nearest turn / nearest labelled neighbour, marked low-confidence (editor Issues).

Loops: a flag needs repetition and ≥ 8 lines or ≥ 20 s (longer for ≤ 2-character phrases) and is
confirmed by a no-context re-decode (repeats again → real, kept; varied → replaced); a 1.00 s grid
with varied text is re-timed, text kept; the phrase filter also runs on the re-decode; common words
count only in music/no-speech regions or as two hits; each chunk is checked right after decoding;
over-long re-decoded lines are trimmed with the per-language speech rate.

## Testing

Each phase: unit tests for the pure parts (admission with the light lane, loop detector, cut path
within bounds, linking with cannot-links on recorded prints, warning model), orchestrator tests with
fakes, the full `pnpm check`, macOS tests in the scratch worktree. Live: the Phase 1.6 soak; chunked
detection on the real 10 h audio compared with the workaround (target ≥ 90 % of lines passing
`MIN_COVERED`/`MIN_MAJORITY`); the loop detector on the 3 videos of 2026-11-18 and the 10 h one
(the 56 ranges found, false positives counted); a settings walkthrough in both languages.
