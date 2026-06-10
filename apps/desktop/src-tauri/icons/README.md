# App icons

Tauri requires a set of platform icons to **bundle** a release build. They are
referenced from `tauri.conf.json` under `bundle.icon`:

```
icons/32x32.png
icons/128x128.png
icons/128x128@2x.png
icons/icon.icns   (macOS)
icons/icon.ico    (Windows)
```

These binary assets are intentionally **not** checked in here (they would just
be placeholders). Generate the full set from a single high-resolution source
image (ideally 1024×1024 PNG with transparency):

```sh
# From apps/desktop/
pnpm tauri icon path/to/source-logo.png
# (writes all the files above into src-tauri/icons/)
```

Notes:
- `tauri dev` will run without all icons present, but a `tauri build` will fail
  until they exist — so run the command above before packaging.
- If you only have a PNG and want a quick unblock, `pnpm tauri icon` will derive
  the `.icns` and `.ico` for you; no manual conversion needed.
- Keep the source logo in the repo (e.g. `apps/desktop/branding/logo.png`) so
  icons can be regenerated reproducibly.
