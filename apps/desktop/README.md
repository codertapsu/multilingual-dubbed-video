# videodubber-desktop

Angular 22 (standalone, signals) UI for VideoDubber, designed to run inside a
Tauri 2 shell but fully usable in a plain browser during development.

## Two ways to run

### 1. Browser dev (`ng serve`) — fast UI iteration

```bash
pnpm --filter videodubber-desktop dev      # ng serve --port 1420
```

Open http://127.0.0.1:1420. In this mode there is **no Tauri runtime**, so the
`IpcService` falls back to **HTTP fetch** against the orchestrator at
`http://127.0.0.1:5100` (override with `window.__VIDEODUBBER_ORCHESTRATOR_URL__`).
You must have the node-orchestrator (and the Python workers it proxies) running
— use `scripts/dev.sh` / `scripts/dev.ps1`.

Browser-mode caveats:

- **Native file picker is disabled.** `pickVideoFile()` returns `null`; paste an
  absolute path the orchestrator can read instead.
- **Media previews are best-effort.** Browsers cannot load `file://` URLs from
  an http origin. The editor audio preview and the export video preview point
  at an orchestrator static route `GET /file?path=<abs path>`. **If the
  orchestrator does not implement that route, those previews 404** and the UI
  shows a graceful fallback ("Open output folder" still works via the host's
  `open`/`xdg-open`). This is an intentional, documented limitation — the
  primary playback path is the native file manager.

### 2. Full Tauri run — the real desktop app

```bash
pnpm --filter videodubber-desktop tauri dev
```

(The `src-tauri/` Rust shell is owned by a separate agent.) Here the
`IpcService` detects `window.__TAURI_INTERNALS__` and routes every command
through `@tauri-apps/api`'s `invoke(...)`, which proxies to the orchestrator on
the Rust side. Native dialogs (`pick_video_file`) and folder opening use Tauri
plugins.

> SSE is **always** a direct `EventSource` to the orchestrator
> (`/projects/:id/events`) in both modes — it is never forwarded through Rust.

## Architecture

```
src/app/
  app.component.ts            shell + top nav (mode tag: Desktop vs Browser dev)
  app.routes.ts               lazy standalone routes
  core/
    environment.ts            orchestratorUrl resolution
    ipc/ipc.service.ts        DUAL-MODE transport (Tauri invoke | HTTP fetch)
    ipc/pipeline-events.service.ts  SSE -> signals (pipeline/logs/steps)
    state/project.store.ts    signal store (+ toAppError normalizer)
    models/                   type-only re-exports of @videodubber/shared + VMs
    util/format.ts            timecode/byte/label helpers
  shared/
    error-banner/             AppError renderer (what/why/fix/docs)
    status-badge/             status pill
  screens/
    home/                     list/open/create projects
    new-project-wizard/       pick video + langs + options -> create -> probe -> run
    processing/               live SSE pipeline view (9 steps, logs, cancel/retry)
    editor/                   side-by-side transcript/translation, per-segment TTS
    export/                   output path, preview, re-render, open folder
```

## TypeScript version

This package and the repo root pin the **same** TypeScript version — there is no
per-package split and nothing to keep isolated.

Angular's supported range is declared by `@angular/compiler-cli`, so read it from
the package rather than from prose here:

```bash
npm view @angular/compiler-cli peerDependencies.typescript
```

> This section used to claim the root pinned TS `5.6`, that "Angular 18 does not yet
> support TS 5.6", and that this package therefore pinned `~5.5.4` on purpose. All of
> it was false after the Angular 22 upgrade, and following it would have downgraded
> TypeScript far enough to break the build. A doc that describes a deliberate pin
> which does not exist is worse than a stale version number, because it invites
> someone to "restore" it.

## Useful scripts

| script      | what it does                                  |
| ----------- | --------------------------------------------- |
| `dev`       | `ng serve --port 1420` (browser dev)          |
| `build`     | `ng build` (production bundle to `dist/`)     |
| `typecheck` | `tsc -p tsconfig.app.json --noEmit`           |
| `tauri`     | `tauri` CLI passthrough (full desktop run)    |
