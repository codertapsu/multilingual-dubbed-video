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
| `download_videos`, `list_downloads`, `cancel_download`, `retry_download`, `delete_download` | Queue many links at once (two download at a time, kept across restarts, a rate-limited site waited out); a video already queued is returned, not downloaded twice (its `sourceKey`, e.g. `bilibili:BV…:p2`). A Bilibili collection, series list, favourites folder or uploader's page link queues its videos. |
| `set_download_login`, `get_download_login` | Sign in to Bilibili with the browser's cookies: pass the **path** of a cookie export (Mother Claude's `browser_cookies` export); the file is read and deleted, only `SESSDATA` and `buvid3` are kept, and no value is ever shown. Answers the account and the best quality available. |
| `list_presets`, `dub_downloads` | Make a project per finished download from a preset (or languages + settings) and start them; one waiting for its models starts when they arrive. `series` dubs the long ones as parts (needs an AI set up in Settings; only videos longer than `longerThanMinutes`, by default 1.5 × the longest part); `series.nameTemplate` names the parts (as in `create_project`). |
| `list_brand_kit` | The logos and spoken greetings made in Settings → Logo & greeting, by id, for a project's `settings.branding` (`{ logo: { assetId, corner, … }, greeting: { assetId, atStart, repeat } }`). |
| `get_series`, `set_split_plan`, `start_series` | A long video dubbed in parts: where the series stands, its cuts with titles and summaries, and each part's project and progress; change the cuts or titles before the parts are made (`create_project` with `series.autoStart: false`); make the parts and queue them in order. Even with `autoStart` a series starts its parts by itself only when its analysis is clean (speakers detected when asked for, no transcription loops left); otherwise it stops at review and `get_series` says why. Every part stays within the min–max length when the pauses allow, and the plan notes say why one does not. |
| `rebuild_parts` | After the series transcript was fixed: make the parts' transcripts again from it, with the series' character sheet: all of them, or `parts: [23, 24]`. A part waiting in the queue is rebuilt where it waits and keeps its place (nothing needs pausing); a part being dubbed is left alone and the answer says why. Parts already translated are kept unless `force` (then the part continues at the translation on its next run). Reports old and new line counts and speakers per part; each rebuild is in the part's edit history. |
| `edit_part`, `replan_series` | `edit_part` renames a made part (its project, and its files in a chosen folder), or changes its title or summary, without redoing its dub; a finished part with a new title is rendered again (only the render, on the next `start_series`). `replan_series` plans a series again before its parts are made; `keepTitles` keeps the titles written in review on the parts covering the same stretch of video. |
| `wait_jobs`, `follow_jobs_command` | Follow downloads and dubs: a wait of up to 50 s, or a command (`curl.exe -sN …/jobs/events?…&untilDone=1`) that prints one JSON line per change and exits when all of them have stopped, for long batches. |
| `get_outputs`, `mark_published` | A finished dub's files (with size and sha256, and a thumbnail JPG with no subtitle on it), length and source (title, uploader, link) for a post's caption, and where it was posted; record a post so it is never posted twice. |
| `delete_project` | Delete a project (asks you first). |
| `list_projects`, `get_project` | Projects, and one project's progress, step by step (with the sub-step, e.g. *Detecting speakers 3/12*, and an estimate of the time left), the run's **warnings** (speaker detection failed, transcription loops repaired or left, a step that ran on the CPU because the GPU was busy, lines with nothing to say) and the end of its log. `waitSeconds` (up to 50) waits for progress. |
| `create_project` | Create a project from a video file, starting from the same automatic settings the New Project wizard uses (the best engines installed here), with any overrides. The file is hard-linked into the project when it is on the projects' drive (copied otherwise), and the tool waits up to 30 minutes for a copy; if that runs out it says the project may still appear (look with `list_projects`) rather than inviting a second copy. `saveTo` chooses the folder for the finished video. Can start the dub at once. `series` dubs it as parts (15–20 minutes by default): `series.nameTemplate` names them (`{series}`, `{n}`, `{nn}`, `{total}`, `{title}`), `series.continues` makes a later season of a series (its name, numbering and settings carry on, its voices go to the speakers who sound like its speakers); `settings.useSourceSubtitles` uses the subtitles the site published instead of speech-to-text (Bilibili gives them only to a signed-in account: `set_download_login` first); `settings.branding` adds a logo and a greeting. |
| `start_dubbing` | Start, continue (after a pause, a review pause or a closed app), or redo from a step. On a series whose parts are made, continues every part in order. |
| `pause_dubbing`, `cancel_dubbing` | Pause a running dub: it keeps everything done so far, and `start_dubbing` continues it later, also after the app was closed. `cancel_dubbing` does the same, and takes a queued dub out of the queue. On a series, `pause_dubbing` pauses all its parts. |
| `update_settings` | Change project settings; reports which step must re-run for the change to take effect. `applyToParts` makes the same change on every part of a series (speaker voices included), with a result per part. |
| `get_transcript` | The lines with timing, source text, translation, and each line's speaking budget (e.g. `≤13 syllables`) and current length. Can page and show only lines that need attention. `LOOP?` marks lines of a transcription loop the app could not repair. |
| `export_transcript` | The whole transcript (id, times, speaker, original, translation, flags) as a JSON or tab-separated file, for long videos. |
| `replace_lines`, `retranscribe_range` | Restructure the lines of a time range before translation (remove a loop, split, merge, add a missed line; the new ids are returned), and hear a range again with the project's speech-to-text, by default without the previous text (what breaks a loop); `apply` replaces the range with it. |
| `set_translations` | Write translations for lines (all of them while the project is paused for review). |
| `adjust_lines` | Change a line's timing, voice or speaking rate (the same rules as the editor: no overlaps). |
| `regenerate_voices` | Re-voice edited lines. |
| `get_translation_report` | What the app's own passes did to the translation: whether the character sheet was built (and why not), lines that failed the checks (repaired or still flagged), what the review model changed or was refused, what auto-fit shortened. |
| `get_translation_context`, `set_translation_context` | The character sheet: synopsis, cast, glossary and forms of address, used by every translation pass. `cast[].speakerId` ties a character to a detected speaker (the speaker ids decide the forms of address, so speakers must be detected before translating); `corrections` fix what speech-to-text mishears (`{heard: "枪人", is: "羌人"}`) before translating; `applyToParts` saves it on every part of a series. |
| `get_queue` | What is dubbing (step, progress, time left), what waits and why, who holds the GPU lane (a dub, an editor action, a voice preview), and the points budget. |
| `get_diagnostics` | The app's health (uptime, memory, responsiveness), GPU memory, the queue, engines running or failed with their last output, disk used per project and free disk, recent warnings and errors, crash reports; `bundle: true` writes a support bundle (logs and reports, no keys or logins) and returns its path. |
| `render_video` | Mix and render the final video (optionally changing the subtitle mode). |
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
