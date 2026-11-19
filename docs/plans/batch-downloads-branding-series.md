# Plan: batch downloads, logo & greeting, and series (splitting long videos)

Status (2026-11-19): decisions taken; Phases 0 and 1 built and tested (not yet released); Phases
2–5 to do. See [Progress](#progress) at the end. Research behind it: the 2026-11-19
analysis of `bilibili-downloader`, `ffmpeg-skill`, the mix/render/editor code, and the Mother
Claude session (peer `mother-claude-fc`, session `69ab6cca`).

The end-to-end flow this serves, Bilibili first:

1. Mother Claude (plugin `mother-claude:mc`, browser extension) browses Bilibili and collects
   video links, and the cookies when there are any.
2. Mother Claude drives VideoDubber (the `videodubber` MCP plugin): a batch of downloads, then a
   dub of each with a preset, long videos split into parts.
3. Mother Claude posts the finished videos (a Facebook Page) through the browser.

The same features work by hand in the app: several links in the Download screen, presets in New
project, logo & greeting in New project / the editor / Export, "split into parts" in New project.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Rights | The videos are published for viewers to use; non-profit. Build everything, publishing included. Each download keeps its source (uploader, link), and captions carry a credit line by default (can be turned off). |
| 2 | Greeting at the start | Only in a quiet moment of the opening, never an intro before the video. Background music under it is fine (it is lowered under the greeting). No quiet moment, no opening greeting, and the app says so. |
| 3 | Logo | Default corner and size accepted (top right, 10% of the width); the extra re-encode in the separate-subtitle modes is accepted. |
| 4 | Parts | Target 15–20 min by default; 30–40 min and 60 min offered, custom allowed. Only offered when an AI is configured in Settings; the user picks which one when several are; when Mother Claude drives the dub, Claude through Mother Claude is the default. |
| 5 | Facebook | Mother Claude posts through the browser extension, acting for the user. No Meta app, no Graph API code in VideoDubber. |
| 6 | Bilibili login | No login screen in VideoDubber. Mother Claude reads the cookies from the browser; logged in or logged out both work (logged out: up to 720p). |
| 7 | Downloads after a project is made | Not answered; default chosen: keep the download (one video can be dubbed into several languages, and a failed project can start again), but never store it twice: the project gets a **hard link** to it on the same drive (no extra space), a copy only across drives. Downloads live in `<projects root>\downloads`, move with the projects folder, and are counted and clearable in Storage. |

## Phase 0: fixes first (needed whatever comes next)

0.1 **A WAV is always read as a WAV.** ffmpeg 9.0.2's MPEG-TS probe outscores the WAV probe when
the PCM holds `0x47` at a transport packet's spacing (a steady tone can: a jingle), and the file is
then read as a broken transport stream (ffmpeg-skill #518). `runFfmpeg` / `runFfprobe` put
`-f wav` before every `-i` whose file opens with a `RIFF`/`RF64` … `WAVE` header: one place, every
call site, the pure argument builders unchanged.

0.2 **Export → Render again goes through the run.** Today it calls `renderFinalVideo` directly:
the old `final_mix.wav` ships after edits (no re-mix), the render-quality setting is ignored, and
it cannot be paused or queued. Instead: save the chosen subtitle mode, then run from `audio-mix`
when the mix is out of date, else from `render`. Out of date = a fingerprint of everything the
mix reads (each dub clip's file, trim and position, the mix settings; later the greeting plan),
written beside the mix (`audio/final_mix.inputs.json`, atomically) and compared.

0.3 **Downloads.** The merge writes `<name>.partial.mp4` and renames it only after the playback
check (a cancelled download left a truncated `.mp4`); the session cookie is not sent to the
`b23.tv` short-link service; a pasted cookie text without `SESSDATA` is refused instead of
silently clearing the saved one; the Download screen's "Open folder" opens the folder; the
plugin's `download_video` no longer claims YouTube (Bilibili and Douyin); `get_download` on a job
the app no longer knows answers that, instead of "still downloading" forever. (Folded into the
Phase 1 download core where that rewrites the same code.)

0.4 **Model downloads started by several projects at once** must not drop one language's models
(the setup installer runs one install at a time and a second request was lost).

0.5 **Long videos.**
- Temporary disk space of the dub-track build grew with the square of the length (each batch of
  clips was laid over the whole timeline): each batch is built over its own span and placed.
- A 48 kHz stereo WAV passes 4 GiB at ~6.2 h: long WAVs are written as RF64.
- Speaker detection sent the whole audio in one request with a 30-minute timeout: the timeout
  scales with the length.

## Phase 1: batch downloads and the Mother Claude hand-off

1.1 **Download queue** (`providers/download/queue.ts`), replacing the in-memory, one-link jobs:
- Records persisted (`<config>/download-queue.json`, atomic) and resumed after a restart.
- Two at a time; Bilibili API calls paced (≥1 s apart); on risk control (HTTP 412, code -352 /
  -412) back off 20 / 45 / 90 s, then fail as rate-limited with a clear message.
- Resume: partial files are kept; a resumed fetch requires `206` with the matching
  `Content-Range` start, otherwise restarts from zero. Three retries per stream; expired media
  links (403/404) are fetched again (`prepare` again); Bilibili `backupUrl` mirrors as fallback.
  Video and audio fetched in parallel.
- Free-space check before starting (size from `durl.size` or DASH `bandwidth × duration`).
- Idempotent: the same video + part + quality returns the existing item (a failed one is retried).
- Clear errors: login needed, quality limited, rate limited, region locked, not found, disk full.
- Progress events throttled (≤4/s per item) and carrying the title; a `done` event carries the
  source details (link, uploader, title, duration, cover).
- Multi-part videos (分P) expand into parts the user ticks (Mother Claude passes `parts`).

1.2 **Download screen**: a box for many links or BV ids, one per line; each resolves to a card
(title, uploader, length, parts checklist); one quality choice for the batch; "Add to queue".
The queue list: progress, cancel, retry, remove, open folder; "Dub these with a preset…" for
finished items.

1.3 **Dub presets** ("Mẫu lồng tiếng", `<config>/dub-presets.json`): languages, engines, voice,
subtitles, save folder, review before voicing, start immediately; later logo & greeting and
parts. New project: "Use a preset" and "Save as preset". The batch and the plugin use them too.

1.4 **Downloads folder and projects**: `<projects root>\downloads`; moving the projects folder
moves it and rewrites the queue's paths (`rebaseJson`); a project made from a download gets a
hard link (`fs.link`), a copy only across drives; Storage counts downloads and clears finished
ones.

1.5 **Plugin tools** (thin wrappers over new routes, same rules as the existing ones; names
agreed with Mother Claude 2026-11-19):
- `download_videos({ urls, parts?, maxHeight?, dub? })`: queue many, idempotent, returns ids.
  Every download has a `sourceKey` (`bilibili:BV…:p2`): the idempotency key and the key of
  Mother Claude's manifest.
- `list_downloads`, `cancel_download`, `retry_download`, `delete_download`.
- `wait_jobs({ downloadIds?, projectIds?, waitSeconds })`: returns when any of them moves on, with
  a one-line state of each; for short waits.
- `follow_jobs_command({ downloadIds?, projectIds? })`: the exact command for Mother Claude's
  Monitor, `curl.exe -sN "http://127.0.0.1:5100/jobs/events?…&untilDone=1"`. The route streams
  NDJSON, one line per change `{seq, at, kind, id, state, title?, progress?, error?:{code,
  retryable}}` (progress every 25% or 5 min; `since=<seq>` to resume), and closes once every named
  job is finished, so the command exits 0. Never a cookie or token in a line.
- `list_presets`, `dub_downloads({ downloadIds, presetId | settings, start })`.
- `get_outputs({ projectId })`: video and subtitle paths, size, duration, sha256, a thumbnail JPG
  made at render, a caption (translated title, part n/m, credit line) and whether it is published;
  a series lists its parts in order.
- `mark_published({ projectId, part?, url })`: recorded in the project, shown in `get_outputs`,
  `list_projects` and the app, so a rerun never posts twice even if the manifest is lost.
- `set_download_login({ provider: 'bilibili', cookiesFile })`: Mother Claude's `browser_cookies
  {action:"export"}` writes the cookies to a file in its own data folder and gives the model only
  the path. VideoDubber's MCP process reads it (64 KiB cap), deletes it in a `finally` (also when
  parsing fails), parses Netscape (including `#HttpOnly_` lines) or JSON, keeps only
  `bilibili.com` cookies and only SESSDATA and buvid3, and stores them; logged out (no SESSDATA)
  clears SESSDATA and keeps buvid3. It answers logged in or out, account name, premium, and the
  maximum quality (720P / 1080P / 1080P60-4K); no value is echoed, logged or put in an error. No
  orchestrator route reads or deletes a path. `get_download_login`: the same status, read-only.
- `delete_project` (the route exists since 0.15.0); `get_status` also says whether Claude
  through Mother Claude is reachable.
- Every request to Claude through Mother Claude carries `X-Client-Id: videodubber/<projectId>`
  (its HTTP API keeps a folder per client).
- The caption's translated title is made once, at the end of the translation step, with the
  project's translation engine (`translation/meta.json`).

## Phase 2: logo and greeting

2.1 **Brand kit** (Settings → "Logo & lời chào"): logos (PNG/JPG/WebP, kept as PNG) and greetings.
A greeting is an uploaded audio/video file (converted to 48 kHz stereo WAV, silence trimmed from
both ends, loudness matched to dubbed speech, refused over ~10 s) or text spoken by any installed
voice (the existing speak endpoint, copied out of its cache). A project keeps its own copy
(`<project>\branding\`), so editing the library never changes a finished project.

2.2 **Project settings** (`settings.branding`, all optional):
- `logo`: asset, corner (default top right), width % (10), margin % (4), opacity (0.85), when:
  the whole video | chosen periods | "show S seconds every M minutes"; 0.5 s fades.
- `greeting`: asset, `atStart` (in the first quiet moment of the opening window, default 60 s),
  repeats: off | auto | a count; gain.

2.3 **Greeting planner** (pure, `branding/greetingPlan.ts`): a quiet moment has no dub voice
(each line's played window, after trims) and no original speech (`speech_regions.json`, else the
transcript); music is allowed. 0.4 s of space each side; repeats at least 3 min apart and never
in the first or last 30 s; auto count ≈ one per 10 min, at most 6; a count is capped by what fits
and the app says so ("Chỉ tìm được 2 khoảng lặng đủ dài"). Repeats are spread: aim at evenly
spaced targets, take the fitting moment nearest each. The plan is saved
(`audio/greeting_plan.json`); placements the user moved are kept, not re-planned.

2.4 **Mix**: greetings are placed with the dub clips, so the background is lowered under them as
under speech and the loudness pass treats them alike; in the music & voice separation mode the
music is lowered under a greeting too.

2.5 **Logo render** (ffmpeg-skill's tested recipe): sizes from the probed picture; outside its
periods the logo is moved off-screen (`x='if(between(t,a,b),X,-w)'`) rather than switched with
`enable=`; colour tags kept (bt709); logo and burned subtitles in one pass; the copy-mode render
gets the real encoder settings (hardware encoder, render quality) instead of bare x264. A logo
in the separate-subtitle modes re-encodes the video (accepted, decision 3).

2.6 **Editor**: a "Thương hiệu" section in the project panel (logo and greeting controls) and a
branding track on the timeline with draggable greeting markers (the same rules as the planner,
mirrored in `timeline-math.ts` like the line rules). The preview shows the logo (CSS) and plays
greetings. A logo change makes the render stale, a greeting change the mix; Render runs from the
right step (0.2's fingerprint).

2.7 **New project and Export**: the same section (collapsed in New project, filled from the brand
kit or the preset); Export's Render again uses it.

## Phase 3: series (splitting long videos)

3.1 **When it is offered**: an AI is configured in Settings: Claude (key, or through Mother
Claude), OpenAI, Gemini, or the built-in Gemma chat model installed. A picker lists the
configured ones; default: Claude through Mother Claude when the dub comes from the plugin and it
is configured, else the last choice, else the first configured. The New project option "Chia
thành nhiều phần" offers 15–20 min (default), 30–40 min, 60 min, or a custom range.

3.2 **Analyse once** (the series project): probe, extract audio, speech-to-text of the whole video
(or, Phase 4, Bilibili's own subtitles), the speech map; scene changes measured only around the
target cut points; Bilibili chapters when there are any.

3.3 **Cut points**: candidates are pauses between lines (never inside one), ranked by length,
by a scene change within 1 s, and by chapter marks. Targets every ~17.5 min (the chosen range's
middle). The AI gets, per target, the transcript ±3 min and the candidate ids, and answers the
best candidate plus the part's title and one-line summary; answers are validated and snapped to a
candidate, and a failed or missing answer falls back to the best-ranked pause near the target.
Small windows keep it within a local model's context. The plan is shown for review (move a cut,
rename a part); Mother Claude can also send its own cut points (`set_split_plan`), validated the
same way.

3.4 **Each part is a normal project** (editor, Export, queue, pause all unchanged) linked to the
series (`seriesId`, part n of m, source range): its transcript is the series' slice (so
speech-to-text is not repeated), and it shares the series' character sheet / glossary and voice
choices, so names, forms of address and voices stay the same across parts. Parts dub in order in
the queue; the first part is ready long before the whole video would be.

3.5 **Opening and closing**: part N+1 starts 3–5 s before part N's cut (from the start of the
line in progress when that fits), shown slightly darker with a "Phần trước" label, and its dub
lines there reuse part N's translation, so the words match. A title card ("Tên video · Phần 2/7")
over the first seconds, a "Còn tiếp · Phần 3" card over the last seconds ("Hết" on the last part),
0.5 s fade in, 1 s fade out (picture and sound). Cards are drawn by libass (reliable Vietnamese
fonts on Windows, unlike `drawtext`), in the same pass as subtitles and logo.

3.6 **Render**: each part is cut from the source with an accurate seek in its single encode;
every part is levelled to the same loudness. Files: `<name> - Phần 02.<lang>.mp4` (and subtitles)
in the chosen folder.

3.7 **Home and plugin**: a series shows as one card with its parts; `create_project` takes
`series: { minMinutes, maxMinutes, ai? }`; `get_series`; `get_outputs` per part with the part's
title and summary for the caption.

## Phase 4: Bilibili extras (no login screen, decision 6)

- Collection (合集), series list, favourites and uploader-page links expand to their videos (paged,
  the user ticks), for the manual Download screen; Mother Claude already collects these itself.
- Bilibili's own subtitles (CC, or the AI-generated Chinese ones when logged in) as the source
  transcript instead of speech-to-text: a large saving on long videos; still timed by the speech
  map. Opt-in per project; confirmed against the live API first.
- Chapters (视频看点) as cut-point hints for Phase 3.

## Phase 5: Mother Claude's side (coordinated with its session; VideoDubber code is Phases 1–3)

- A skill and a `manifest.jsonl` in a dedicated folder track each video from collected to posted,
  so any session can pick the batch up again.
- Cookies: `browser_cookies {action:"export", names:["SESSDATA","buvid3"]}` (agreed, not yet
  built) writes a Netscape file into Mother Claude's own data folder, readable only by the user,
  deleted after 10 minutes; the model gets the path and the cookie names, never values; the
  approval is the same dangerous one as reading values today.
- Facebook: the Page composer through the browser extension. Files over 5 MiB go by path:
  the desktop checks the path (an approved upload folder, no links, no secrets) and the extension
  sets it on the page's file input with `DOM.setFileInputFiles` (chrome.debugger); Chrome reads
  the file itself (agreed, not yet built; Mother Claude + extension 0.1.5). One-time setup by the
  user: the extension's "Allow access to file URLs", VideoDubber's output folder in "Folders
  sessions may upload files from", facebook.com set to Act. Every upload asks for approval (the
  phone approval before each post). Captions and thumbnails from `get_outputs`; a human pace and
  a small daily volume: Facebook can restrict accounts that post like a bot.
- Following jobs: the NDJSON stream through Monitor (`follow_jobs_command`), `wait_jobs` for short
  waits; `mark_published` after each post.

## Cost and quality impact

| Feature | Steps that run again | Extra time | Quality risk and how it is handled |
|---|---|---|---|
| Greeting | audio mix, render | seconds | talks over speech: only quiet moments, padding; level mismatch: loudness-matched on import; music under it: lowered |
| Logo | render | separate-subtitle modes: a full re-encode (~2–4 min per hour with NVENC, 10–20 min on CPU); burned-in: ~0 | slight re-encode loss (CRF 20 / CQ 23); HEVC/10-bit sources become 8-bit H.264; colour tags kept; warns over the subtitle band |
| Series | none for one video; per part: extract (seconds), translation onwards | analysis once, then parts in order; total ≈ one long dub, first part much sooner | cut inside a line: never (pauses only); names/voices drifting: shared character sheet and voices; recap words matching: reused translation |
| Batch downloads | none | network-bound; two at a time | rate limits: pacing and backoff; truncated files: atomic merge and playback check |

## Testing

- Pure modules first: greeting planner, cut candidates and AI-answer validation, the queue's
  resume/backoff/dedup (fake fetch with Range), the WAV header check, the mix fingerprint, logo
  and part-render argument builders, timeline-math mirrors.
- Routes and plugin tools in `server.test.ts` / `mcp-server` tests; desktop specs; i18n parity.
- In the app on Windows: a batch of three short Bilibili videos logged out and logged in; a
  two-hour video split into parts (cut review, recap, cards); logo and greeting rendered and
  edited; Export's Render again after editor edits re-mixes.

## Progress

**Phase 0, done.** WAV inputs always read as WAV (`exec.ts`); Export's Render again is a run from
the mix or the render, decided by the mix fingerprint; concurrent model-download requests join the
running install; each chunk of the dub track covers only its own stretch (a two-hour dub needed
over 50 GiB of scratch space, now about 3 GiB), long WAVs are written as RF64, and speaker
detection's timeout grows with the audio. Checked with the real ffmpeg: the chunked dub track
equals a single mix of the same clips (rounding differences of at most 2 LSB).

**Phase 1, done.** The download queue (`providers/download/queue.ts`, `media.ts`): two at a time,
kept on disk and resumed, `206`-checked resume, mirrors, fresh links when they expire, rate
limits waited out per site (20/45/90 s), free-space check, `<name>.partial.mp4` merge, typed
errors, `sourceKey` idempotency, multi-part expansion. Downloads live in `<projects
root>\downloads`, move with the projects folder, are linked (not copied) into projects, and have
their own row in Storage. Presets (`workspace/presetStore.ts`), `POST /downloads/dub` (a batch
dub waits for its models), `GET /projects/:id/outputs`, `POST /projects/:id/published`, the
NDJSON job stream (`jobFeed.ts`) and the plugin tools agreed with Mother Claude; the Download
screen takes many links and shows the list; New project saves and applies presets.

Changed from the first draft while building:
- `download_videos` takes no `dub` option: `dub_downloads` once they are done keeps each call
  simple, and the job stream says when.
- The caption is not translated in the pipeline: `get_outputs` gives the source (title, part,
  uploader, link) and Mother Claude, a better translator than any title pass, writes it.
- Found while testing with a real Bilibili video: risk control answered HTTP 412 to every
  anonymous API call from this network, in 0.15.0 too. The client now asks Bilibili for a
  device id first (`/x/frontend/finger/spi`, as its pages do) unless the browser's `buvid3` was
  imported; two real videos then downloaded, merged and became linked projects from a preset.

**Phase 2, done (2026-11-19).** Brand kit (`branding/brandKit.ts`, `<config>/branding/`, routes `/branding*`, Settings card), project `settings.branding` (sanitized, copies in `<project>/branding/`), greeting planner (`branding/greetingPlanner.ts`) laid into the dub's track (clip gain), plan kept in `audio/greeting_plan.json` (editor edits kept until the greeting settings change), mix fingerprint covers it; logo through the new filtered render path (`media-worker/overlay.ts`: logo, part window, fades, darker recap, libass cards; checked with the real ffmpeg); New project, Export and the editor (panel + greeting times + logo over the preview); plugin `list_brand_kit` and `settings.branding`; native picker `pick_media_file`.

**Phase 3, done (2026-11-19).** `series/`: planner (pauses as candidates, part count, cut windows, fallback, recap start, part transcripts, cards), AI (`seriesAi.ts`: cut choice and titles through any refinement-capable provider's `chatComplete`, answers validated), service (parent analyses up to speech-to-text, plan, shared character sheet, parts as normal projects over `sourceRange` with pre-seeded transcript, start in order, view), recap lines reuse the previous part's translation, render range + effects, editor playback/filmstrip honour the window; routes `/series/ai-options`, `/projects/:id/series*`; New project option (AI picker, 15–20 / 30–40 / ~60 / custom), series screen, Home badges; plugin `create_project.series` (Mother Claude's Claude by default), `get_series`, `set_split_plan`, `start_series`, part details in `get_outputs`. Not done: scene-change scoring (chapters only), a thumbnail per output.

**Phase 4, done (2026-11-19).** List links: a collection (合集), series list, favourites folder or
uploader's page (`parseBilibiliList`, `fetchBilibiliList`, at most 500 videos, deleted favourites
left out) expands in `POST /downloads` and in `POST /download/expand`, where the Download screen
lets the user tick them; an uploader's page goes through the page's own search with its
fingerprint fields, else the series API's keyword search (risk control refused each of them for
one uploader, live). The player API (`/x/player/wbi/v2`) gives each download its subtitles (only
to a signed-in account: `need_login_subtitle`, checked live) and its chapters (视频看点, checked
live signed out; cut hints for the series planner). `settings.useSourceSubtitles` (New project, presets,
plugin) makes a project's transcript from them instead of speech-to-text; a series part takes only
its own stretch. Batch dubs can split the long ones (`POST /downloads/dub` `series`: only those
longer than 1.5 × the longest part; the Download screen and `dub_downloads` both offer it).

Not built: scene-change scoring for cuts (pauses and chapters only), a thumbnail per output in
`get_outputs`.

**Phase 5 (Mother Claude), done in its session.** The cookie export file, uploads over 5 MiB by
path, and the `bilibili-to-facebook` skill (D:\development\bilibili-to-facebook) over the tools
above; it ships as Mother Claude 0.16.4 with extension 0.1.5, released together with this.
The user's one-time setup is in `docs/MCP.md` (Batches).
