# Auto-update

VideoDubber updates itself via **GitHub Releases** using the official
[`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/). Updates are
**signed** and verified on-device, and users can choose **automatic** or
**manual** updates.

> For how a release is produced and signed, see [`RELEASING.md`](RELEASING.md).
> For what's in the app at all, see [`PRODUCTION.md`](PRODUCTION.md).

---

## How it works end to end

```
   GitHub Release  ──►  latest.json (signed manifest)  ──►  installed app
   (v0.2.0 assets)      published at:                       1. fetch latest.json from endpoint
                        releases/latest/download/latest.json 2. compare manifest.version vs app version
                                                             3. if newer: download platform archive
                                                             4. verify .sig with embedded pubkey
                                                             5. install + relaunch
```

1. **Endpoint.** The app is configured (in `tauri.conf.json`) with
   `plugins.updater.endpoints`:

   ```
   https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json
   ```

   `releases/latest/download/...` always resolves to the newest **published**
   release, so promoting a draft to published is what "ships" an update.

2. **Manifest.** `latest.json` lists the new `version`, release `notes`, and a
   per-platform `{ url, signature }`. The `url` points at that platform's update
   archive in the release assets; `signature` is a detached Ed25519 signature.

3. **Signature verification.** The app embeds the **public key**
   (`plugins.updater.pubkey`). After downloading the archive it verifies the
   signature against that pubkey **before** installing. A tampered or
   wrong-key archive is rejected — this is the core security property, so an
   attacker who compromises the download host still can't push a malicious update
   without the private key (which lives only in CI secrets).

4. **Install + relaunch.** On success the plugin applies the update in place and
   the app relaunches via `tauri-plugin-process`.

---

## The in-app setting (auto vs. manual)

The **Settings → Updates** screen (route `/settings`) exposes:

* **"Automatically install updates"** toggle — persisted via
  `get_update_preference` / `set_update_preference`, which proxy to the
  orchestrator's `/preferences` endpoint (`{ "autoUpdate": boolean }`) and are
  mirrored into the app config (`<config>/preferences.json`). The orchestrator's
  copy is the source of truth for the UI.
* **"Check for updates now"** — calls `check_for_update`, which returns
  `UpdateInfo { available, version?, currentVersion, notes?, date? }`.
* **"Download & install"** — calls `download_and_install_update`, which downloads
  the pending update, installs it, and relaunches.
* The current app version is shown for reference.

**Auto behavior.** On startup the shell reads `autoUpdate`. If `true`, it calls
`check_for_update` in the background; when an update is available it downloads,
verifies, installs, and relaunches (optionally after a small prompt). If `false`,
nothing happens automatically — the user drives updates from Settings.

**Outside Tauri (browser dev mode).** There's no updater, so the update controls
are **disabled** with the note *"available in the desktop app."* The toggle's
*preference* still round-trips through the orchestrator so the setting is
consistent, but no check/download is possible.

---

## Manual check flow (what the user sees)

1. Open **Settings → Updates**.
2. Click **Check for updates now**.
3. If up to date: *"You're on the latest version (vX.Y.Z)."*
4. If an update exists: the new version + release notes are shown with a
   **Download & install** button. Clicking it downloads, verifies, installs, and
   relaunches into the new version.

Release notes come from the `notes` field in `latest.json` (the GitHub release
body). The **release notes link** opens in the system browser via
`open_external(url)` (`tauri-plugin-opener`).

---

## Rollback / yanking a bad release

Because the endpoint is `releases/latest/download/latest.json`, **what "latest"
points at is controlled entirely by which release is the newest *published* one.**
To pull a bad version:

1. **Mark the bad release as a draft (or pre-release), or delete it.** Once it's no
   longer the latest *published* release, `releases/latest/...` resolves back to
   the previous good release's `latest.json`. New checks will offer that version.
2. **Ship a higher patch version** that's actually a re-release of the last good
   code (e.g. yank `v0.2.0`, publish `v0.2.1`). Because the updater only moves
   **forward** (it compares versions), apps already on the bad `v0.2.0` won't
   "downgrade" automatically — you must publish a *higher* version to fix them.
   So prefer **roll-forward** (`v0.2.1`) over trying to revert installed users to
   `v0.1.x`.
3. Communicate in the release notes; affected users can also reinstall a known
   good installer from the Releases page manually.

> Tip: keep releases as **drafts** until verified (the CI publishes drafts). A
> draft is never `latest`, so it can't reach users until you click Publish.

---

## Configuration reference

| Where | Key | Value |
|---|---|---|
| `tauri.conf.json` | `plugins.updater.endpoints` | `["https://github.com/codertapsu/multilingual-dubbed-video/releases/latest/download/latest.json"]` |
| `tauri.conf.json` | `plugins.updater.pubkey` | the public key from `pnpm tauri signer generate` |
| `tauri.conf.json` | `bundle.createUpdaterArtifacts` | `true` (emit the signed update archives + `latest.json`) |
| `capabilities/default.json` | permissions | `updater:default`, `process:allow-restart` (or `process:default`), `opener:default` |
| CI secrets | `TAURI_SIGNING_PRIVATE_KEY` (+ password) | signs `latest.json` per release |
| App config | `<config>/preferences.json` → `autoUpdate` | user's auto/manual choice |

**Before auto-update works:** the endpoint already points at the real repo
(`codertapsu/multilingual-dubbed-video`). Generate the updater keypair, put the
**public** key in `tauri.conf.json` → `plugins.updater.pubkey`, and add the
**private** key as the `TAURI_SIGNING_PRIVATE_KEY` CI secret so each release
ships a signed `latest.json`. See [`RELEASING.md`](RELEASING.md#one-time-setup).
A release built without that secret still installs fine — it just won't
auto-update.
