# VieNeu neural voice (Vietnamese) — setup guide

VideoDubber can dub Vietnamese with **VieNeu‑TTS v3‑Turbo**, a neural voice that
sounds far more natural than the built‑in Piper voice. It is **optional and
advanced**: Piper is the fast, always‑available default, and you only need this
if you want the higher‑quality Vietnamese voice.

This guide walks you through enabling it, step by step.

---

## At a glance

| | |
|---|---|
| **What it is** | VieNeu‑TTS v3‑Turbo — a 48 kHz Vietnamese neural voice (10 preset speakers). |
| **Cost** | Free, Apache‑2.0, runs **fully offline after a one‑time download**. |
| **Disk** | ~0.5–1 GB (model) + a small Python environment. |
| **RAM** | ~1.5–2 GB while dubbing. CPU‑only — no GPU needed. |
| **Languages** | Vietnamese (and English code‑switching). |
| **Default?** | No. Piper stays the default; turn VieNeu on per project. |

> **Which version?** The app uses **v3‑Turbo** (the newest line). You don't pick
> "v2" vs "v3" — selecting *VieNeu Neural TTS* always uses v3‑Turbo. VieNeu‑TTS‑v2
> is an older 24 kHz line and is not offered as a separate choice.

> ⚠️ **Status — early access.** VieNeu v3‑Turbo is brand‑new and we have not yet
> certified its speed on long videos. Treat it as a preview: great for shorter
> clips, and keep Piper for very long videos until you've tried it on your
> machine. Its output also carries an inaudible AI‑audio watermark.

---

## Before you start: do you need to install anything?

VieNeu installs into a small self‑contained Python environment managed by a tool
called **`uv`**. Whether you need to install `uv` yourself depends on how you run
VideoDubber:

| You run… | `uv` | What to do |
|---|---|---|
| **The installed desktop app** (VideoDubber.app / .msi) | **bundled** | Nothing — skip to step 2. |
| **The developer build** (`npm run dev` / `npm run app` from source) | **not bundled** | Install `uv` once — step 1 below. |

Everything else (the voice model, the Python packages) is downloaded for you when
you install the engine — you don't fetch anything by hand.

---

## Step 1 — Install `uv` (developer build only)

Skip this if you're using the installed desktop app.

Pick your OS:

**macOS**
```bash
brew install uv
# or, without Homebrew:
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Linux**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows (PowerShell)**
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Then **restart your terminal** (and the app) so `uv` is on your PATH. Verify:
```bash
uv --version
```

> Tip: the app checks for `uv` under **Settings → Engines**. If it says Python
> engines need `uv`, you haven't finished this step.

---

## Step 2 — Install the VieNeu engine

1. Open **Settings → Engines**.
2. Find **“VieNeu Neural TTS (Vietnamese)”** in the list.
3. Click **Install**. A progress bar appears while it builds the Python
   environment and downloads the packages (a few minutes the first time).
4. When it flips to **“installed”**, you're done here.

> The voice **model** itself (~0.5–1 GB) is downloaded the **first time you
> actually dub** with VieNeu, not during this step — so the first dub takes a bit
> longer while it downloads once, then it's cached for good.

---

## Step 3 — Use a VieNeu voice in a project

1. Start a **New project** and set your **target language to Vietnamese**.
2. In **Processing engines → Text to speech**, choose
   **“VieNeu Neural TTS (Vietnamese)”**.
   - If it's greyed out and says **“needs engine pack (Settings → Engines)”**, go
     back and finish Step 2.
3. A **Voice** picker appears with 10 preset voices (Ngọc Lan is the default).
   Pick one.
4. Click **Start dubbing**. On the very first run it downloads the model, then
   synthesizes your video.

You can also change the voice **per segment** in the **Editor**: each row has a
voice dropdown — pick a different voice and click **Regenerate TTS** for that line
(handy for giving a second speaker a distinct voice).

---

## What to expect

- **First run:** a one‑time model download (~0.5–1 GB). After that it's **fully
  offline**.
- **Speed:** CPU‑only; quality is excellent but neural TTS is slower than Piper.
  For a long video with many lines, the first pass can take a while. If it feels
  too slow on your machine, switch that project back to **Piper** (it's instant).
- **If a line can't be synthesized** (e.g. the model isn't ready), that line is
  filled with **silence** rather than failing the whole dub — you'll see it flagged
  so you can regenerate it.
- **Watermark:** every VieNeu clip carries an **inaudible** watermark identifying
  it as AI‑generated speech. This is intentional (disclosure) and doesn't affect
  what you hear.

---

## Troubleshooting

**“VieNeu Neural TTS — needs engine pack (Settings → Engines)” (greyed out)**
The engine isn't installed yet. Do Step 2.

**Install fails with “uv is required …”**
You're on the developer build and `uv` isn't installed or isn't on your PATH. Do
Step 1, then restart the app.

**The install step fails partway / network error**
Re‑open Settings → Engines and click Install again — it's safe to retry. Check
your internet connection (the first install fetches Python packages).

**The dub came out silent / it fell back**
The neural engine couldn't load (model still downloading, or a dependency issue).
Try again once (the model finishes downloading), or switch the project's Text‑to‑
speech to **Piper** to unblock yourself. The app logs the reason.

**It's very slow on a long video**
That's expected for neural TTS on CPU right now (v3‑Turbo is early access). Use
Piper for long videos, or split the work into shorter projects.

**Where is everything stored? / How do I remove it?**
The engine + its model live under your VideoDubber config folder
(`…/engines/tts-neural/`). To remove it, open **Settings → Engines** and click
**Remove** on VieNeu — that frees the disk space. Re‑installing re‑downloads it.

---

## Notes

- **License:** VieNeu‑TTS v3 is Apache‑2.0 (free for commercial use). It uses the
  MOSS‑Audio‑Tokenizer‑Nano codec and the sea‑g2p phonemizer; if you redistribute,
  check those components' licenses too.
- **No espeak‑ng needed:** unlike some neural TTS engines, v3‑Turbo brings its own
  Vietnamese pronunciation engine — there's no extra system tool to install.
- **For maintainers:** the pack definition and the pinned Python set live in
  [`enginePackCatalog.ts`](../packages/node-orchestrator/src/engines/enginePackCatalog.ts)
  and [`uvRequirements.ts`](../packages/node-orchestrator/src/engines/uvRequirements.ts);
  the engine server is [`workers/tts-engine-neural`](../workers/tts-engine-neural/).
  A cross‑OS install + synth check runs in CI ([`vieneu-smoke.yml`](../.github/workflows/vieneu-smoke.yml)).
