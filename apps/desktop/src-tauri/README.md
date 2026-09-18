# videodubber-desktop — Tauri 2 backend (`src-tauri`)

The native desktop shell for VideoDubber. It is intentionally thin:

| Responsibility | Where |
| --- | --- |
| Native open-file dialog (`pick_video_file`) | `src/commands.rs` + `tauri-plugin-dialog` |
| Open a file/folder in the OS (`open_path`, `open_output_folder`) | `src/commands.rs` + `tauri-plugin-opener` |
| Proxy all pipeline commands to the orchestrator | `src/commands.rs` → `src/orchestrator_client.rs` |
| Spawn orchestrator + workers, and tear them down on quit | `src/sidecar.rs` (**default-on**; `VIDEODUBBER_MANAGE_SERVICES=0` opts out) |

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
at `../dist/browser` (the Angular browser output — adjust if `outputPath`
changes).

### Service lifecycle

The shell manages the backend **by default**, in both modes:

* **Dev (source checkout detected)** — runs `scripts/start-services.sh`
  (`start-services.ps1` on Windows) in its own process group and terminates that
  group on exit. So `pnpm dev` in a second terminal is optional, not required;
  set `VIDEODUBBER_MANAGE_SERVICES=0` when you want to run the backend yourself.
* **Production (packaged, no source tree)** — the orchestrator is launched through
  the Tauri shell plugin's `sidecar()` API, and the three Python workers are one-dir
  resource trees launched directly with `std::process::Command` and located by
  `resolve_worker_exe`. Only the orchestrator is governed by the shell-plugin
  capability ACL, which is worth knowing before debugging a "worker not found".

> This section used to say sidecar spawning was "future", default-off, and behind a
> `spawn-sidecars` cargo feature. It has shipped since v0.1.0; see
> [`docs/PRODUCTION.md`](../../../docs/PRODUCTION.md).

## Icons

A release `tauri build` requires bundle icons. Generate them once:

```sh
pnpm tauri icon path/to/source-logo.png
```

See `icons/README.md`.
