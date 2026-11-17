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
| `install_engine` | Install an engine pack (reports download progress). Claude is asked to tell you the size first. |
| `download_video`, `get_download` | Fetch a video from a link and follow the download. |
| `list_projects`, `get_project` | Projects, and one project's progress, step by step, with the end of its log. `waitSeconds` (up to 50) waits for progress. |
| `create_project` | Create a project from a video file, starting from the same automatic settings the New Project wizard uses (the best engines installed here), with any overrides. Can start the dub at once. |
| `start_dubbing`, `cancel_dubbing` | Start, continue, redo from a step, or stop. |
| `update_settings` | Change project settings; reports which step must re-run for the change to take effect. |
| `get_transcript` | The lines with timing, source text, translation, and each line's speaking budget (e.g. `≤13 syllables`) and current length. Can page and show only lines that need attention. |
| `set_translations` | Write translations for lines (all of them while the project is paused for review). |
| `adjust_lines` | Change a line's timing, voice or speaking rate (the same rules as the editor: no overlaps). |
| `regenerate_voices` | Re-voice edited lines. |
| `get_translation_report` | What the app's own passes did to the translation: whether the character sheet was built (and why not), lines that failed the checks (repaired or still flagged), what the review model changed or was refused, what auto-fit shortened. |
| `get_translation_context`, `set_translation_context` | The character sheet: synopsis, cast, glossary and forms of address, used by every translation pass. |
| `render_video` | Mix and render the final video (optionally changing the subtitle mode). |
| `open_output_folder` | Open the folder with the finished video. |

Two prompts are included: **Dub a video with the best quality** and **Review and improve a dub's
translation**. In Claude Desktop they appear under the attachment (+) menu; in Claude Code and
Mother Claude they are `/mcp__videodubber__dub_video` and `/mcp__videodubber__improve_translation`.

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
