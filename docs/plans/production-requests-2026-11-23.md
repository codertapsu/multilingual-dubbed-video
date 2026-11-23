# Plan: requests from the 27.8-hour series (claude-dubber report, 2026-11-23)

Source: the `claude-dubber` session's report,
`D:\development\claude-dubber\reports\videodubber-requests-2026-11-23.md` (example frames in
`img\`): 持械入大宋 / "Xuyên Không Về Đại Tống", five Bilibili videos (P1–P5, 1080×1920) joined by
hand into one 18.2 GB, 27.8 h source; one series of 48 parts of 30–40 min; zh → vi-VN; VieNeu
voices with the user's clones; Claude through Mother Claude for cuts and titles; driven over MCP
on 0.17.1. Three of the requests come from the user (watermark blur, a blurred band over the
source's subtitles, seeing all the work the app does); the rest are findings from the run.
Everything below was checked against the code (2026-11-23); file references are to `main` at
eb4c2ff.

## What the report found, checked

| # | Finding or request | Checked | What the code does today |
|---|---|---|---|
| F1 | Audio drifts behind the picture on sources whose audio holds more samples than its timestamps (P4: +4.81 s over 2.73 h) | Yes | `buildExtractAudioArgs` / `buildExtract16kMonoArgs` (media-worker `extract.ts`) decode every sample: no `aresample` async, no pad/trim to the video length. Everything downstream is cut from those WAVs, so the drift is baked in. Worse: the mix's `amix` uses `longest` and the normal render has no `-t`/`-shortest`, so a long `original.wav` also makes the finished video longer than its picture. No import check compares audio and video lengths (the probe keeps only the container duration) |
| F2 | `retranscribe_range` with apply wrote raw whisper output (credits, 11× and 31× loops) | Yes | `orchestrator.ts` `retranscribeRange` makes one decode and `replaceSourceLines` it: none of `loopRepair.ts` (loop/credit filter, context-free re-decode confirmation), the new lines carry **no speaker** (the range loses its speakers), `loop_ranges.json` and the loops warning are not refreshed. One synchronous request, ≤ 15 min, no progress |
| F3 | STT chunks 141–152 "heard" 20 hallucinated lines each over −91 dB silence; nothing flagged it | Yes | Chunked STT logs only the segment count per chunk. `repairLoops` has an `inSilence` hook the runner never passes. No check of text against a second decode outside loop ranges |
| F4 | `cast_voices` made the user's clone the shared default for 59 minor male speakers | Yes | `casting.ts`: `defaults[gender] = pool[0]`, and the pool lists clones first, so the shared default is always the first confirmed clone when one exists (and that voice is also a main speaker's). No rotation, no soundalike check; unknown-gender speakers are listed by id only (sample lines exist only in `get_speakers`) |
| F5 | Series naming and plan tools | Yes | Part names are fixed (`<series> - Phần 01`); after the parts exist nothing edits a part's title or name (`PUT /projects/:id` resets the pipeline and only works before the first run); `POST /series/replan` exists but is not in the MCP and overwrites edited titles; `rebuild_parts` is all-or-nothing and skips queued parts, so the agent must pause the queue; an AI title that comes back empty is kept as `''` with no note (seen on parts 42/43) |
| F6 | `detect_speakers` took 4 h 56 min on 27.8 h, ~3.6 of 16 threads busy | Yes | The orchestrator runs the 10-min parts strictly in sequence; the engine serializes every request behind one model lock, so parallel parts need several model instances (~150 MB each) |
| F7 | A sung OST ballad was transcribed and would have been dubbed as speech | Yes | No song detection and no per-line "keep the original" flag. In `keep` mix mode the only way to keep the original for a line is to delete the line; in `replace-vocals` the singing disappears everywhere |
| F8 | `create_project` failed with a timeout on the 18 GB file, while the app went on and created the project 6.5 min later | Yes | The MCP posts `/projects` with the default 60 s timeout while the app copies the whole file first; `linkInputVideo` (a hard link on the same drive, as `dub_downloads` uses) is never asked for. Requests are logged only when they end |
| R1 | User: blur, pixelate or delogo a watermark ("玄荒漫剧 bilibili", top right), detected automatically, adjustable | Yes | No blur/delogo/region filter anywhere; frame sampling exists only as thumbnails, scene changes and the filmstrip; nothing reads pixels |
| R2 | User: a **blurred** band over the source's own subtitles (here ~76–81 % of the height), detected automatically, optionally with our subtitles inside it | Yes | `coverOriginal` is a solid ASS rectangle anchored to the bottom edge, full width; UI has only a checkbox in the editor; MCP only `coverOriginal` + `position` |
| R3 | User: see everything the app works on (also what an agent started), with who started it, progress, result; transcript edit history with undo; `report_activity` for outside work | Yes | The UI follows dubs, downloads, installs, the projects-folder move and updates. Speaker detection (in-memory job), retranscribe, rebuild, replan and editor re-voicing are invisible; nothing records who started anything (the MCP sends only a per-call request id); transcript edits overwrite JSON with no history (undo exists only in the open editor) |
| R4 | Join several videos into one series with continuous part numbers | Yes | One input per project; no concat. The join done outside the app is where P3/P4 were garbled |

## Phases

Effort: S < 1 day, M 1–3 days, L > 3 days (with tests). Phase 1 is correctness and could ship
alone first (see D7).

### Phase 1 — Correctness (F1, F2, F4, F8, F5 titles, F3)

1.1 **Audio follows the picture's clock (M).** Both extractions always decode with timestamp
compensation and are cut to the video's length:
`aresample=<rate>:async=1000:first_pts=0,apad,atrim=end_sample=<videoDur×rate>` (and the same for
windows of a part). The drift is **measured from the decoded sample count** (packets × frame size ÷
rate, minus the encoder priming, or a decode when the frame size is unknown), never from the
container's stream durations: P4's audio stream claimed 9826.354 s against the video's 9826.357 s
while holding 4.8 s of extra samples. The measured value is always recorded (project info and
diagnostics); a project warning only at **0.5 s or more** ("the audio was 4.8 s longer than the
picture; it is re-timed to the picture"): P1/P2 (+0.56 s over 10 h) are at the edge, P3/P5 (+0.02
/ +0.14 s) stay quiet, since the re-timing makes them harmless. The render caps the output at the
video's length (`-t`), so a long mix can never lengthen the video. Tests: a fixture whose audio
runs long (built with `asetrate`), pinned arg builders. Existing projects keep their WAVs; a re-run
from "extract audio" fixes them. The running 48-part series is unaffected (its joined input is
already re-timed: a plain extraction equals the video within 2 ms).

1.2 **Large local files over MCP (S).** `create_project` asks the app to link the file instead of
copying it (a hard link, same drive; across drives it still copies, as `dub_downloads` does
today), waits up to 30 min when it must copy, and a timeout says the project may still appear
(with the folder to look in) instead of inviting a retry. The orchestrator logs a request still
running after 30 s ("still running: POST /projects, 30 s"), so long work is visible while it runs.

1.3 **Re-transcription with the STT step's checks (M).** `retranscribe_range` runs the decode
through `loopRepair`'s pass (loop and credit filter, context-free re-decode to confirm, ±500 ms
padding), refreshes `loop_ranges.json` and the warning, and accepts ranges over 15 min as one
**job** in 15-min windows with progress (`get_project` and the activity list show it; Phase 3).
Speakers carry over **only where a new line overlaps an old line with similar text** (character
bigram overlap ≥ 0.5); elsewhere the line stays unassigned and the result says how many, pointing
to a ranged speaker detection (6.1). Carrying them blindly would be wrong exactly when a range is
re-transcribed because the audio under it was garbled. Still refused on a translated project, but
before the decode, not after.

1.4 **Casting never spends a clone on the crowd (S/M).** The shared voices for minor speakers come
from voices not given to a main speaker, built-ins only unless the user picks a clone, rotated over
a pool per gender of `clamp(ceil(minorSpeakers / 10), 3, 6)` voices (59 minor male speakers here
→ 6, about 10 per voice; setting "Voices for minor speakers" to override). The rotation is
dialogue-aware: two minor speakers with adjacent turns get different pool voices where possible.
When spare built-ins run out (the female side here: 5 clones + 9 built-ins used, 2 left), the pool
reuses the voices of the least-heard cast speakers. Built-ins whose voiceprint is close to a
clone's (cosine above a measured threshold; e.g. built-in "Thiện Minh" vs the clone "Thiện Minh")
are left out of shared use and named in the proposal. Unknown-gender speakers are listed with
their three longest lines and total time, in `cast_voices` and in the editor's cast panel.

1.5 **Series titles never come back empty (S).** One retry when the AI's title is unusable; then a
note on the plan ("Part 42: no title from the AI, named 'Phần 42'") and the fallback title
`seriesAi.ts` already promises.

1.6 **STT self-checks (M).** Three checks, each a project warning with the time range:
- *Chunk heard no speech:* per chunk, lines against the speech map's speech time in it; many lines
  over (nearly) no speech are flagged ("STT chunk 141 heard no speech: 20 lines over silence") and
  go through the loop pass with `inSilence` wired to the speech map.
- *Digital silence:* silence below −80 dB longer than 60 s in a talk-heavy video ("probable source
  or encoding problem at 19:59:00–25:19:00"). This is what the garbled P3/P4 join left behind as
  2 h of silence, which the spot check below cannot see (an empty transcript and a silent re-decode
  agree).
- *Spot check:* 1–2 windows of 60 s per hour decoded again without context, character-bigram
  overlap with the lines; below 0.3 warns ("the transcript does not match the audio around
  21:12:00") and densifies around the failure. Windows with fewer than ~20 CJK characters on both
  sides (music, battle) are skipped. Measured on this run: aligned windows 0.83–0.97, garbled
  0.01–0.05; one window per hour would have caught the 5.3 h garbled span with ~5 failures. Cost
  ~3–5 % of STT time (a 60 s re-decode ≈ 8 s here); on by default for videos over 2 h.

### Phase 2 — Series workflow (F5)

2.1 **Part names from a template (S).** At series creation, `nameTemplate` (default the current
`{series} - Phần {n}`), with `{series}`, `{n}`, `{nn}` (zero-padded), `{total}`, `{title}`; used for
part project names and their output files. UI: one field with a live example; MCP: `series.nameTemplate`.

2.2 **Edit a part after creation (S/M).** Rename a part and edit its title/summary without
resetting its pipeline: `PATCH /projects/:id/series-part` + MCP `edit_part` + the series page.
A changed title marks the render step stale (the title card is drawn there).

2.3 **Replan tool (S).** MCP `replan_series` (the route exists); `keepTitles: true` keeps titles
the user edited in review. Only before parts exist, as today.

2.4 **Rebuild a subset, without pausing the queue (M).** `rebuild_parts({ parts: [23, 24] })`;
queued-but-not-started parts are rebuilt in place and keep their queue position; running parts
are still refused (with the reason).

### Phase 3 — One place for all the work, and an edit history (R3)

3.1 **Who asked (S).** Every request says where it comes from: the UI sends `x-vd-initiator: ui`;
the MCP server sends `mcp` plus the client's name from the MCP handshake (Claude Code, Claude
Desktop, Mother Claude) and a session id; the scheduler marks its own starts (series autoStart,
waiting-for-models retries).

3.2 **Activity log and job registry (M).** A server-side registry for every long action (speaker
detection, retranscribe jobs, rebuild, replan, re-voicing batches, series planning, downloads,
installs, dubs), persisted per project and app-wide (`activity.jsonl`, bounded), with initiator,
start/end, progress, ETA where known, result and log reference; `GET /activity` and an SSE stream.
The UI's activity list reads it (one source instead of five), and each project gets an
"Activity" tab. Speaker detection survives a restart (today it is lost).

3.3 **Transcript edit history with undo (M).** Every server-side write of a project's lines
(replace_lines, retranscribe apply, set_translations, adjust_lines, rebuild with force, the
editor's saves) records an entry: who, when, what ("Claude replaced 14 lines at 24:12:04"), and
the changed lines before/after (a diff, not a copy). Undo restores an entry's "before" when those
lines have not changed since, otherwise it explains what changed. Kept: the last 200 entries per
project.

3.4 **Connected agents (S).** The activity panel shows the MCP sessions seen in the last hour
(client, first/last call, last tools used).

3.5 **`report_activity` (S).** An MCP tool for work an agent does outside the app
(`{projectId?, title, progress?, state, detail?}`), shown like the app's own work, marked as
reported.

### Phase 4 — Picture options (R1, R2)

4.1 **Blur regions in the render (M).** `settings.blurRegions: [{x, y, w, h, startMs?, endMs?,
mode: 'blur'|'pixelate'|'delogo', strength?}]` in 0–1 coordinates; the render adds
`crop → boxblur|pixelize → overlay` (or `delogo`) per region, enabled in its time range, in the
existing filter graph (series parts get the parent's regions, offset by the part's start).

4.2 **Watermark detection without AI (M).** Sample ~100 frames spread over the video (small,
grey, corners only, through ffmpeg `rawvideo`, no image library), per pixel the temporal mean,
variance and edge persistence; threshold, largest connected box per corner, padded. A static
semi-transparent mark has persistent edges and near-zero variance while hardsubs change every
line, so the two separate cleanly. Returns boxes with a confidence and a preview frame. For a
source joined from several files (5.1) detection runs per file segment, since the mark can differ
between uploads, and each box keeps that time range. MCP `detect_watermark`; AI through Mother
Claude only when the user asks to check a box (or for a moving mark).

4.3 **Blurred band over the source's subtitles (M).** Detect the band from frames during speech
versus silence (the transcript says which): per row, text-like edge density that appears with
speech and not without; the band = that y-range plus a margin, its height taken at the **95th
percentile** so two-line hardsubs and the occasional other position are covered. `coverOriginal:
'blur' | 'solid' | false` with `band: {y, h}` (0–1) and strength; "put our subtitles inside the
band" places the dub's subtitles there. Order in the filter graph: blur regions and the band
first, then the title cards and the subtitles drawn on top. Today's solid band stays the default
for existing projects.

4.4 **Preview and adjust (M).** In the editor's project panel and the wizard's "More options": a
frame with the detected boxes and the band drawn on it, which the user can drag and resize,
mode/strength controls, and "apply to every part" for a series. Every option explained in place.

### Phase 5 — Join videos (R4)

5.1 **One project from several files (L).** New project → "Join several videos": an ordered list.
The app checks they fit together (same resolution and frame rate; otherwise it re-encodes, with
the cost shown first), then builds one source: video stream-copied when the codecs match, each
file's audio decoded with 1.1's compensation and cut to exactly its own video length, then
concatenated. The file boundaries are offered to the series planner as preferred cuts, and part
numbers run across all files. Progress as a job (Phase 3). One speaker detection over the
joined source is what gave this series one consistent cast across P1–P5.

5.2 **Continue a series later (M).** The source is "全1-12季" and P5 is season 11, so a season 12
will likely follow; re-running a whole joined project to add 2.5 h is costly. A new project can
"continue series X": same series name, `partNumberOffset` and total, and the voice table copied
from X with its speakers matched by voiceprint (unmatched speakers fall to the minor pool, 1.4).

### Phase 6 — Speed and songs (F6, F7)

6.1 **Speaker detection in parallel when the machine is idle (M).** The engine loads up to N model
pairs (N = 2–4 by free RAM and cores; ~150 MB each) with the threads split between them; the
orchestrator runs that many parts at once when no heavy step runs, one otherwise. Expected: ~4 h
56 min → ~1 h 30 min on a 16-thread CPU. Also **ranged detection**: `detect_speakers({fromMs,
toMs})` runs only the affected chunks and links their speakers to the existing global ones by
voiceprint, after a re-transcription (1.3) changed a range (a full re-run took 4 h 56 min here for
5.3 h of changed audio).

6.2 **Songs kept as songs (M/L).** A per-**line** `song` flag (not a range: in the funeral scene,
calls and dialogue were interleaved with the lyrics and stayed dubbed; 37 lyric lines removed,
~20 spoken lines kept within the same 9 minutes): TTS and alignment skip the line; the mix keeps
the original there (no ducking in `keep`; the vocal stem restored in that window in
`replace-vocals`). Subtitles for songs are a series/project option, **off by default** (the user
chose "the original song plays untouched"). The editor and MCP (`mark_song`) set it per line or on
the selected lines. Detection as a **suggestion**, never applied silently: lines in traditional
characters in a simplified-character transcript (on-screen lyrics in these uploads), lines the
loop pass kept because they repeat unchanged in a fresh decode, very slow syllable rates with long
sustained words; listed in the review with "keep the original song" as the proposed action.

## Decisions (cross-checked with claude-dubber from the running series, 2026-11-23)

- **D1 Detection without AI.** Agreed. Per file segment for joined sources, a time range per box.
- **D2 Joining.** (a) one project built from several files (5.1), **plus** the light "continue a
  series" path (5.2) for a later season.
- **D3 History storage.** Diffs, last 200 entries per project, one entry per retranscribe window
  (a window changed ~300 lines here; 9,400 in all). Undo restores `speakerId` too.
- **D4 Minor voices.** Pool of `clamp(ceil(minor/10), 3, 6)` per gender (3 was too few: ~20
  speakers per voice here), dialogue-aware rotation, reuse of the least-heard cast voices when
  built-ins run out.
- **D5 Songs.** Per line, original kept; subtitles for songs an option, off by default.
- **D6 The subtitle band.** Agreed; blur first, then title cards and subtitles on top; band height
  at the 95th percentile.
- **D7 Releases.** 0.17.2 = Phase 1. Then **0.17.3 = the picture options the user wants for THIS
  series** (4.1 blur regions, 4.2 watermark detection, 4.3 the blurred band, a light 4.4 preview),
  so the remaining parts can use them and the finished ones need only a render-only redo (light
  lane, ~3–7 min each). 0.18.0 = Phases 2, 3 and the full 4.4; 0.19.0 = Phases 5–6.

## Constraints from the running production (48 parts queued, ~3 days left on 2026-11-23)

- **Never touch the shared app while developing on this PC:** no restart or kill of the installed
  orchestrator or its engines, no GPU-heavy tests while the series holds the lane. Tests run on a
  scratch backend without engines (ports 5191–5199), as in `ui-browser-checks`.
- **Backward compatible formats:** the 48 parts were renamed with `PUT /projects/:id` and carry
  `speakerVoices` with 100 entries; `project.json`, the series plan and part metadata must keep
  reading as they are.
- **Installing mid-run** (any release): pause the series, install (the installer refuses while a
  dub runs or is queued, and closes every orchestrator, MCP connections included), reconnect, start
  the series. The interrupted part restarts its current step; checkpoints keep translation batches
  and voice clips. 1.1 changes nothing for this series (its input is already re-timed).

## Order of work

Phase 1 (0.17.2), then 4.1–4.3 with a light 4.4 (0.17.3), then 3.1–3.2 (the registry the later
jobs report into), then 2, the rest of 4.4, 3.3–3.5, 5, 6. Each phase: tests first where the
behaviour is pure (arg builders, detection on synthetic frames, casting pools, title fallback,
diffs and undo), then the Windows and macOS suites, then a scratch-backend UI check.
