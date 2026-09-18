# VideoDubber documentation

`ls docs/` is twenty-odd alphabetical files with no obvious entry point, which is
how several of them drifted unnoticed. This page is the index: every doc appears
here exactly once, under the audience it is written for.

## For users of the installed app

You need none of the contributor docs to use VideoDubber.

| Doc | Read it for |
|---|---|
| [**USER_GUIDE.md**](USER_GUIDE.md) | **Start here.** Which file to download, first launch on macOS and Windows, the setup wizard, your first dub, the video downloader, Settings, where files live, updating, uninstalling. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Every error code the app can show, plus common failures. Split into "using the app" and "developing". |
| [VIENEU_TTS_SETUP.md](VIENEU_TTS_SETUP.md) | The optional neural Vietnamese voice: install it, use it, remove it. |
| [PROVIDERS.md](PROVIDERS.md) | Every engine you can pick per phase — local defaults, engine packs, optional cloud providers and exactly what data they send. |
| [MODEL_SETUP.md](MODEL_SETUP.md) | Whisper models, Argos translation packs and Piper voices: what they are, where they live, how to pre-seed them. |

## For contributors (building from source)

| Doc | Read it for |
|---|---|
| [LOCAL_SETUP.md](LOCAL_SETUP.md) | Node / pnpm / Python / FFmpeg / Rust setup on macOS and Linux; running and stopping each service. |
| [WINDOWS.md](WINDOWS.md) | The complete Windows story: machine setup, dev loop, build, release. The canonical toolchain versions live here. |
| [DESKTOP_APP.md](DESKTOP_APP.md) | Running the Tauri shell from a source checkout and how it auto-starts/stops the backend. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, the nine pipeline steps, data model, workspace layout, HTTP API surface, Tauri commands, SSE model. |
| [RUN_QUEUE.md](RUN_QUEUE.md) | How simultaneous dubs are admitted, bounded and sequenced across a shared machine. |
| [DUBBING_QUALITY.md](DUBBING_QUALITY.md) | Why dubs sound the way they do, and the ranked plan to improve them. |
| [ENGINE_PACKS.md](ENGINE_PACKS.md) | Maintainer runbook for the engine-pack catalog: what each pack is, how pins and checksums work, how to re-pin a dead URL. |

## For maintainers (packaging, signing, shipping)

| Doc | Read it for |
|---|---|
| [RELEASING.md](RELEASING.md) | The release runbook: build locally on each OS, upload to the shared draft, merge `latest.json`, publish. |
| [APPLE_SIGNING.md](APPLE_SIGNING.md) | Developer ID signing + notarization: why the deep-sign pass is mandatory and how to debug it. |
| [AUTOUPDATE.md](AUTOUPDATE.md) | The updater: endpoint, pubkey, on-device signature verification, the auto/manual setting, rollback. |
| [PRODUCTION.md](PRODUCTION.md) | What the installer actually contains, the production sidecar lifecycle, storage layout and sizes. |

## Research & decisions

| Doc | Read it for |
|---|---|
| [ROADMAP.md](ROADMAP.md) | What has shipped, and what is genuinely still planned. |
| [TECH_STACK_RESEARCH.md](TECH_STACK_RESEARCH.md) | The on-device AI landscape survey the engine-pack system came out of. |
| [TRANSLATION_EVAL.md](TRANSLATION_EVAL.md) | What is and isn't known about translation quality for our language pairs. |
| [OMNIVOICE.md](OMNIVOICE.md) | The OmniVoice TTS pack: why it is on hold, and the checklist to re-enable it. |
| [RELEASE_NOTES_v0.1.0.md](RELEASE_NOTES_v0.1.0.md) | The first release's notes, kept for reference. |

---

**If you add a doc, add it here.** And if you ship a user-visible feature, it
belongs in [USER_GUIDE.md](USER_GUIDE.md) — the 0.9.0 video downloader was
documented only inside a troubleshooting entry for a whole release because there
was nowhere else for it to go.
