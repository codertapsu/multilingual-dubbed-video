# Voices

VideoDubber speaks with **voices**, and every voice belongs to an **engine** (the
model that speaks it). This page explains the voice library: which engines and
voices exist, how they are downloaded and checked, what the licence badges mean,
and how the catalog is maintained. Cloning a voice from a recording is in
[VOICE_CLONING.md](VOICE_CLONING.md).

## For users: the Voices screen

Open **Giọng đọc / Voices** in the top bar.

- **Engines** (top card): each engine with what it can do, its licence, and an
  **Install** button per build when it is not installed. An engine downloads
  once; after that every voice it ships is ready, offline too. On a computer with
  an NVIDIA card an engine may offer a **GPU build** next to the CPU build; the
  app marks the one that runs well here ("Fits this computer") but you can
  install either.
- **Filters**: search by name, style or licence (diacritics optional: "hai dang"
  finds "Hải Đăng"), language, engine, gender, Vietnamese regional accent,
  licence, installed only, favourites only.
- **Each voice**: ☆ to favourite it (favourites come first in every list),
  ▶ to play a sample, its tags, its size, its **licence badge** (hover for the
  exact licence and the credit line), and **Install**.
- **Samples play before anything is installed.** The app downloads the sample
  once, checks it against the checksum in the catalog, and keeps it in its
  temporary cache (Settings → Storage can clear it; it downloads again when
  played).

A voice is picked per project in the new-project wizard ("Voice") and in the
editor's Project panel. The wizard lists only the voices of the chosen
Text to speech engine for the target language, and changing the engine changes
the list (and the chosen voice, to that engine's recommended one): a voice of
another engine would stop the dub at Start. **Listen**, beside the list, plays
the chosen voice there. The wizard's link "Listen to and compare every voice"
opens this screen on the target language, with **Back to the new project** at
the top; the form keeps everything entered in it while you are away (in memory
until the app closes, cleared once the project is created).

### Engines

| Engine | Voices | Languages | Runs on | Download |
|---|---|---|---|---|
| **VieNeu-TTS 3.8** | 25 presets + voice cloning | Vietnamese | CPU, or an NVIDIA GPU | ~0.9 GB (CPU), ~4.6 GB (GPU, PyTorch) |
| **VieNeu v3** (the ten earlier voices) | 10 presets | Vietnamese | CPU, or an NVIDIA GPU | ~1.5 GB / ~4.5 GB |
| **ZeroTTS** | 8 presets | Vietnamese | CPU (7× faster than real time on Apple Silicon, 2.5× on a Windows desktop CPU) | ~1.5 GB |
| **Piper** (built in) | 183 voices, 2,719 speakers | 53 languages | any computer | each voice 20–120 MB |
| **Kokoro** | 54 presets | English, Japanese, Chinese, Spanish, French, Hindi, Italian, Portuguese | CPU (3× faster than real time on a Windows desktop, 5–7× on Apple Silicon) | ~0.5 GB |
| **Supertonic 3** | 10 presets, each in 31 languages | incl. Vietnamese (slow: lines about twice as long, so prefer VieNeu or ZeroTTS for Vietnamese), Korean, Japanese | CPU (3–4× faster than real time on a Windows desktop, 6× on Apple Silicon) | ~0.5 GB |
| **OpenAI** (cloud, opt-in) | 11 | many | OpenAI's servers; needs an API key | none |

Why two VieNeu engines: VieNeu's SDK 3.8 dropped four of the ten voices the app
shipped first (among them the old default, Ngọc Lan). A project keeps the voice
it was made with, so the older engine stays, and new projects default to 3.8.
Voices never change by themselves: a project whose voice its engine does not
have stops at **Start** with the voice, its engine and what to do, instead of
speaking in another voice.

**Multi-speaker Piper models** (VCTK, LibriTTS, vivos…) hold many speakers in one
download; a speaker is the voice id plus `#index` (`en_GB-vctk-medium#12`).

### Licence badges

| Badge | Meaning |
|---|---|
| Free to use | CC0, public domain, MIT, Apache-2.0, BSD: commercial use included. |
| Attribution | CC BY, CC BY-SA, GPL data: usable commercially with credit (the credit line is in the badge's tooltip). |
| Use restrictions | OpenRAIL (Supertonic): commercial use allowed except the uses it forbids; speech must be disclosed as machine-generated. |
| Non-commercial | CC BY-NC and research-only datasets. |
| Service terms | A cloud service's voices, under its terms. |
| Unclear | The source does not state a licence; the tooltip links the model card. Check it before commercial use. |

The badge is the catalog's reading of the upstream model card, not legal advice.

## How it works

- **The catalog** is a reviewed snapshot inside the app:
  `packages/node-orchestrator/src/voices/catalog/<engine>.json`, one file per
  engine, each listing its upstream sources at **pinned commits**. Every file a
  voice downloads carries its URL (at that commit, never a branch), sha256 and
  size; the installer refuses a download that does not match, discards it and
  starts over (`setup/installer.ts`, `verifyPinned`).
- **Routes** (`voices/voiceRoutes.ts`): `GET /voices` (filters: `language`,
  `engine`, `gender`, `accent`, `license`, `installed`, `favorite`, `kind`, `q`,
  `limit`, `offset`), `GET /voices/engines`, `GET /voices/:id/preview`,
  `PUT /voices/:id/favorite`, `POST /voices/:id/install` (`{ packId? }`).
  `GET /setup/voices` and `POST /setup/install-voice` are unchanged.
- **Previews** (`voices/previewCache.ts`): downloaded by the orchestrator (the
  webview only loads media from it), checked against their sha256, cached in
  `<config>/cache/voice-previews/<sha256>.<ext>`.
- **Favourites**: `<config>/voices/favorites.json`.
- **MCP**: `list_voices` (the same filters) and `install_voice`. No MCP tool can
  create a cloned voice or record consent; that is the user's, in the app.

## Maintaining the catalog

```bash
node scripts/gen-voice-catalog.mjs            # every engine
node scripts/gen-voice-catalog.mjs piper      # one engine
node scripts/check-voice-catalog.mjs          # also part of `pnpm check`
```

To move an engine to a newer upstream, change its revision in `SOURCES`
(`scripts/gen-voice-catalog.mjs`), regenerate, and review the diff, licences
first. The generator reads the dataset licence from each Piper `MODEL_CARD`;
cards that only say "See URL" or nothing land in **Unclear** until someone reads
the source and records the answer in `scripts/voice-license-overrides.json`
(`{ "<voice id>": { "category": "...", "label": "..." } }`).

Voice ids are stored in projects: **an id never changes**. A voice an engine
update removes stays in the catalog with `replacedBy` naming its stand-in, so
the run gate can suggest it.

### Samples we render ourselves

Piper and ZeroTTS host a sample of every voice upstream. VieNeu 3.8, Kokoro and
Supertonic do not, so their samples are made here, once, and published as
assets of the GitHub release **`voice-previews-1`**, a pre-release that is never
marked Latest (the updater follows Latest). Each voice says one greeting in its
own language (Vietnamese when it speaks Vietnamese), 64 kbps mono MP3, about
30-70 KB:

```bash
# an orchestrator with the engines installed (spare port, isolated home)
node scripts/render-voice-previews.mjs --orchestrator http://127.0.0.1:5291 --release voice-previews-1
gh release create voice-previews-1 --prerelease --latest=false --notes-file <notes> <tmp>/vd-voice-previews/*.mp3
node scripts/gen-voice-catalog.mjs vieneu && node scripts/gen-voice-catalog.mjs kokoro && node scripts/gen-voice-catalog.mjs supertonic
```

The render script writes `scripts/voice-previews.json` (URL, sha256, size per
voice), which the generator merges into the catalogs. `--match <regex>` with
`--force` redoes some voices (then `gh release upload --clobber` the files).
**Listen to, or at least transcribe, every new sample before publishing it.**
The first render of Kokoro's Japanese voices was 20-25 s of espeak-ng reading
each kanji by its name; Whisper large-v3 caught it, and Kokoro now phonemizes
Japanese and Chinese with misaki, the G2P its voices were trained with.

The check enforces: ids unique across engines, the id prefix naming the engine
(`vieneu38-`, `vieneu-v3-`, `zerotts-`, `kokoro-`, `supertonic-`, `openai-`;
anything else is Piper), every file and preview pinned and hashed, every voice
with a licence category and label.

### Adding an engine

1. Its catalog generator in `scripts/gen-voice-catalog.mjs` and its id prefix in
   `voiceEngineOfId` (shared `models/voices.ts`) and the check script.
2. Its `VoiceEngineInfo` in `voices/voiceCatalog.ts` (provider id, packs,
   languages, cloning, speed control, licence).
3. Its engine pack(s) (`engines/enginePackCatalog.ts`, `engines/uvRequirements.ts`,
   a launch spec in `engines/engineManager.ts`) and its provider
   (`providers/registry.ts`).
4. Its adapter in the engine server (`workers/tts-engine-neural/vd_tts_engine`).
5. Strings: `voices.engine.<id>` and `voices.engine-about.<id>` in both
   `en.json` and `vi.json`.
