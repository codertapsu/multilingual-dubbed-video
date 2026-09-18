# VideoDubber — user guide

**This is the page to read if you just installed VideoDubber (or are about to).**

You do not need Python, Node, FFmpeg, a terminal, or any developer tooling. The
installer contains everything that runs code. The only thing it does *not*
contain is the AI **models** for your languages — the app downloads those once,
on first launch, and after that it dubs fully offline.

> Building from source instead? That is a different job — see
> [`DESKTOP_APP.md`](DESKTOP_APP.md) and [`LOCAL_SETUP.md`](LOCAL_SETUP.md).

---

## 1. Which file do I download?

Go to the [**Releases**](https://github.com/codertapsu/multilingual-dubbed-video/releases)
page, open the newest release, and pick **one** file from the list under
"Assets":

| Your computer | Download this |
|---|---|
| **Mac with Apple Silicon** (M1, M2, M3, M4 …) | `VideoDubber_<version>_aarch64.dmg` |
| **Windows 10 or 11, 64-bit** | `VideoDubber_<version>_x64-setup.exe` |

**Not sure which Mac you have?** Click the Apple menu → **About This Mac**. If
the chip line says "Apple M-something" you have Apple Silicon. If it says
"Intel", VideoDubber does not have a build for your Mac — see
[Machines that are not supported](#machines-that-are-not-supported).

### Files you should ignore

A release also contains files that are **not** installers. They exist so the app
can update itself, and downloading them by hand will not get you a working
install:

| File | What it really is |
|---|---|
| `…_aarch64.app.tar.gz` (+ `.sig`) | The macOS auto-update payload. Expanding it leaves a loose app in your Downloads folder that can never update itself. **Do not download this.** |
| `…_x64-setup.exe.sig` | A signature file for the updater, not a program. |
| `latest.json` | The update manifest the app reads. |
| `…_x64_en-US.msi` (+ `.sig`) | A per-machine Windows installer for IT-managed deployment. It needs an administrator prompt and installs into *Program Files*. Pick this **only** if you are deploying VideoDubber for other people; otherwise use the `-setup.exe`. Do not install both — you will end up with two copies of a ~1 GB app. |

The `.dmg` is roughly 300 MB and the Windows `-setup.exe` roughly 250 MB.

---

## 2. First launch

### On macOS

The macOS builds are signed with an Apple Developer ID and notarized by Apple,
so there is **no security warning** and nothing to do in Terminal:

1. Double-click the `.dmg` you downloaded.
2. Drag **VideoDubber** onto the **Applications** folder shown in the window.
3. Eject the disk image, open **Applications**, and double-click **VideoDubber**.

Opening the app *from inside the disk image* also appears to work, but it is not
installed and will not update — always drag it to Applications first.

### On Windows

**The Windows builds are not code-signed.** There is no Authenticode certificate
for this project today, so Windows will warn you about it. This is expected, and
it is what you will see:

1. Double-click `VideoDubber_<version>_x64-setup.exe`.
2. A full-screen blue panel appears: **"Windows protected your PC"**, with
   *Publisher: Unknown publisher*. The only button you can see is **Don't run**.
3. Click the small **More info** text just above the button. (It is a link, not
   a button — it is easy to miss.)
4. A new button appears: **Run anyway**. Click it.
5. The installer runs. It installs for the current user only, into your own
   account — it does not ask for an administrator password.

You only go through this once per version you install by hand. Updates that the
app installs for itself do not show the panel again.

> **If the app or one of its files disappears after installing**, your antivirus
> removed it. VideoDubber trips heuristic scanners because it is a large unsigned
> download that starts several local servers and downloads further programs into
> your user folder. See
> [Antivirus removed something](#antivirus-removed-something) below.

---

## 3. The first-run setup wizard

The first time you open VideoDubber it shows a four-step **Welcome** wizard
instead of the projects list. This runs once.

1. **Welcome** — explains that a one-time download is about to happen.
2. **Self-check** — the app tests itself: that its own background services
   answer, that its bundled video tools run, that the network is reachable, and
   that there is enough free disk space. Each line is marked ok / warning /
   failed with a suggested fix, and **Re-check** re-runs them. A warning is not
   fatal — you can continue — but a failing network or disk check will make the
   next step fail.
3. **Choose** — pick your **source language** (what the video is in), your
   **target language** (what you want it dubbed into), a **transcription model**,
   and a **voice** for the target language. The model list marks one
   *Recommended* for your machine and shows each download size; bigger models
   transcribe more accurately and run more slowly.
4. **Download** — the models download with a progress bar and a live log. Keep
   the window open. If the connection drops, **Retry download** picks up the
   models that are still missing rather than starting over.

When it finishes, click **Finish & start dubbing**. You will not see the wizard
again; you can add more languages, voices and models later from **Settings**.

Budget **300–500 MB** for a typical first download (one transcription model, one
translation pair, one voice) and several minutes on a normal connection.

---

## 4. Dubbing your first video

Click **+ New project** and work through the wizard:

1. **Pick a video** from your computer. (Or get one from the web first — see
   [Downloading a source video](#5-downloading-a-source-video).)
2. **Source and target language.** These default to what you chose during setup.
3. **Subtitle mode** — none, a separate `.srt` or `.vtt` file next to the video,
   a soft subtitle track inside the video that players can switch on and off, or
   subtitles burned permanently into the picture.
4. **Start.**

The **Processing** screen then shows nine steps running in order, with live
progress:

| # | Step | What happens |
|---|---|---|
| 1 | Probe Video | Reads the video's format, duration and streams. |
| 2 | Extract Audio | Pulls the soundtrack out for transcription. |
| 3 | Transcribe (Speech-to-Text) | Turns the spoken audio into timed text. |
| 4 | Translate | Translates each line into the target language. |
| 5 | Review & Refine Translation | An optional AI polish pass. It finishes instantly when you have not configured a refine engine. |
| 6 | Synthesize Speech (Text-to-Speech) | Speaks the translated lines in the new voice. |
| 7 | Align Timing | Stretches or compresses each line so it lands on the original timing, and flags lines that could not fit. |
| 8 | Mix Audio | Mixes the new voice over the original background, optionally ducking it. |
| 9 | Render Final Video | Produces the finished file, burning in subtitles if you chose that. |

You can **cancel** at any point, and **retry a single step** — retrying re-runs
that step and everything after it, and skips the steps whose output already
exists. That is why re-running a project is much faster than the first run.

### Fixing the translation

The **Editor** screen shows the original transcript and the translation side by
side. Edit any line, then use **Regenerate TTS** on that row to re-voice just
that line — you never have to re-run the whole video. Each row also has a
**voice** dropdown, which is the simplest way to give a second speaker a
different voice (VideoDubber does not yet detect speakers on its own).

### Getting the finished file

The **Export** screen shows the finished video, its output path, and an
**Open output folder** button. **Re-render** produces the video again with a
different subtitle treatment without redoing any of the dubbing work.

---

## 5. Downloading a source video

The **Download** screen (in the top navigation) fetches a video from a supported
site so you can dub it. Paste a link, choose a quality target, and download.

**Supported sources: Bilibili and Douyin.** Bilibili accepts a full
`bilibili.com/video/BV…` or `av…` link, a `b23.tv` short link, festival/list
pages that carry `?bvid=`, and a bare `BV` id. Douyin accepts
`douyin.com/video/…` links, the `?modal_id=…` form that its share button
produces, `v.douyin.com` short links, and the bare numeric id.

Copy the address out of your browser's address bar. A search-results page or a
user profile is not a video, and the app will tell you so.

### Why the quality is lower than what the site shows

VideoDubber never signs in on your behalf, and these sites cap what an anonymous
visitor can fetch. On Bilibili the practical ceiling is **720p** for most videos
(360p for some old uploads). The quality control tells you what the link you
pasted will actually give you.

Bilibili serves the same video through two different pipes, gated differently,
and VideoDubber uses both: the adaptive pipe reaches 1080p and above but is
capped at 480p anonymously, while the older single-file pipe serves 720p to that
same anonymous viewer. You pick a target — Best available, 4K, 2K, 1080p, 720p,
480p, 360p — and the download takes the closest quality at or below your target
across both pipes. Asking for 1080p on a video capped at 720p gets you 720p.

### Raising the ceiling with your own account (optional)

Under **Download source video → Source account** you can paste your own Bilibili
`SESSDATA` cookie, which unlocks 1080p (1080p+ and 4K additionally need a VIP
account). It lives on that screen rather than in Settings because it affects
nothing else.

**Understand what you are storing.** `SESSDATA` is a live session key: anyone who
gets it can act as you on Bilibili. VideoDubber writes it to
`<your VideoDubber folder>/bilibili-session.json` as **plain text**, readable
only by your user account, sends it only to bilibili.com, and lets you remove it
from that screen at any time. Logging out on Bilibili also invalidates it.

An **expired** cookie does not produce an error — it silently drops you back to
the anonymous ceiling while the screen still shows a saved value. The **Check**
button tells you whether it is still live.

---

## 6. Settings

> There is also a **Help** screen in the top navigation, separate from Settings:
> it re-runs the setup self-check and produces a redacted "Copy diagnostics"
> bundle for bug reports. See [When something goes wrong](#10-when-something-goes-wrong).

| Section | What it is for |
|---|---|
| **Language** | The app's own display language — English or Tiếng Việt. It changes immediately and is remembered. |
| **This computer** | What VideoDubber measured about your machine: the transcription model it recommends, and how many dubs it will run at once. You can lower that limit or pause the queue. |
| **Processing defaults** | Which engine each phase of a *new* project uses. You can still change them per project. |
| **Cloud API keys** | Optional. Only needed if you choose a cloud engine for a phase. |
| **Engines** | Optional downloadable "engine packs" — see below. |
| **Translation packs** | Offline translation language packs. Non-English pairs go through English, so e.g. Chinese → Vietnamese needs both the Chinese → English and English → Vietnamese packs. |
| **Storage** | How much disk the downloaded models, packs and caches are using, and a button to delete all of it. Your projects are never touched. |
| **Updates** | See [Updating](#8-updating). |

### What an engine pack is

Everything VideoDubber needs to dub a video is already installed. An **engine
pack** is an *optional* higher-quality replacement for one phase — a faster
GPU-accelerated transcriber, a local LLM translator, a more natural neural voice.
Packs are downloaded on demand and only run while a project is using them, which
is why the base installer stays small.

Settings → Engines only lists packs that can actually run on your machine, and
marks the ones that suit it "recommended". A pack that your machine cannot run is
shown disabled with the reason, rather than failing after you install it. Some
packs are hidden entirely because they are not finished — see
[What VideoDubber cannot do yet](#9-what-videodubber-cannot-do-yet).

The one most Vietnamese users want is the neural Vietnamese voice: see
[`VIENEU_TTS_SETUP.md`](VIENEU_TTS_SETUP.md).

### Cloud engines and what leaves your computer

VideoDubber is offline by default and nothing leaves your machine unless you
explicitly select a cloud engine for a phase. If you do, that phase's data — the
audio for cloud speech-to-text, the transcript text for cloud translation — is
sent to that service. Your API keys are stored only on this computer, with
owner-only permissions, and are sent only to the service they belong to. Full
detail: [`PROVIDERS.md`](PROVIDERS.md).

---

## 7. Where your files live

Everything VideoDubber creates lives in **one folder** in your home directory:

| | Location |
|---|---|
| **macOS** | `~/VideoDubber` (i.e. `/Users/<you>/VideoDubber`) |
| **Windows** | `%USERPROFILE%\VideoDubber` (i.e. `C:\Users\<you>\VideoDubber`) |

Inside it:

| Folder / file | Contents |
|---|---|
| `projects/` | One folder per dubbing project: the working files and the finished video. |
| `models/` | The downloaded AI models — transcription models, translation packs, voices. This is usually the biggest folder. |
| `engines/` | Installed engine packs. |
| `setup.json`, `preferences.json` | Your first-run state and settings. |
| `credentials.json` | Cloud API keys, if you added any (owner-only permissions). |

Settings → **Storage** shows the total and can delete the downloaded models and
packs without touching your projects.

---

## 8. Updating

**VideoDubber updates itself.** Since v0.2.0 the app checks GitHub for a newer
release, verifies the update's signature on your own machine before installing
it, and installs it in place — you do not download installers by hand, and on
Windows you do not see the SmartScreen panel again.

Open **Settings → Updates** to:

- turn **Automatically install updates** on or off (when on, it checks on launch
  and installs in the background);
- **Check for updates** now and see the release notes;
- see which version you have.

How it works, including how to go back to an older version:
[`AUTOUPDATE.md`](AUTOUPDATE.md).

---

## 9. What VideoDubber cannot do yet

Stated plainly, so you are not hunting for a feature that is not there:

- **No speaker detection.** Every line is dubbed in one voice. You can assign a
  different voice per line by hand in the Editor, but the app will not work out
  who is speaking. (The diarization engine pack is not built — it is hidden from
  Settings → Engines rather than shipped broken.)
- **No music/voice separation.** "Keep the music, replace the speech" is not
  available; the background is turned *down* under the new voice, not separated
  out. (Same story: the pack is not built.)
- **No voice cloning**, deliberately — see the disclaimer in the
  [README](../README.md#legal--usage-disclaimer).
- **Dense speech may overflow.** Lines are stretched or compressed to fit the
  original timing within limits; a line that still does not fit is flagged for
  review rather than silently overlapping the next one.
- **Translation quality varies by language pair**, especially for pairs that have
  to route through English.

### Machines that are not supported

- **Intel Macs.** Only an Apple Silicon build is produced. There is no
  `x64.dmg`, and the Apple Silicon `.dmg` will not run on an Intel Mac.
- **Linux.** No `.deb` and no `.AppImage` are built today. Linux is
  build-from-source only ([`LOCAL_SETUP.md`](LOCAL_SETUP.md)).
- **macOS 13.** The app requires **macOS 14.0 or later**. Some of the components
  it bundles are published only for macOS 14 and above, so 13.x cannot be
  supported.
- **macOS 14 or 15, on a release up to and including 0.9.0.** Those builds were
  made with an interpreter compiled for macOS 26, so the transcription,
  translation and voice services inside them refuse to start on anything older.
  If the app opens but every service reports unavailable, this is why. It is
  fixed in the build, but **no published release carries the fix yet** — the next
  release will.

---

## 10. When something goes wrong

### The app opens but everything says "unavailable"

VideoDubber's background services did not start. Reopening the app usually fixes
it — this is most common the first time you open it after installing or updating,
and the app offers you that restart itself. If it persists on Windows, check
[Antivirus removed something](#antivirus-removed-something); on an older Mac see
[Machines that are not supported](#machines-that-are-not-supported).

### Antivirus removed something

Windows Defender or a third-party antivirus (Kaspersky, Avast and Bitdefender are
common) can quarantine parts of VideoDubber. The symptoms are indistinguishable
from a broken app: the installer "finishes" but nothing runs, or dubbing works
until the voice step and then fails, or an engine pack download disappears.

If you trust this build, add exclusions for both folders VideoDubber uses:

- `%LOCALAPPDATA%\VideoDubber` (the installed program), and
- `%USERPROFILE%\VideoDubber` (your projects, models and engine packs).

In Windows Security: **Virus & threat protection** → *Manage settings* →
*Exclusions* → **Add an exclusion** → **Folder**.

### The dub is silent, or speaks the wrong language

The app only uses a voice that matches the target language — it will never read
Vietnamese aloud with an English system voice. If no voice for that language is
available, those lines are written as **silence** and flagged, rather than
failing the whole dub. Fix it by installing a voice for the target language
(Settings, or the first-run wizard) and regenerating those lines in the Editor.

### A download or model install failed partway

Retry it. Both the first-run download and the engine-pack installer are safe to
re-run and pick up only what is missing.

### Something else

The app shows a red banner with an error **code** (for example
`WORKER_TIMEOUT`), a plain-language explanation, and a suggested fix.
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) has a section per code.

Before filing anything, open **Help** from the top navigation:

- **Check my setup** re-runs the same self-check the first-run wizard did — the
  built-in services, the video tools, disk space and network — so you can see
  which part is actually unhappy.
- **Copy diagnostics** puts a redacted, paste-ready summary of your machine and
  the app's state on the clipboard. A diagnostic taken *while* something is
  broken is far more useful than a description of it afterwards.

If it is reproducible, open an
[issue](https://github.com/codertapsu/multilingual-dubbed-video/issues), paste
the diagnostics, and include the error code and message exactly as shown.

---

## 11. Uninstalling

**macOS** — drag **VideoDubber** from Applications to the Trash.

**Windows** — *Settings → Apps → Installed apps → VideoDubber → Uninstall* (or
run the uninstaller from the Start menu entry).

Either way, **your `VideoDubber` folder is left in place on purpose** — projects,
models and engine packs all survive, so reinstalling does not repeat the
first-run download. That folder can easily reach several GB.

To reclaim that space as well, delete the whole `VideoDubber` folder from your
home directory ([where it lives](#7-where-your-files-live)) *after* uninstalling.
Deleting it removes your dubbed projects too, and the next install will run the
first-run download again.

To free space **without** uninstalling, use Settings → **Storage** → *Delete all
downloaded data*, which removes models, engine packs and caches but keeps your
projects.
