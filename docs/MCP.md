# Controlling VideoDubber from Claude (MCP)

VideoDubber includes an [MCP](https://modelcontextprotocol.io) server, so Claude Desktop or
Claude Code can run the whole dubbing process for you: check what this computer can do, download
a video, create a project, start and watch the dub, read and rewrite the translation, re-time or
re-voice lines, and render the final video.

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

Settings → Claude shows the exact command for this installation, with a **Copy** button. It
looks like this:

```bash
# Installed app (Windows)
claude mcp add --scope user videodubber -- "C:\Program Files\VideoDubber\videodubber-orchestrator.exe" --mcp

# Source checkout (after pnpm build)
claude mcp add --scope user videodubber -- node /path/to/repo/packages/mcp-server/dist/cli.js
```

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
translation**. In Claude Desktop they appear under the attachment (+) menu.

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

- **Claude does not list the VideoDubber tools.** Restart Claude Desktop after connecting. In
  Claude Desktop, Settings → Developer shows the server's state and its log.
- **"VideoDubber is not running".** Open the app and wait until the home screen shows; then ask
  again. A source checkout needs `pnpm dev`.
- **"This build cannot start the MCP server"** in Settings: in a source checkout, run
  `pnpm build` first (the server is `packages/mcp-server/dist/cli.js`).
- **Nothing appears on stdout when you run the server by hand.** That is expected: MCP speaks
  JSON-RPC on stdin/stdout and waits for a client. Its own messages go to stderr.
