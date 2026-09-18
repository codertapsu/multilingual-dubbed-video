# VieNeu neural voice (Vietnamese) — setup guide

VideoDubber can dub Vietnamese with **VieNeu‑TTS v3‑Turbo**, a neural voice that
sounds far more natural than the built‑in Piper voice. It's **optional**: Piper is
the fast, always‑available default, and you only need this for a higher‑quality
Vietnamese voice.

There is **one** VieNeu pack, installed in one click from Settings → Engines:

| | **VieNeu Neural TTS v3 (Vietnamese)** |
|---|---|
| Pack id | `tts-neural` |
| Quality / rate | 48 kHz |
| Voices | 10 preset Vietnamese voices |
| **License** | **Apache‑2.0** — commercial use OK |
| Runs on | CPU only, every platform (no GPU, no torch) |

> **History — where did "v2" go?** An earlier VieNeu v2 pack (`tts-neural-v2`) is
> still defined in the catalog but is in `DISABLED_PACK_IDS`, so it never appears
> in Settings → Engines and cannot be installed. It was withdrawn because its
> neural path was never validated end to end, its wheels were Windows‑only, and
> its 7 bundled reference voices are **CC BY‑NC 4.0 — non‑commercial only**. v3 is
> cross‑platform, validated and Apache‑2.0, so it supersedes v2 outright. If you
> are reading an older copy of this guide that recommends v2, that guide is wrong:
> the option is not there to pick.

---

## At a glance

| | |
|---|---|
| **What it is** | VieNeu‑TTS v3‑Turbo — a Vietnamese neural voice at 48 kHz with 10 preset voices. |
| **Cost** | Free; runs **fully offline after a one‑time download**. |
| **Disk** | ~1.5 GB for the Python environment, plus ~0.5–1 GB for the voice model. |
| **RAM** | ~1.5–2 GB while dubbing. CPU‑only — no GPU needed. |
| **Languages** | Vietnamese (it also code‑switches English). |
| **Default?** | For Vietnamese projects the wizard pre‑selects `tts-neural` **once its pack is installed**; otherwise Piper, so dubbing works out of the box. |

> Output carries an **inaudible** watermark identifying it as AI‑generated speech.
> This is intentional (disclosure) and doesn't affect what you hear.

---

## Before you start: do you need to install anything?

VieNeu installs into a small self‑contained Python environment managed by a tool
called **`uv`**. Whether you need `uv` yourself depends on how you run
VideoDubber:

| You run… | `uv` | What to do |
|---|---|---|
| **The installed desktop app** (VideoDubber.app / `-setup.exe`) | **bundled** | Nothing — skip to step 2. |
| **The developer build** (`pnpm dev` / `pnpm app` from source) | **not bundled** | Install `uv` once — step 1 below. |

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
2. Find **“VieNeu Neural TTS v3 (Vietnamese)”**. Read the license note shown
   right there before installing.
3. Click **Install**. A progress bar appears while it builds the Python
   environment and downloads the packages (a few minutes the first time).
4. When it flips to **“installed”**, you're done here.

> The voice **model** itself (~0.5–1 GB) is downloaded the **first time you
> actually dub** with VieNeu, not during this step — so the first dub takes a bit
> longer while it downloads once, then it's cached for good.

---

## Step 3 — Use a VieNeu voice in a project

1. Start a **New project** and set your **target language to Vietnamese**.
2. In **Processing engines → Text to speech**, choose **“VieNeu Neural TTS v3”**.
   For Vietnamese it is pre‑selected automatically once the pack is installed.
   - If it's greyed out and says **“needs engine pack (Settings → Engines)”**, go
     back and finish Step 2.
3. A **Voice** picker appears listing the 10 presets. Pick one.
4. Click **Start dubbing**. On the very first run it downloads the model, then
   synthesizes your video.

You can also change the voice **per segment** in the **Editor**: each row has a
voice dropdown — pick a different voice and click **Regenerate TTS** for that line
(handy for giving a second speaker a distinct voice, since VideoDubber does not
detect speakers on its own).

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
  it as AI‑generated speech.

---

## Troubleshooting

**“VieNeu Neural TTS — needs engine pack (Settings → Engines)” (greyed out)**
The engine isn't installed yet. Do Step 2.

**I can't find a "v2" option**
There isn't one — see the history note at the top. Install v3.

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
That's expected for neural TTS on CPU. Use Piper for long videos, or split the
work into shorter projects.

**Where is everything stored? / How do I remove it?**
The engine + its model live under your VideoDubber folder
(`…/engines/tts-neural/`). To remove it, open **Settings → Engines** and click
**Remove** on VieNeu — that frees the disk space. Re‑installing re‑downloads it.

---

## Notes

- **License:** VieNeu‑TTS v3 is Apache‑2.0 (free for commercial use). It uses the
  MOSS‑Audio‑Tokenizer‑Nano codec and the sea‑g2p phonemizer; if you redistribute,
  check those components' licenses too. See [`../NOTICE.md`](../NOTICE.md).
- **No espeak‑ng needed:** unlike some neural TTS engines, v3‑Turbo brings its own
  Vietnamese pronunciation engine — there's no extra system tool to install.
- **For maintainers:** the pack definition and the pinned Python set live in
  [`enginePackCatalog.ts`](../packages/node-orchestrator/src/engines/enginePackCatalog.ts)
  and [`uvRequirements.ts`](../packages/node-orchestrator/src/engines/uvRequirements.ts);
  the engine server is [`workers/tts-engine-neural`](../workers/tts-engine-neural/).
  A cross‑OS install + synth check runs in CI ([`vieneu-smoke.yml`](../.github/workflows/vieneu-smoke.yml)).
  The `vieneu` SDK is pinned at **3.0.5** while upstream is several minors ahead;
  `uvRequirements.ts` still carries a "validated candidates, not yet verified"
  caveat, and the extras reorganised after 3.0.5 (the Perth watermarker moved to
  an optional extra), so run the smoke workflow on a candidate before bumping it.
- **Any pack id named in this doc must exist in `ENGINE_PACKS` and must not be in
  `DISABLED_PACK_IDS`** — documenting a withheld pack as the recommended default
  is exactly the bug this rewrite fixed.
