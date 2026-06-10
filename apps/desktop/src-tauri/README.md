# videodubber-desktop — Tauri 2 backend (`src-tauri`)

The native desktop shell for VideoDubber. It is intentionally thin:

| Responsibility | Where |
| --- | --- |
| Native open-file dialog (`pick_video_file`) | `src/commands.rs` + `tauri-plugin-dialog` |
| Open a file/folder in the OS (`open_path`, `open_output_folder`) | `src/commands.rs` + `tauri-plugin-opener` |
| Proxy all pipeline commands to the orchestrator | `src/commands.rs` → `src/orchestrator_client.rs` |
| Spawn orchestrator + workers as sidecars (future) | `src/sidecar.rs` (default-off) |

Everything else — the pipeline, project persistence, worker calls — lives in
`@videodubber/node-orchestrator` (HTTP, port 5100). Progress is streamed to the
webview **directly** over SSE (`GET /projects/:id/events`); it is **not**
forwarded through Rust.

## Commands (mapped to orchestrator REST)

| Tauri command | Orchestrator endpoint |
| --- | --- |
| `create_project` | `POST /projects` |
| `list_projects` | `GET /projects` |
| `get_project` / `open_project` | `GET /projects/:id` |
| `probe_video` | `POST /projects/:id/probe` |
| `run_pipeline` | `POST /projects/:id/run` |
| `cancel_pipeline` | `POST /projects/:id/cancel` |
| `retry_pipeline_step` | `POST /projects/:id/retry` |
| `get_segments` | `GET /projects/:id/segments` |
| `save_translated_segments` | `PUT /projects/:id/segments` |
| `synthesize_single_segment` | `POST /projects/:id/segments/:segId/tts` |
| `render_final_video` | `POST /projects/:id/render` |
| `workers_health` | `GET /workers/health` |
| `list_languages` | `GET /languages` |
| `open_output_folder` / `open_path` | native (opener plugin) |
| `pick_video_file` | native (dialog plugin) |

Errors returned to the webview are JSON-encoded `AppError`
(`{ code, message, remediation?, docsRef? }`) in the rejected-promise string.

## Environment

| Var | Default | Used by |
| --- | --- | --- |
| `ORCHESTRATOR_URL` | `http://127.0.0.1:5100` | `orchestrator_client.rs` |

## Development

Start the backend services + Angular dev server separately (the shell does
**not** spawn them by default):

```sh
pnpm dev          # scripts/dev.sh — orchestrator(5100) + workers(5101-5103) + ng(1420)
```

Then, in another terminal:

```sh
# From apps/desktop/
pnpm tauri dev
```

`tauri.conf.json` points `devUrl` at `http://localhost:1420` and `frontendDist`
at `../dist/videodubber-desktop/browser` (Angular 18 default browser output —
adjust if the UI agent changes `outputPath`).

### Optional: let the shell spawn services (dev only)

Build with the `spawn-sidecars` feature to have the shell launch the
orchestrator + workers as managed child processes (see `src/sidecar.rs`):

```sh
pnpm tauri dev -- --features spawn-sidecars
```

This is a scaffold; production packaging should use Tauri `externalBin`
sidecars instead (TODOs in `src/sidecar.rs`).

## Icons

A release `tauri build` requires bundle icons. Generate them once:

```sh
pnpm tauri icon path/to/source-logo.png
```

See `icons/README.md`.
