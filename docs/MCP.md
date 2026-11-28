# Controlling VideoDubber from Claude (MCP)

VideoDubber includes an [MCP](https://modelcontextprotocol.io) server, so Claude Desktop, Claude
Code, or a Claude Code session started in Mother Claude can run the whole dubbing process for you:
check what this computer can do, download a video, create a project, start and watch the dub, read
and rewrite the translation, re-time or re-voice lines, and render the final video.

The app walks you through it: **Settings → Claude → Step-by-step guide** (also under **Help**, and
offered once on the home screen) shows each client's status, connects it with one click, and lists
what to ask.

The server runs **on your computer** and talks only to the VideoDubber app on `127.0.0.1`. The
dubbing itself still happens locally with the engines you chose; Claude sees what its tools return
(the transcript, translations, settings and progress) as part of your conversation with it.

## Connect Claude Desktop

1. Open VideoDubber → **Settings → Claude**.
2. Click **Connect Claude Desktop**. VideoDubber adds a `videodubber` entry to Claude Desktop's
   `claude_desktop_config.json` (other entries are kept; the previous file is saved next to it as
   `claude_desktop_config.json.videodubber-backup`).
3. Quit Claude Desktop completely and open it again: it reads its configuration only at start.

Windows note: the Microsoft Store build of Claude Desktop reads its configuration from
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, not `%APPDATA%\Claude\`. The
Settings button finds the right one; if you edit the file by hand, use the path Claude Desktop
opens from **Settings → Developer → Edit Config**.

**Disconnect** in the same place removes only the `videodubber` entry.

## Connect Claude Code

1. Open VideoDubber → **Settings → Claude**.
2. In the **Claude Code** row, click **Connect**. VideoDubber runs Claude Code's own command for
   you, at user scope, so every folder and every session sees it:
   `claude mcp add --scope user videodubber -- <VideoDubber's server> --mcp`.
3. Start a **new** Claude Code session: a session that was already open does not get the tools
   until it is restarted.

The row shows the state Claude Code is in, read from its `.claude.json` (VideoDubber never edits
Claude Code's files itself; every change goes through the `claude` CLI):

| Status | What it means | The button |
|---|---|---|
| Connected | `videodubber` starts this copy of VideoDubber. | Disconnect (`claude mcp remove videodubber -s user`) |
| Not connected | No `videodubber` entry. | Connect |
| Points to another copy of VideoDubber | The entry starts a different copy: after a reinstall or a move, or a source checkout. The row shows its path. | Reconnect (remove, then add) |
| Couldn't read Claude Code's settings | `.claude.json` exists but could not be read or parsed. | Reconnect |
| Claude Code not found | No `claude` CLI on PATH or where its installers put it. | Install Claude Code; the command to run by hand is shown |

VideoDubber looks for the CLI on PATH first, then in `%USERPROFILE%\.local\bin\claude.exe`
(the native installer) and `%APPDATA%\npm\claude.cmd` on Windows, and in `~/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin` on macOS, where an app started from Finder gets only a
minimal PATH. It reads `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, else
`~/.claude.json`.

To do it by hand, the row's **Or run it yourself in a terminal** shows the exact command for this
installation, with a **Copy** button. It looks like this:

```bash
# Installed app (Windows: installed per user)
claude mcp add --scope user videodubber -- "C:\Users\<you>\AppData\Local\VideoDubber\videodubber-orchestrator.exe" --mcp

# Installed app (macOS)
claude mcp add --scope user videodubber -- /Applications/VideoDubber.app/Contents/MacOS/videodubber-orchestrator --mcp

# Source checkout (after pnpm build)
claude mcp add --scope user videodubber -- node /path/to/repo/packages/mcp-server/dist/cli.js
```

`claude mcp get videodubber` shows the entry and whether Claude Code can start it.

## Use it with Mother Claude

[Mother Claude](https://github.com/codertapsu/mother-claude/releases) is a desktop app for Windows
and macOS that starts and drives Claude Code sessions, from its window or from a paired phone. Its
sessions read Claude Code's user settings, so **connecting Claude Code above is the whole setup**:
every new Mother Claude session, in any folder, has VideoDubber's tools.

1. Install Mother Claude and open it. The guide in VideoDubber shows whether it is running.
2. In VideoDubber, **Settings → Claude → Claude Code → Connect** (once).
3. In Mother Claude, click **New session**, pick any folder, and start it.
4. Ask, for example *"Dub C:\…\video.mp4 from Chinese into Vietnamese"*, *"How is my project
   doing?"*, *"Show me the lines that need attention and fix them"*, *"Re-voice line 12 and
   render"*.
5. Approve the cards. Every VideoDubber tool call shows one, on the desktop and on a paired phone.
   **Allow for…** on a card remembers that one tool for the session, the project folder or the
   whole computer. Allowing every VideoDubber tool at once is Claude Code's own allow rule
   `mcp__videodubber`: that is your choice, and it also lets engine downloads start without
   asking.

Good to know:

- Only sessions started after connecting get the tools; restart one that was already open.
- From a phone, a new session can only be started in a folder Claude Code has already worked in.
- Several Claude accounts: an account that shares the default Claude Code folder sees the
  connection; an account with its own folder (`CLAUDE_CONFIG_DIR`) needs its own connection.
- In Claude Code (and so in Mother Claude) the tools are `mcp__videodubber__<tool>`, and the two
  prompts below are the slash commands `/mcp__videodubber__dub_video` and
  `/mcp__videodubber__improve_translation`.

### Batches: from Bilibili to a post

With Mother Claude driving (a session, or a skill written for this chain), the whole chain runs
from one conversation:

1. Mother Claude collects the video links in your browser (a whole collection, series list,
   favourites folder or uploader's page is one link) and, optionally, exports the Bilibili
   cookies to a file: `set_download_login` reads that file (logged out works too, up to 720p).
2. `download_videos` queues them; `follow_jobs_command` gives the command its Monitor watches.
3. `dub_downloads` with a preset makes and starts the projects. With `series`, the long ones are
   dubbed as parts (by default those over 30 minutes, in parts of 15–20 minutes), and
   `get_series` lists each one's parts in order. The same command follows them all.
4. `get_outputs` gives each finished video and its source for the caption (for a part, which
   part of how many). Mother Claude posts it to Facebook in your browser, as you, and
   `mark_published` records the post so it is never posted twice.

The skill posts one video at a time, at least 10 minutes apart and at most 5 a day, and stops at
the first warning Facebook shows.

**One-time setup** (Mother Claude 0.16.4 or later, with its browser extension 0.1.5 or later):

1. Update Mother Claude: **Settings → Software updates → Check for updates**. Then the browser
   extension: download `mother-claude-chrome-0.1.5.zip` (or newer) from
   [Mother Claude's releases](https://github.com/codertapsu/mother-claude/releases), unzip it into
   the extension's folder (replacing the old files), and press the reload button on the extension
   in `chrome://extensions`.
2. In the extension, grant it **Debugger** access, and under **Details** turn on **Allow access to
   file URLs**: an upload over 5 MB reads the video straight from your disk.
3. In Mother Claude's **Browser** settings, set `bilibili.com` to **Read** and `facebook.com` to
   **Act** (and `business.facebook.com` too, to post as a Page).
4. Add VideoDubber's projects folder, or the save folder of the preset you dub with, to Mother
   Claude's upload folders.
5. For Claude to choose the cuts of a series through your Claude plan: start Mother Claude's HTTP
   API, and in VideoDubber choose **My Claude plan, through Mother Claude** under Settings →
   Cloud API keys. (Any other AI set up in Settings works too.)

## The app must be running — or startable

Every tool first checks that VideoDubber answers. If it does not, the server starts the installed
app and waits up to two minutes for it. In a source checkout it cannot start the stack for you:
run `pnpm dev` (or `pnpm app`) first. To use a non-default address, pass `--url
http://127.0.0.1:5100` or set `VIDEODUBBER_URL`.

## Tools

| Tool | What it does |
|---|---|
| `get_status` | App version, CPU/RAM/GPU, which local services are up, installed and recommended engines, the queue. Call it first. |
| `list_languages`, `list_providers`, `list_voices`, `list_engines` | What can be chosen, per step and per language, and what each engine pack costs to install. |
| `install_voice` | Download a voice from `list_voices` (and its engine, when it is not installed yet). |
| `install_engine` | Install an engine pack (reports download progress). Claude is asked to tell you the size first. |
| `download_video`, `get_download` | Fetch one video from a Bilibili or Douyin link and follow the download. |
| `download_videos`, `list_downloads`, `cancel_download`, `retry_download`, `delete_download` | Queue many links at once (two download at a time, kept across restarts, a rate-limited site waited out); a video already queued is returned, not downloaded twice (its `sourceKey`, e.g. `bilibili:BV…:p2`). A Bilibili collection, series list, favourites folder or uploader's page link queues its videos. `parts: "all"` queues every part of a multi-part video; `pages: [3, 4, 5]` only those parts of each link (a part the video does not have fails that download, naming how many it has). |
| `set_download_login`, `get_download_login` | Sign in to Bilibili with the browser's cookies: pass the **path** of a cookie export (Mother Claude's `browser_cookies` export); the file is read and deleted, only `SESSDATA` and `buvid3` are kept, and no value is ever shown. Answers the account and the best quality available. |
| `list_presets`, `dub_downloads` | Make a project per finished download from a preset (or languages + settings) and start them; one waiting for its models starts when they arrive. `series` dubs the long ones as parts (needs an AI set up in Settings; only videos longer than `longerThanMinutes`, by default 1.5 × the longest part); `series.nameTemplate` names the parts (as in `create_project`). A preset may carry its own series block (used when the call gives none) and a save folder with `{series}` (the project's name as a folder name: `D:\Dubs\{series}`); `list_presets` shows both, and the three built-in presets every computer has (`builtin:quality`, `builtin:balanced`, `builtin:economy`, from `GET /presets/builtin`): worked out from this computer's own engines, never a cloud AI (a saved cloud choice is left to the user to pick, and said), with their trade-offs; they work for any language, so a call names `targetLanguage` and `sourceLanguage` with them. Presets are changed over HTTP with `PUT /presets/:id` (`series`: `minMinutes`, `maxMinutes`, `ai`, `recapSec`, `autoStart`, `nameTemplate`, `longerThanMinutes`). |
| `list_brand_kit` | The logos and spoken greetings made in Settings → Logo & greeting, by id, for a project's `settings.branding` (`{ logo: { assetId, corner, … }, greeting: { assetId, atStart, repeat } }`). |
| `get_series`, `set_split_plan`, `start_series` | A long video dubbed in parts: where the series stands, its cuts with titles and summaries, and each part's project and progress (a part whose lines are its own speech-to-text is named TRANSCRIBED ITSELF: `rebuild_parts` gives it the series' lines back), with the ids of its lines to look at (still failing the translation checks, or voiced running into the next line by more than 0.3 s); change the cuts or titles before the parts are made (`create_project` with `series.autoStart: false`); make the parts and queue them in order. Even with `autoStart` a series starts its parts by itself only when its analysis is clean (speakers detected when asked for, no transcription loops left); otherwise it stops at review and `get_series` says why. Every part stays within the min–max length when the pauses allow, and the plan notes say why one does not. |
| `rebuild_parts` | After the series transcript was fixed: make the parts' transcripts again from it, with the series' character sheet: all of them, or `parts: [23, 24]`. A part that transcribed itself (a speaker detection of its own, with part-local ids) gets the series' lines and speakers back: its own detection is set aside and its genders are the series' again. A part waiting in the queue is rebuilt where it waits and keeps its place (nothing needs pausing); a part being dubbed is left alone and the answer says why. Parts already translated are kept unless `force` (then the part continues at the translation on its next run). Reports old and new line counts and speakers per part; each rebuild is in the part's edit history. |
| `edit_part`, `replan_series` | `edit_part` renames a made part (its project, and its files in a chosen folder), or changes its title or summary, without redoing its dub; a finished part with a new title is rendered again (only the render, on the next `start_series`). `replan_series` plans a series again before its parts are made; `keepTitles` keeps the titles written in review on the parts covering the same stretch of video, and `perFile` (a series joined from several files) plans one part per file, cut where each file begins, or (`false`) parts by length again. |
| `wait_jobs`, `follow_jobs_command` | Follow downloads and dubs: a wait of up to 50 s, or a command (`curl.exe -sN …/jobs/events?…&untilDone=1`) that prints one JSON line per change and exits when all of them have stopped, for long batches. |
| `get_outputs`, `mark_published` | A finished dub's files (with size and sha256, and a thumbnail JPG with no subtitle on it), length and source (title, uploader, link) for a post's caption, and where it was posted; record a post so it is never posted twice. |
| `delete_project` | Delete a project (asks you first). |
| `list_projects`, `get_project` | Projects, and one project's progress, step by step (with the sub-step, e.g. *Detecting speakers 3/12*, and an estimate of the time left), the run's **warnings** (speaker detection failed, transcription loops repaired or left, lines left without a speaker, a step that ran on the CPU because the GPU was busy, lines with nothing to say, lines still failing the translation checks before voicing, lines that cannot fit even at the fastest speed, subtitles of the video itself with no line under them or lines with no subtitle, the video's subtitles asked for as the transcript but not readable), the **jobs** working on it outside the dub (speaker detection, a long re-transcription…, with progress, time left and who started them; one the app was closed during shows as interrupted) and the end of its log. Its **lines to look at**: every line still failing the translation checks, with what the checks found, and every voice running into the next line by more than 0.3 s (the warnings name five); a line the user keeps as it is is locked in the editor and leaves the list, and `list_projects` counts them per project. `waitSeconds` (up to 50) waits for progress. |
| `dismiss_warnings` | Set a project's warnings aside (`codes`, e.g. `["stt-no-speech", "transcript-mismatch"]`, or all of them) once you have dealt with them; `get_project` lists what was set aside. A warning about a stretch of the transcript also clears by itself when `replace_lines` or a re-transcription rewrites most of that stretch, and the warnings about lines (flagged translations, subtitles without a line) follow the lines as they are fixed. A step that runs again and finds the same raises it again. |
| `create_project` | Create a project from a video file, starting from the same automatic settings the New Project wizard uses (the best engines installed here), with any overrides. The file is hard-linked into the project when it is on the projects' drive (copied otherwise), and the tool waits up to 30 minutes for a copy; if that runs out it says the project may still appear (look with `list_projects`) rather than inviting a second copy. `saveTo` chooses the folder for the finished video (`{series}` in it becomes the project's name). `presetId` starts from one of the user's presets instead of the automatic settings: its languages, engines, voices, subtitles and save folder, and for a video longer than its series block allows, a series of parts with its choices; anything given in the call is laid over it. Can start the dub at once. `series` dubs it as parts (15–20 minutes by default): `series.nameTemplate` names them (`{series}`, `{n}`, `{nn}`, `{total}`, `{title}`), `series.continues` makes a later season of a series (its name, numbering and settings carry on, its voices go to the speakers who sound like its speakers); `settings.useSourceSubtitles` uses the subtitles the site published instead of speech-to-text (Bilibili gives them only to a signed-in account: `set_download_login` first); `settings.useBurnedInSubtitles` takes the transcript from the subtitles burned into the picture, read as text on this computer (needs `install_engine ocr-rapid`, ~250 MB; Chinese and English subtitles): each subtitle becomes a line, timed by when it shows, and when they cannot be read the speech is transcribed and a warning says why; `settings.subtitleCoverageCheck` (on by default for Chinese, Japanese and Korean video) reads when the video's own subtitles are on screen, so lines under one are never removed as silence and `get_project` names subtitles with no line (speech lost) and lines with no subtitle (maybe made up); `settings.holdFlaggedLines` stops before voicing while lines still fail the translation checks (see `get_translation_report`); `settings.stopAtAdTail` (on by default) stops speech-to-text and a series where an advert tail begins (the same banner for the full version on the picture to the end, on "全集免费" uploads), with an `ad-tail` warning; `settings.branding` adds a logo and a greeting. |
| `start_dubbing` | Start, continue (after a pause, a review pause or a closed app), or redo from a step. On a series whose parts are made, continues every part in order; with `fromStep` `alignment`, `audio-mix` or `render` it redoes that step in every part that made it; an earlier step is redone part by part (refused on the series). |
| `run_next` | Move a project (or one part of a series) waiting in the queue to the front: it starts as soon as a slot frees. A part retried after a failure already takes its place in its series' order. |
| `pause_dubbing`, `cancel_dubbing` | Pause a running dub: it keeps everything done so far, and `start_dubbing` continues it later, also after the app was closed. `cancel_dubbing` does the same, and takes a queued dub out of the queue. On a series, `pause_dubbing` pauses all its parts. A part paused or stopped on its own stays paused when its series is started again (`start_series`, `start_dubbing` on the series): `get_series` marks it, and only `start_dubbing` on that part continues it. |
| `update_settings` | Change project settings; reports which step must re-run for the change to take effect. `applyToParts` makes the same change on every part of a series (speaker voices included), with a result per part. A part waiting in the queue takes a change to its mix or render (picture, logo and greeting, subtitles, render quality, levels) where it waits; another change skips it, as a part being dubbed is skipped, with the reason. The same holds for one project or part changed on its own while it waits: a mix or render change is taken there, anything else is refused until it is paused (`pause_dubbing` keeps its work). While a dub runs, such a change is taken until the dub starts mixing (song subtitles and voice-synced subtitles until it times the dub, when the subtitle files are written), and a series still being analysed always takes it (its parts are made from it). `watermarkAuto` (`{ mode: "blur" }`) finds the watermark and hides it without boxes: a series looks once in the whole video during its analysis and makes every part with the boxes (its plan notes say what was found); a single video, or a part whose series found none, looks when it renders. What is found becomes `blurRegions`; clearing them turns `watermarkAuto` off. The settings are saved, not re-run: `start_dubbing` on the series with `fromStep` `audio-mix` or `render` redoes the finished parts. |
| `get_transcript` | The lines with timing, source text, translation, and each line's speaking budget (e.g. `≤13 syllables`) and current length. A series part's times are its own: 0 is its window's start, which `get_series` shows. Can page and show only lines that need attention. `LOOP?` marks lines of a transcription loop the app could not repair, and the opening line of a decoder window kept for review. Where the speech map heard no speech, or one line lasts far longer than its words, speech-to-text decodes the stretch again without context and without the voice filter, and pairs the two decodes by time: a line both heard keeps its first wording, one only the second decode heard is added, one neither the map nor the second decode heard goes. What each decode heard is kept in `audio/loop_ranges.json`. |
| `export_transcript` | The whole transcript (id, times, speaker, original, translation, flags) as a JSON or tab-separated file, for long videos. |
| `replace_lines`, `retranscribe_range` | Restructure the lines of a time range before translation (remove a loop, split, merge, add a missed line; the new ids are returned), or of many ranges at once (`ranges`, or `file`: the path of a JSON file holding them, for a repair of hundreds of ranges) as one write and one history entry that `undo_edit` undoes as one; and hear a range again with the project's speech-to-text, by default without the previous text (what breaks a loop), through the checks speech-to-text runs (credit lines removed, loops decoded again to confirm them); `apply` replaces the range with it (refused on a translated project before anything is decoded), and a new line keeps its speaker only where its words still match the old line. A range over 15 minutes is a job in 15-minute windows, each applied as it is heard: the tool follows it for `waitSeconds`, and again with `jobId`. |
| `get_speakers`, `detect_speakers` | Who speaks in a project (minutes, pitch, gender, samples, voice) and the detection job's state; detect the speakers again over the transcript as it is. With `fromMs`/`toMs` only that range is labelled again, linked to the speakers the project already has by voice print (after a re-transcription), from the saved detection when the audio is unchanged. A detection the app was closed during shows as interrupted: calling it again continues from the parts done. |
| `set_translations` | Write translations for lines (all of them while the project is paused for review). |
| `adjust_lines` | Change a line's timing, voice or speaking rate (the same rules as the editor: no overlaps). |
| `regenerate_voices` | Re-voice edited lines. |
| `get_translation_report` | What the app's own passes did to the translation: whether the character sheet was built (and why not), lines that failed the checks (repaired or still flagged), the second try just before voicing (the lines still failing get another repair that names the words at fault and the sheet's names for them; what is left is voiced as it is and named in a `lines-flagged` warning, or, with `holdFlaggedLines`, the dub stops there, `get_project` names the lines, and `start_dubbing` voices them as they are after your fixes), what the review model changed or was refused, what auto-fit shortened (lines that still cannot fit even at the fastest speed are a `timing-conflicts` warning). |
| `get_translation_context`, `set_translation_context` | The character sheet: synopsis, cast, glossary and forms of address, used by every translation pass. `cast[].speakerId` ties a character to a detected speaker (the speaker ids decide the forms of address, so speakers must be detected before translating); a character detection split into several speakers takes one entry per id with the same name, so `cast_voices` gives it one voice, and a narrator or a system voice says so in its `role` ("narrator", "người dẫn truyện", "giọng hệ thống"); `corrections` fix what speech-to-text mishears (`{heard: "枪人", is: "羌人"}`) before translating; `applyToParts` saves it on every part of a series. |
| `get_queue` | What is dubbing (step, progress, time left), what waits and why, who holds the GPU lane (a dub, an editor action, a voice preview), which dub uses the GPU and which waits its turn (and since when) while dubs take turns on it, a queue paused for an app update, and the points budget. |
| `get_diagnostics` | The app's health (uptime, memory, responsiveness), GPU memory, the queue, engines running or failed with their last output, disk used per project and free disk, recent warnings and errors, crash reports; `bundle: true` writes a support bundle (logs and reports, no keys or logins) and returns its path. |
| `render_video` | Mix and render the final video (optionally changing the subtitle mode). |
| `join_videos`, `get_join`, `retry_join` | Make one project from several files of one story (P1, P2…) in order (`presetId` as in `create_project`: the joined length decides the preset's series of parts): the picture is copied when the files were encoded alike (otherwise the re-encode's cost is reported first and needs `reencode=true`), each file's sound is re-timed to its own picture and cut to its length, and the files' boundaries become preferred cuts of a series whose part numbers run across all of them (a cut within 30 s of one moves onto it; `series.perFile` makes one part per file). The join runs as a job the app shows; `get_join` follows it, `retry_join` starts a failed one again. |
| `detect_watermark` | Find, without AI, a static watermark (a box per corner, with a confidence) and the source's own burned-in subtitle band, over about 100 frames (per file of a joined project), with a preview image. Proposes; set them with `update_settings` (`blurRegions`: blur, pixelate or delogo, optionally for a time range; `burnSubtitleStyle.coverOriginal: "blur"` with `coverBand`, `subtitlesInBand`), `applyToParts` for a series; a finished part needs only `render_video`. |
| `cast_voices` | Propose (or, with `apply`, set) a voice for every speaker by gender, by CHARACTER: the speaker ids the character sheet gives one name (one `cast` entry per id) are ranked by their talk time together and get one voice. The user's lead voices (Voices → Lead voices, up to 3 per gender, in order) go first to the most-heard characters, then their confirmed clones, then built-ins; a narrator or a system voice (its role or name in the sheet) takes neither a lead voice nor a clone; a voice in `swaps` is that speaker's alone. Lines kept as songs and lines past an advert tail (or past its voice, when it starts before the banner) count for nothing; the minor speakers share a rotating pool of built-in voices per gender (3–6 by how many there are, `minorVoices` to choose), never the user's clone unless `minorPool` names it, with speakers who answer each other given different voices. A cloned voice the user keeps for one main character ("Only for one main character", `mainOnly` on `PATCH /voice-profiles/:id`; `list_voices` marks it) goes to one main speaker at most: never into a pool, even named, never a default, and a swap that would give it to a second speaker is left out with a note; settings that make it a default or give it to two speakers are refused. Built-ins that sound like a clone are kept for when nothing else is left and named; speakers of unknown gender are listed with their longest lines. |
| `mark_song` | Keep sung lines as the original song: no dub voice, the original audio in their window, subtitles only with `settings.songSubtitles` (off by default). Per line (`lineIds`) or a time range, `applyToParts` for a series. `get_transcript` shows them as SONG and the app's suggestions as SONG? (lyrics on screen, repeated choruses, long sung syllables), never applied by themselves. |
| `get_activity`, `report_activity` | Everything the app is working on (dubs, renders, downloads, installs, speaker detection, re-transcription, joins, picture detection…) with who started it (the app's window, an agent by name, or the app itself), progress and result; `report_activity` puts work an agent does outside the app into the same list. |
| `get_history`, `undo_edit` | A project's changes to its lines (who, when, what, the lines before and after), and undo of one of them when those lines have not changed since (speakers included). Each range speech-to-text's own checks changed is an entry too, so a wrong removal is undone range by range before translation. |
| `set_save_folder` | Choose the folder a project saves its finished video and subtitles in, or go back to the default. A video already made moves along. |
| `open_output_folder` | Open the folder with the finished video. |

Two prompts are included: **Dub a video with the best quality** and **Review and improve a dub's
translation**. In Claude Desktop they appear under the attachment (+) menu; in Claude Code and
Mother Claude they are `/mcp__videodubber__dub_video` and `/mcp__videodubber__improve_translation`.

## When something goes wrong

Every tool error says what failed and what to do, and ends with **Log reference: mcp-…**: the
app's structured log (`<config>/logs/orchestrator.jsonl`) has the same id on its lines for that
call. `get_diagnostics` shows the recent errors with their references, the engines' last output
and the crash reports; `get_diagnostics bundle=true` writes a zip to attach to a bug report.

If the backend itself stops (a crash, not a quit), the app restarts it by itself and the dubs it
was running continue from where they were; `get_diagnostics` then says when and why it stopped.

## The best-quality workflow

1. `create_project` with `reviewBeforeSynthesis: true`. The run transcribes, makes a quick draft
   translation, and **pauses** before any voice is generated.
2. Claude reads the whole transcript (`get_transcript`), writes the character sheet
   (`set_translation_context`: names, terms, who calls whom what), and rewrites the lines
   (`set_translations`), keeping each line within its speaking budget.
3. `start_dubbing` continues from the pause with Claude's text: voices, timing, mix, render.
4. After listening, fix single lines with `set_translations` / `adjust_lines`, then
   `regenerate_voices` and `render_video`.

Because every line has to be spoken in the time the original speaker took, the budget matters
more than literal completeness: a line over budget is sped up or overflows into the next one.

## Troubleshooting

- **Claude does not list the VideoDubber tools.** The session or app started before you
  connected: start a new Claude Code / Mother Claude session, or restart Claude Desktop. In a
  terminal, `claude mcp get videodubber` shows Claude Code's entry and whether it starts; in
  Claude Desktop, Settings → Developer shows the server's state and its log.
- **"VideoDubber is not running".** The server opens the installed app itself and waits up to two
  minutes for it. If it still does not answer, open the app, wait until the home screen shows,
  and ask again. A source checkout cannot start itself: run `pnpm dev`.
- **"Points to another copy of VideoDubber"** in Settings → Claude, after a reinstall or a move:
  click **Reconnect**.
- **"Claude Code not found".** Install Claude Code ([setup](https://code.claude.com/docs/en/setup)),
  then connect. If it is installed somewhere VideoDubber does not look, run the command shown in
  the row yourself.
- **Claude seems stuck in Mother Claude.** A tool call is probably waiting for your approval: look
  for the card on the desktop or on your phone.
- **"This build cannot start the MCP server"** in Settings: in a source checkout, run
  `pnpm build` first (the server is `packages/mcp-server/dist/cli.js`).
- **Nothing appears on stdout when you run the server by hand.** That is expected: MCP speaks
  JSON-RPC on stdin/stdout and waits for a client. Its own messages go to stderr.
