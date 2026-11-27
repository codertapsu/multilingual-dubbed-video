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

Once the download is done, the same screen shows **Recommended for this
computer**. These are optional engine packs that would make dubbing faster or
better on *this* machine's hardware, for example the GPU voice on a PC with an
NVIDIA card. Each one says what it buys you and how big it is. Nothing installs
unless you click its **Install** button, and you can ignore the list entirely: it
also heads **Settings → Engines** ([What an engine pack is](#what-an-engine-pack-is)).

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
4. **Save to** — where the finished video goes (see
   [Choosing where a project is saved](#choosing-where-a-project-is-saved)).
5. **Start.**

The engines start from the best ones **installed on this computer**: if you have
installed the GPU transcription engine, the local AI translator or the neural
Vietnamese voice, a new project uses them without you picking them (a choice you
saved in Settings → Processing defaults still wins). If an engine the app picked
cannot start, transcription falls back to the built-in engine and says so in the
log; an engine you chose yourself is never swapped behind your back.

Subtitles are timed for reading: each one stays up long enough to read (about 17
characters a second, at least a second, never more than 7 seconds unless the
voice is still speaking), stays up until its dub voice has finished, and long
lines break into two balanced rows.

The **Processing** screen then shows nine steps running in order, with live
progress:

| # | Step | What happens |
|---|---|---|
| 1 | Probe Video | Reads the video's format, duration and streams. |
| 2 | Extract Audio | Pulls the soundtrack out for transcription. |
| 3 | Transcribe (Speech-to-Text) | Turns the spoken audio into timed text. |
| 4 | Translate | Translates each line into the target language. |
| 5 | Review & Refine Translation | An optional AI polish pass. It finishes instantly when you have not configured a refine engine. Lines that still fail the translation checks (Chinese letters or a pinyin name in a Vietnamese line, no tone marks, "anh/chị" alternatives) get one more repair here, with the words at fault named; see [Lines that still fail the checks](#lines-that-still-fail-the-checks). |
| 6 | Synthesize Speech (Text-to-Speech) | Speaks the translated lines in the new voice. |
| 7 | Align Timing | Stretches or compresses each line so it lands on the original timing, and flags lines that could not fit. |
| 8 | Mix Audio | Mixes the new voice over the original background, optionally ducking it. |
| 9 | Render Final Video | Produces the finished file, burning in subtitles if you chose that. |

You can **retry a single step** — retrying re-runs that step and everything
after it, and skips the steps whose output already exists. That is why
re-running a project is much faster than the first run.

<a id="lines-that-still-fail-the-checks"></a>

### Lines that still fail the checks

Every translated line is checked for what a voice cannot say well: Chinese
letters or a pinyin name left in a Vietnamese line ("Kunlun" where the voice
needs "Côn Lôn"), a line with no tone marks, a "thầy/cô" that offers two words,
an untranslated line. A failing line is repaired by the review model or the
Gemma chat model during translation, and once more just before any voice is
made, this time told exactly which words are wrong and how the character sheet
writes the names in it. A line that still fails is voiced as it is and listed
in a warning on the Processing screen and under Problems in the editor.

Those lines stay flagged until you fix them, so you can let the dub finish and
look at them later:

- the project, and its part in a series, carries a **⚠ N line(s) flagged**
  chip in the Projects list and on the series screen;
- the editor says how many there are above the timeline. **Show them**, or the
  **Flagged** filter of the lines list, lists only those lines, each with what
  the checks found (Pinyin, No diacritics, Another script…); click one to go to
  it;
- rewriting a line clears its flag. A line that is right as it is gets
  **Keep as is** in the inspector: the line is locked, so no automatic pass
  rewrites it, and it no longer counts. Unlock it, or undo, to flag it again.

To fix such lines before they are voiced, tick **Stop before voicing while
lines still fail the translation checks** (New project → More options, next to
the review pause; or the editor's Project tab). The dub then stops before the
voices and says how many lines are left; fix them in the editor and press
**Continue dubbing**, which voices the lines as they are then.

Lines whose voice cannot fit their time even at the fastest speed allowed are
a warning too, with the lines named: shorten them in the editor, or allow a
faster speed.

<a id="pausing-a-dub"></a>

### Pausing a dub and continuing later

A long dub can take hours on a computer without a fast graphics card. You do
not have to wait for it:

- **Pause** (on the Processing screen, while a dub runs) stops it at once and
  keeps everything done so far. You can then close VideoDubber, or turn off the
  computer.
- **Continue dubbing** (on the same screen, or open the project from Home, where
  it shows as *Paused*) picks up where it stopped. Finished steps are not
  redone, and the step that was running keeps the part it had finished: the
  lines already translated, the voice clips already made, the parts of the
  speech already transcribed.
- **Closing VideoDubber** while a dub runs pauses it the same way. If the
  computer loses power or the app crashes mid-dub, the next start shows the
  dub as paused at the step it was in; continuing redoes only the unfinished
  part of that step.

A paused dub frees its place in the queue for other dubs. Continuing it may
make it wait for a free slot again ([RUN_QUEUE.md](RUN_QUEUE.md)).

<a id="editing-a-dub"></a>

### Editing a dub (the studio)

The **Editor** is a small dubbing studio. The video plays in the middle; every
line sits on a **timeline** underneath, in five lanes — thumbnails of the
picture, the original soundtrack's waveform, the source text, the subtitles, and
the **dub** clips the new voice actually speaks. On the left is a searchable list
of every line (filter it to **Issues**, **Changed** or **Locked** lines); on the
right, the **Line** tab edits whatever you selected and the **Project** tab holds
the engines, mix settings and the translation character sheet.

What you can do, and how:

- **Fix the translation.** Select a line and type in the Line tab. The meter
  under the box shows how fast it reads (characters per second — above about 17
  most viewers can't finish it) and how many subtitle rows it wraps to.
- **Fix the timing.** Drag a subtitle on the timeline to move it, or drag either
  edge to trim it; it snaps to the playhead and to the lines beside it (hold
  **Alt** to stop snapping). A line can't be dragged past its neighbours or
  made to overlap them. You can also type an exact time, nudge by ±10/100 ms,
  press **I** / **O** to set the start / end to the playhead, or select several
  lines and press **[** / **]** to move them together. Drag a **dub clip** to move
  the voice and its subtitles as one.
- **Change a voice.** Pick a voice in the Line tab, or **drag a voice chip onto
  any line or clip** on the timeline. Select several lines first to re-voice them
  all at once. **Speaking rate** reads a line faster or slower (a faster reading
  fits a long line more naturally than stretching the audio).
- **Who says what.** Each line can belong to a speaker (Line tab →
  **Speaker**). **Detect speakers** in the Project tab's Speakers section works
  it out from the audio in seconds (it needs the small *Speaker detection*
  engine; tick **Detect who speaks** in the new-project wizard to do it during
  the dub). Give the number of speakers when you know it. Each speaker can have
  their own voice; **Merge into…** joins two speakers who are one person.
- **Make the dub sound like the people in the video.** In the Project tab,
  **Voice from this video** copies the voice of a video with one speaker. With
  several speakers, **Copy every speaker's voice…** in the Speakers section
  makes one voice per speaker from their clearest lines and gives it to them;
  or select one person's lines (Ctrl/⌘-click adds a line) and choose **Make a
  voice from these lines…** in the Line tab. These voices need VieNeu-TTS 3.8
  and stay in the project
  ([VOICE_CLONING.md](VOICE_CLONING.md#the-voice-of-the-person-in-the-video)).
- **Hear it immediately.** Press **Space**. The preview plays your edited dub
  over the video — moved lines play from their new place, without re-rendering.
  **Final mix / Original / Dub only** switches what you hear; the sliders set the
  two volumes.
- **Re-voice what you changed.** Lines whose text, voice or rate changed are
  marked *needs re-voicing* (striped on the timeline). **Voice N changed lines**
  in the toolbar re-synthesizes them all; **Regenerate TTS** does one.
- **Undo anything** with ⌘Z / Ctrl+Z (⇧ to redo). Every change saves itself a
  moment after you make it — the toolbar says *All changes saved*.
- **Import subtitles.** Drop an `.srt` or `.vtt` file on the timeline and its
  text replaces the translations it overlaps in time (one undoable step).
- **Render.** **Render video** re-mixes the dub from the timeline and renders the
  final file; transcription and translation are reused, so it takes seconds to
  minutes, not the whole pipeline again.
- **Place burned-in subtitles.** With subtitles burned in, the Project tab has
  **Subtitle position**: **Automatic** (the default) puts the dub's subtitles
  just above the video's own when the app has found them (the **Picture**
  section, or a dub of Chinese, Japanese or Korean, which looks for them) and
  they are not covered, and at the bottom otherwise; **Bottom** always draws at
  the bottom, **Raised** higher up, **Top** at the top. There is also
  **Cover the original subtitles**, for the many videos (Chinese dramas
  especially) that have their own subtitles burned in: the **Picture** section
  finds where they are and blurs them or covers them with a solid band (see
  *Hiding a watermark and the video's own subtitles* below). **Render quality → Automatic** (the default for new projects) uses
  your graphics card's video encoder when it works, which is several times faster
  with the same picture quality, and the software encoder otherwise.

Lines you edit by hand are **locked**: the automatic passes that shorten
overflowing lines or polish the translation leave them exactly as you wrote
them. Unlock a line in the Line tab to let them work on it again.

Press **?** in the editor for the full list of keyboard shortcuts.

### Undoing a change to the lines (History)

The editor's own undo (⌘Z / Ctrl+Z) knows only what you did since you opened
it. The **History** tab, beside **Line** and **Project**, keeps every change to a
project's lines, whoever made it: you in the editor, an AI agent through MCP
(Claude replacing a looped stretch, say), or the app itself (a stretch
transcribed again, speakers detected again). Each entry says what changed, who
did it and when; **Show the changes** lists the lines before and after.
**Undo** puts those lines back as they were, speakers included, and the undo is
an entry of its own that can be undone in turn. An undo is refused, with the
reason, when its lines were changed again afterwards: undo the later changes
first, newest first. The last 200 changes of each project are kept.

### Hiding a watermark and the video's own subtitles

The Project tab's **Picture** section hides parts of the picture in the finished
video: a watermark (a channel's name or logo in a corner) and the subtitles
burned into the video. **Find them** looks at about a hundred frames, in 10 to
60 seconds, without AI and without sending anything off your computer: a mark
that stays still in a corner becomes a box, and the rows where text comes and
goes as people speak become a yellow band. Check them on the frame: drag a box
to move it and its corner to resize it, drag the band or its top and bottom
edges. **Add a box** for anything it missed.

- **How to hide it**, per box: **Blur**, **Pixelate**, or **Remove (fill in)**
  from the picture around it, which works best for small marks. A box can be
  hidden for part of the video only.
- **Hide them**, for the video's own subtitles: **Blur a band over them** (works
  with every subtitle option) or **Cover them with a solid band** (only with
  subtitles burned into the picture). **Put my subtitles inside the band** puts
  your burned-in subtitles where the original ones were.
- In a series, **Apply to every part of the series** gives every part the same
  boxes and band; each part takes its own stretch of the video.

Then **Save**: it takes effect the next time the video is rendered. **Render
again** renders only the picture, in a few minutes, keeping the voices and the
mix; in a series, **Render the finished parts again** does it for every
finished part, one after another.

**Find the watermark and blur it by itself** (in New project too) does this
without you: a single video looks for the mark when it is rendered; a series
looks once in the whole video while it is analysed and makes every part with
the box (review shows what was found). Only a mark that stands out clearly (50 %
sure or more) is hidden. What it finds becomes a box you can move or change;
removing the boxes turns the option off. The picture can change while a dub runs,
until the dub starts mixing, and always while a series is being analysed.

### Songs: keeping the original

A sung line (an opening song, a ballad in a funeral scene) is usually better
left alone. **Keep the original song** (Line tab, or several selected lines):
the line gets no dub voice and the original plays there. Dialogue between the
lyrics stays dubbed, so mark lines, not a whole scene. After speech-to-text, the
Project tab's **Songs** section lists the **Lines that look sung** (a chorus
that repeats unchanged, very slow held syllables, and lyrics in traditional
characters next to those; traditional characters alone do not count, as
speech-to-text sometimes writes plain dialogue that way). Nothing is changed
by itself: listen, then choose **Keep the
original song** or **Not a song**. **Subtitles for songs** is off by default,
so the original song plays untouched; turn it on to subtitle the song lines
too.

### Voices for minor speakers

With speakers detected, **Choose voices by gender** (Project tab → Cast) gives
each main speaker a voice of their gender and lets the minor speakers (a few
lines each) share a small pool of built-in voices: 3 to 6 per gender, by how
many minor speakers there are, or the number you set in **Voices for minor
speakers**. Two minor speakers who answer each other get different voices
where possible. Your cloned voices are never shared out to the crowd, and a
built-in voice that sounds like one of your clones is left out of the pool.
Speakers whose gender is unknown are listed with how long they speak and their
longest lines, so you can listen and choose. You see the choice before anything
changes.

For your own voice, tick **Only for one main character** under it in Voices →
My voices: casting then gives it to one main character at most, never to the
minor speakers and never as the voice of every speaker who has none.

**Lead voices** (top of the Voices screen) are the voices you want for the main
characters: up to three for men and three for women, in order, from your own
voices and the installed built-in ones. **Choose voices by gender** gives them,
in that order, to the characters heard most: your first voice for men to the
man heard most, the second to the next, and the same for women; your other
cloned voices come next, then the built-in ones. A lead voice is never the
voice of everyone who has none: new projects keep their built-in voices. A
project uses only voices of the engine it dubs with, so a cloned voice is a
lead only for projects that dub with its engine (VieNeu).

Casting counts **characters**, not speaker numbers. Speaker detection often
splits one character into several speakers (SPEAKER_15, SPEAKER_16…): when the
character sheet gives them the same name, they are ranked by their time
together and get one voice. A narrator or a system voice (its role or name in
the sheet says so: "narrator", "người dẫn truyện", "giọng hệ thống", "Hệ
thống", "旁白") gets a built-in voice, never a lead voice or one of your clones,
even when it is heard more than anyone else. A voice you swap onto a speaker
before applying is that speaker's alone: casting gives it to nobody else.

### Getting the finished file

The **Export** screen shows the finished video, its output path, and an
**Open output folder** button. **Render again** makes the video again with the
subtitle choice on that screen, without redoing any of the dubbing work. It
includes every change made since the last render: when the dub sound has
changed (lines edited in the editor, a mix setting changed), it is mixed again
first, otherwise only the video is made again. It runs like a dub, on the
progress screen: you can pause it, it waits its turn in the queue, and it uses
the project's render quality.

Every render also saves a picture from the video beside it (`output.jpg`, or
`My video.vi.jpg` in a folder you chose), taken where nobody speaks, so no
subtitle is across it: a ready thumbnail for a post.

<a id="logo-and-greeting"></a>

### Your logo and a spoken greeting

A dub can carry your channel's **logo** in a corner of the picture and a short
spoken **greeting** ("Chào mừng các bạn đến với kênh…"). Both are optional and
change nothing else about the dub.

**Make them once**, in **Settings → Logo & greeting**:

- **Add logo**: a picture file. A PNG with a transparent background looks best;
  JPG and WebP work too.
- **Add greeting from file**: a sound file, or a video whose sound is used.
  Silence at the start and end is cut, and the level is matched to the dub. At
  most 15 seconds; 2–8 seconds is ideal.
- **Or have a voice say it**: type the words, pick one of the voices installed
  on this computer, and press **Make the greeting**.

**Choose them for a project** in the **Logo & greeting** section of New
project, in the editor's Project tab, or on the Export screen (then **Render
again**). The project keeps its own copy, so changing or deleting one in
Settings never changes a project that uses it.

- **Logo**: the corner, its size (a share of the video's width, 10 % by
  default), its opacity, and when it shows: the whole video, only at the times
  you list (`0:00-0:10, 5:00-5:10`), or a few seconds every few minutes. A logo
  means the picture is encoded again, which adds a few minutes per hour of video
  (less with a graphics card, and almost nothing when subtitles are burned in
  anyway). With subtitles at the bottom, a logo in a bottom corner can cover
  them, and the form says so.
- **Greeting**: it plays only where nobody speaks (music is fine: it is turned
  down under the greeting), and never before the video starts. **In the first
  quiet moment of the opening** looks for a pause in the first 60 seconds (you
  can change the window); when there is none, it does not play at the start
  rather than talk over someone. **Also during the video** plays it again: about
  once every 10 minutes (**Automatic**), or as many times as you choose; when
  fewer quiet moments fit, it plays as many as fit. **Volume change** makes it
  louder or quieter, in dB.

In the editor's Project tab, **Where the greeting plays** lists the times the
next render uses: change a time, remove one, or **Add at the playhead**, then
**Save times** and render again.

<a id="splitting-a-long-video"></a>

### Splitting a long video into parts

A long video (an hour or more) can be dubbed as a **series** of shorter videos:
the first part is ready much sooner, a failure holds up only one part, and each
part is easier to post. In New project, tick **Dub this video as a series of
parts** under **Split into parts**.

It needs an AI to choose the cuts: the built-in Gemma chat model (Settings →
Engines; everything stays on your computer), or one you have set up: Claude (an
API key, or your Claude plan through Mother Claude), OpenAI or Gemini. **AI that
chooses the cuts** starts on the built-in model, or on the one you chose last
time; a cloud AI is used only when you choose it.

- **Length of each part**: 15–20 minutes (the default), 30–40 minutes, about an
  hour, or your own shortest and longest.
- **Repeat from the part before**: each part opens with the last few seconds of
  the one before (4 by default; 0 for none).
- **Make and dub the parts right away, without stopping to check the cuts**:
  leave it off to check them first. Even when it is on, the series stops for
  you to check when its analysis went wrong (speaker detection failed, or the
  transcript still has repeated lines from a transcription loop), and the
  series screen says why.

What happens: the whole video is transcribed once (the Processing screen says
so). The AI then picks each cut in a pause between lines, never in the middle of
a sentence (a pause where the picture changes shot, or a chapter mark from
Bilibili, counts for more: the part then ends like a scene), and gives each
part a title and a one-sentence summary, with the names the series' character
sheet uses. Every part stays within the length you chose when the pauses allow
it; the plan's notes say why a part does not. The
**series screen** (open the project from Projects) shows the plan: change a
part's start time (m:ss) or its title, then **Make the parts and start
dubbing**. **Plan again** asks the AI again.

Once the parts are made, the series screen acts on all of them at once:
**Pause all parts** and **Start every part** keep their order. A part you paused
or stopped on its own page stays paused: it shows **Paused on its own**, and
**Start every part** leaves it until you continue it from its own page. **Apply the series
settings to every part** copies the engines, the voices (per speaker too), the
subtitles and the mix to each part that is not being dubbed; **Rebuild parts from
the series transcript** gives each part its share of the series transcript again
after you fixed it (speakers detected again, loops repaired), with the character
sheet. A part already translated is kept unless you tick the box to discard its
translation.

**Part names** (in New project, with the series options) follows a template:
`{series}` is the series' name, `{n}` the part's number, `{nn}` the number with
two digits, `{total}` how many parts there are and `{title}` the part's title.
Leave it empty for the usual "<name> - Phần 01". Once the parts exist,
**Edit** on the series screen renames a part or changes its title or summary
without dubbing it again (a new title shows at the next render). **Only these
parts** (for example `23, 24` or `23-30`) rebuilds just those; parts waiting in
the queue are rebuilt in place and keep their turn, and a part being dubbed is
never touched. **Plan again** with **Keep the titles and summaries I wrote**
keeps yours on the parts that cover the same stretch.

### Joining several videos into one project

A season is often uploaded as several videos. In New project, choose **Join
several videos** and list them in the order they play. They become one project:
one transcript, one cast of voices, and one series whose part numbers run across
all of them. The app first checks that they fit together. When they do, the
picture is copied as it is, which is quick. When they differ (size, frame rate,
codec), the picture must be encoded again: the app says how long that takes and
how much space the result needs, measured on your computer, and waits for you
to agree. Each video's sound is timed to its own picture, so nothing drifts at
the joins, and the joins are preferred as places to split the parts. Joining
runs in the background (**Background work** shows it); if VideoDubber closes
meanwhile, it starts again the next time the app opens.

### Continuing a series later

For a later season of a series already dubbed, start a new project from the new
video and choose the series under **Continues a series**. The new parts keep
that series' name and part names and are numbered on from where it ended (part
49 after 48). Once the new video's speakers are detected, those who sound like a
speaker of the earlier series get that speaker's voice; the others get the
voices for minor speakers. **Use the settings of** that series copies its
engines, voices, subtitles and mix.

### The Projects page

A series is one card. Its header says how far the parts are (a bar, and how
many are done, being dubbed, waiting or failed), their total length and the
lines still flagged in them. Click the header to show or hide its parts, one
short row each; **Open series** opens the series screen. The page remembers
which series you left open.

- **Search** finds a project by its name, its file or its series, with or
  without Vietnamese accents ("xuyen khong" finds "Xuyên Không").
- **In progress**, **Needs attention** and **Finished** show only those
  projects, with how many there are. Needs attention means failed, with lines
  still flagged, or a series whose parts wait for your review. A series then
  shows just its matching parts and opens by itself.
- **Sort** puts the last changed first (the default), orders by name (Part 2
  before Part 10), or puts the newest first.
- After 30 entries, **Show more** shows the next ones.

### Everything the app works on (Activity)

The **Background work** button in the top bar lists what runs now (dubs,
renders, downloads, installs, speaker detection, transcribing a stretch again,
rebuilding parts, joining videos, finding a watermark) and the AI agents
connected in the last hour. **See all activity** opens the full list: who
started each job (you, an AI agent by name, or the app itself), how far it got,
how it ended and a log reference to quote when asking for help. It survives a
restart. Each project has its own list (**Activity** on its progress screen,
**All activity of this project** in the History tab).

Each part is a project of its own (*My video - Part 01*, *Part 02*…), listed
under its series in Projects, with its own progress, editor and Export screen. The parts share one
character sheet, so names and forms of address stay the same from part to part,
and the seconds a part repeats keep the translation the part before used. In the
finished video, each part fades in with the series name and *Part 2/5* with its
title; the repeated opening is a little darker and marked *Previously*; and the
part ends on *To be continued · Part 3* (*The end* for the last one), in the
language of the dub.

<a id="choosing-where-a-project-is-saved"></a>

### Choosing where a project is saved

Each project has its own **Save to** folder, shown on the last page of the
new-project wizard, in the studio's project panel and on the Export screen.

- **By default** the finished video is `render/output.mp4` inside the project's
  own folder in VideoDubber's data (see [Where your files live](#7-where-your-files-live)).
- **Choose folder…** picks any other folder, for example `D:\Dubs` or a folder
  in Movies. There the files are named after the project and its language,
  `My video.vi.mp4` (and `My video.vi.srt` / `.vtt` / `.jpg` beside it), so several
  projects can share one folder without overwriting each other: a second
  project with the same name becomes `My video (2).vi.mp4`.
- **Different projects can use different folders.** New projects start in the
  folder you chose last; **Use the default folder** in the wizard goes back to
  the default for new projects too.
- **Changing the folder later** moves a video that is already made (and its
  subtitle files) to the new folder. It is refused while the project is
  processing, and if a file cannot be moved (on Windows, usually because the
  video is open in a player) nothing moves: close the player and try again.
- Only the finished files go there. The working files (audio, voice clips,
  drafts) always stay in the project's folder in VideoDubber's data.

If the folder you chose last time is gone (a USB drive that is not plugged in),
the new project is saved to the default folder instead and the wizard says so;
new projects then start in the default folder until you choose one again.
In the browser version there is no folder picker: type or paste the folder's
full path.

---

## 5. Downloading a source video

The **Download** screen (in the top navigation) fetches videos from a supported
site so you can dub them. Paste one link or many (one per line), choose a quality
target, and press **Add to downloads**. A link downloads the part it points at
(the first part, or `?p=3` for P3). Tick **All parts of a multi-part video** to
add every part (P1, P2…) of a Bilibili video at once.

To download only some of the parts, paste the one link and press **Check link**:
it shows the video's title, uploader, length and its parts, with the part the
link points at ticked. Tick the others you want (hold Shift while clicking to
tick every part between two; **Select all** and **Clear** do the whole list),
then press **Download N parts**. Each part becomes a download of its own.

A Bilibili **list** link adds the videos in it: a collection (合集) or series
list, a favourites folder, or an uploader's page (`space.bilibili.com/…`). **Check
link** on one shows its videos, all ticked: untick the ones you do not want and
press **Add N videos to downloads**. A list gives at most 500 videos.

### The download list

The screen goes, from the top: the links you paste, **Sign in to download sharper
videos** (one line until you open it; it says whether you are signed in), **Dub
finished downloads**, then the list. So a long list never pushes those two out
of reach.

Every download appears in the list, newest first, with its progress. Two
download at a time and the others wait their turn. The list is kept: a download
the app could not finish (it was closed, the connection dropped) continues from
where it stopped the next time, instead of starting over. A video already in the
list is not downloaded twice: adding it again points at the one you have.

Each row is one video: its title and part (P2/4), the site, the uploader, its
length, quality and size, when it was added or finished, whether the site's own
subtitles came with it, and the projects made from it (click one to open it).
Its **link** opens the video's page in your browser, and **Copy link** puts it
on the clipboard. A finished video shows its file name; point at it for the
whole path.

- **Search** finds a video by its title, part, uploader, link or file name,
  with or without Vietnamese accents.
- **Downloading**, **Finished** and **Failed / cancelled** show only those, with
  how many there are. After 30 videos, **Show more** shows the next ones.
- **Tick all finished**, then **Dub N videos** right above the list, makes the
  projects with the choices in **Dub finished downloads**. **Retry N** tries
  every failed or cancelled download again.
- **Retry** tries a failed or cancelled download again.
- **Cancel** stops one; its partial file is removed.
- **Remove from list** takes it off the list and keeps the video file;
  **Delete video** removes the file too.
- **Use in a new project** opens New project with that video; **Open folder**
  shows it in Explorer or Finder.

When Bilibili limits requests from your connection, the download waits (20 s,
45 s, then 90 s) and tries again by itself; the list shows when.

While a dub runs, downloads give way to it. **Settings → Downloads** says how:
*Automatic* (the default) lets them run beside a dub only on a powerful machine
(an NVIDIA graphics card with 12 GB or more, or Apple Silicon with 32 GB or more,
when more than one dub at a time is allowed), and even then pauses them during
the steps that use the graphics card or write large files, and when the computer
is short of memory; elsewhere a download waits until the dub is done. You can
also choose *Pause during heavy steps*, *One task at a time* or *No limit*. A
paused download keeps what it has and continues where it stopped; the list says
why it waits. Downloads are
saved in the `downloads` folder beside your projects (`<projects folder>\..\downloads`),
and they move with the projects when you change the projects folder.

A project made from a downloaded video does not copy it: on the same drive it
gets a link to the same file, so a long video does not take twice the space,
and deleting the download later does not affect the project.

### Dubbing many downloads at once

**Dub finished downloads** makes a project for each ticked video with one of
your **presets** (see [Presets](#presets)), and can start them right away: they
dub one after another in the queue. A project whose language models are still
downloading starts by itself when they arrive.

**Dub long videos as a series of parts** (it needs an AI in Settings) splits
only the videos longer than one and a half times the longest part, 30 minutes
with 15–20-minute parts; the others are dubbed whole. The parts are made and
dubbed right away: to check a video's cuts first, dub it from New project
instead (see [Splitting a long video into parts](#splitting-a-long-video)).

### Using the subtitles the site published

Many Bilibili videos come with subtitles: the uploader's own, or Bilibili's AI
subtitles. Bilibili gives them only to a signed-in account, so a download saves
them beside the video once your Bilibili login is set (see [Raising the ceiling
with your own account](#raising-the-ceiling-with-your-own-account-optional), or
let Mother Claude pass your browser's cookies). Tick **Use the subtitles the site
published** in New project (a preset keeps it too) and the dub uses them instead
of speech-to-text, which saves the longest step on a long video. The timing is
the site's. A video without subtitles in its spoken language is transcribed as
usual.

**Supported sources: Bilibili and Douyin.** Bilibili accepts a full
`bilibili.com/video/BV…` or `av…` link, a `b23.tv` short link, festival/list
pages that carry `?bvid=`, and a bare `BV` id. Douyin accepts
`douyin.com/video/…` links, the `?modal_id=…` form that its share button
produces, `v.douyin.com` short links, and the bare numeric id. On Bilibili, a
collection, series list, favourites folder or uploader's page adds its videos
(see above).

Copy the address out of your browser's address bar. A search-results page is not
a video, and the app will tell you so.

### Using the subtitles burned into the picture

Most Chinese dramas draw their own subtitles into the picture. Those subtitles
are the script: the names are spelled right and no line is missing. Tick **Use
the subtitles burned into the picture as the transcript** (New project → More
options) and the app reads them as text on this computer instead of
transcribing the speech: each subtitle becomes a line, timed by when it shows.
It needs the **subtitle reader** (about 250 MB, installed from the same place
with one click, or from Settings → Engines & models → Speech-to-text). It reads
Chinese and English subtitles, in a few minutes per hour of video, and nothing
leaves your computer. Where a subtitle shows two languages at once (Chinese
above its English translation), only the Chinese row becomes the line; the
same holds for Japanese and Korean.

The app finds the subtitles' place in the picture by itself (or uses the band
you set under Picture). If it finds none, or cannot read enough of them, the
speech is transcribed as usual and a warning says why. Speaker detection,
translation and everything after work as for any transcript.

### Checking the transcript against the video's own subtitles

For a Chinese, Japanese or Korean video the app also checks speech-to-text
against the subtitles in the picture (New project → More options → **Check
against the video's own subtitles**, on by default for those languages; any
other video can turn it on). It reads where the subtitles sit five times a
second, without reading their text, to know when someone speaks. A line under
a subtitle is never removed as silence, and a warning lists the subtitles with
no line under them (speech that was lost: transcribe those stretches again in
the editor) and, where the subtitles follow the dialogue, lines with no
subtitle at all (maybe made up). It adds a few minutes per hour of video.

### Uploads whose drama is only their start (an advert tail)

Some "whole series free" (全集免费) uploads carry the drama only at the start.
After it, the same banner for the full version ("点击评论区蓝色链接 可免费观看完整版")
stays on the picture to the end, for hours, over a still image with songs or
over moving footage with a voice reading the advert. For a video of 20 minutes
or more, the app looks for that banner when speech-to-text starts. When it
finds one, speech-to-text, its checks and speaker detection stop where the
banner begins, a series ends there (its last part ends where the drama does),
and a warning says where. The advert's voice sometimes starts a few seconds
before its banner: lines just before it that say the advert's words
("点击评论区蓝色链接", "免费观看完整版"…) are left out too, and the dub ends where
that voice begins. The advert is never dubbed, and nothing waits for you to
confirm it. The banner's frames are also left out when the app looks for a
watermark and for the video's own subtitles, which it would otherwise find
in the banner. To dub the whole video anyway, turn off **Stop where an advert
tail begins** (New project → More options, or the project's settings in the
editor) and redo from speech-to-text.

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
button tells you whether it is still live. A paste with no `SESSDATA` in it is
refused, so a slip of the clipboard never logs you out.

If you use **Mother Claude**, it can hand VideoDubber your browser's Bilibili
cookies by itself: it saves them to a file that VideoDubber reads and deletes,
so the values never pass through the conversation. Logged out works too (up to
720p).

### Presets

A **preset** ("Mẫu lồng tiếng") saves the choices for a kind of video: the
languages, engines, voice, subtitle style and where finished videos are saved.
In **New project**, fill in the form and press **Save as preset** (the same name
replaces that preset); choose one from **Preset** to fill the form in. The
Download screen uses presets to dub many videos at once, and so can Claude
through the plugin.

With **Split into parts** on, the preset also keeps how long videos are split:
a video longer than about 1.5 × the longest part is dubbed as a series with the
preset's choices. Choosing such a preset fills in those choices; turn **Split
into parts** on for a long video. A save folder like `D:\Dubs\{series}` gives
each project its own folder, named after it.

Three presets are **built in** (under **Preset**, "Built in"): **Highest
quality** (the largest speech model, the translation re-read by the Gemma chat
model, long lines rewritten shorter, speakers detected, the best picture:
slowest), **Balanced** (what New project picks anyway) and **Lowest cost** (the
least work for the computer: a faster speech model, no re-reading, no speaker
detection, a fast render). Each says what it gains and what it costs. They only
ever use engines on your computer: if Settings choose a cloud AI, it is left
out and the preset says so; choose it in the form to use it. They change the
engines and how much work each step does, never your subtitles, voice or look.

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
| **Cloud API keys** | Optional. Only needed if you choose a cloud engine for a phase. Under the Anthropic key you choose the Claude model used for translation and review: Opus (best), Sonnet (about half the cost) or Haiku (cheapest). Claude can also use your Claude plan instead of an API key: choose **My Claude plan, through Mother Claude** and follow the steps shown there (details in [`PROVIDERS.md`](PROVIDERS.md#claude-through-mother-claude)). |
| **Claude** | Connect Claude Desktop or Claude Code so Claude can run dubs for you — see [`MCP.md`](MCP.md). |
| **Logo & greeting** | Your logos and spoken greetings, made once and chosen per project — see [Your logo and a spoken greeting](#logo-and-greeting). |
| **Engines** | Optional downloadable "engine packs" — see below. |
| **Translation packs** | Offline translation language packs. Non-English pairs go through English, so e.g. Chinese → Vietnamese needs both the Chinese → English and English → Vietnamese packs. |
| **Projects folder** | Where your projects are, and moving them all to another folder (another drive, say) with the same structure — see [Moving the projects folder](#moving-the-projects-folder). |
| **Storage** | How much disk the downloaded models, packs and caches are using, and a button to delete all of it. Your projects are never touched. Downloaded videos are listed apart, with their own **Delete finished downloads** button: the other button never deletes them. |
| **Updates** | See [Updating](#8-updating). |

### What an engine pack is

Everything VideoDubber needs to dub a video is already installed. An **engine
pack** is an *optional* higher-quality replacement for one phase — a faster
GPU-accelerated transcriber, a local LLM translator, a more natural neural voice.
Packs are downloaded on demand and only run while a project is using them, which
is why the base installer stays small.

**What installs by itself.** The installer carries everything a dub needs: the
video tools, a private Python runtime, and the transcription, offline translation
and voice services. The first-run wizard then downloads the models you chose.
None of that asks you anything beyond the wizard.

**What is recommended, and why.** The top of Settings → Engines, **Recommended
for this computer**, is worked out from what the app measured about your machine
(the graphics card and its video memory, the RAM and the processor). Each entry
says, in your language, what it would improve, and its **Install** button shows
the download size. Typical entries:

| Pack | What it gives you | Offered when |
|---|---|---|
| **VieNeu Neural TTS v3 — NVIDIA GPU** | The natural Vietnamese neural voice, about 4× faster than on the CPU (a 21-minute video took 2½ minutes instead of 9½ on an RTX 3050) | Windows with an NVIDIA card and a recent driver; 3.4–4.5 GB |
| **VieNeu Neural TTS v3** | The same voices on the processor, far more natural than the built-in Piper voice | Every other machine |
| **whisper.cpp (GPU)** + its speech model | Faster transcription on the graphics card: a 31-minute video in about a minute on an RTX 3050 | Windows with an NVIDIA card. The program (0.7 GB) plus the speech model your projects use (large-v3-turbo: 1.5 GB) |
| **llama.cpp + TranslateGemma** | Local AI translation that reads context, better than the offline language packs | Sized to your machine: the largest model that fits your video memory (or RAM) well is suggested |

Installs run in the background while the app is open, with a progress bar; you
can keep working. **Every pack is your choice.** The list recommends, it never
restricts: the full catalogue below it lets you install any pack your machine can
run at all, recommended or not. A pack that your machine cannot run is shown
disabled with the reason, rather than failing after you install it. Some packs
are hidden entirely because they are not finished — see
[What VideoDubber cannot do yet](#9-what-videodubber-cannot-do-yet).

**When you may be asked to do something** (each comes with numbered steps on
screen):

- **Windows: the Microsoft Visual C++ Runtime.** Every engine pack needs it, and a
  new Windows PC may not have it. The app installs it for you before the pack
  downloads; Windows asks once for permission (click **Yes**).
  [Details](TROUBLESHOOTING.md#engines-need-the-microsoft-visual-c-runtime).
- **GPU packs: the NVIDIA driver.** If the driver is too old for a GPU pack,
  Settings → Engines says which version is needed, and the GPU voice's
  install-time self-check gives the update steps.
  [Details](TROUBLESHOOTING.md#the-gpu-voice-pack-cannot-use-the-graphics-card).
- **Disk space.** The installer checks before downloading and says how much to
  free. [Details](TROUBLESHOOTING.md#not-enough-disk-space-for-an-engine-pack).

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
| `projects/` | One folder per dubbing project: the working files, and the finished video unless you chose another folder for it ([Save to](#choosing-where-a-project-is-saved)). Settings → **Projects folder** can move it elsewhere ([below](#moving-the-projects-folder)). |
| `models/` | The downloaded AI models — transcription models, translation packs, voices. This is usually the biggest folder. |
| `engines/` | Installed engine packs. |
| `setup.json`, `preferences.json` | Your first-run state and settings. |
| `credentials.json` | Cloud API keys, if you added any (owner-only permissions). |

Settings → **Storage** shows the total and can delete the downloaded models and
packs without touching your projects.

<a id="moving-the-projects-folder"></a>

### Moving the projects folder

Settings → **Projects folder** shows where your projects are and moves them all
somewhere else, for example to another drive with more space:

1. Press **Change folder…** and choose a folder, for example `D:\claude-dubber`.
   (In the browser version, type the folder's full path and press **Move here**.)
2. Confirm. Every project moves into that folder's `projects` folder with the same
   structure, so a finished video that was
   `C:\Users\<you>\VideoDubber\projects\proj_…\render\output.mp4` becomes
   `D:\claude-dubber\projects\proj_…\render\output.mp4`. The card shows how many
   have moved; projects cannot be changed until it has finished.
3. New projects are created there from then on, also after a restart.

Moving needs every dub paused or finished. If one project cannot move (on
Windows, usually a file of it is open in a player), the ones already moved go
back and nothing changes: close the player and try again. **Back to the default
folder** moves them back to `VideoDubber\projects`. Engine packs, models and
settings always stay in the `VideoDubber` folder, and a folder you chose with
**Save to** for a project's finished video is not moved.

### Deleting a project

The bin icon at the end of a project in the **Projects** list deletes it, after
asking. Its folder goes, working files included, and with it the finished video
when that is saved in the project's own folder (the default): copy the video out
first if you want to keep it. A finished video saved to a folder you chose with
**Save to** stays where it is. A project that is dubbing or waiting in the queue
cannot be deleted: pause it first.

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

- **Speaker detection is a first pass, not perfect.** It tells voices apart,
  not characters: the same person shouting and whispering can come out as two
  speakers, and two similar voices as one. Give the number of speakers when you
  know it (much more reliable), merge speakers in the Speakers section, and set
  any line's speaker in the Line tab.
- **Music & voice separation is a separate download, and slow without a
  graphics card.** "Replace voices, keep music & effects" needs the *Music &
  voice separation* engine (~150 MB; the wizard installs it). It takes about a
  tenth of the video's length on a graphics card or Apple Silicon, about the
  video's length on a processor alone. Without it, the original is turned down
  under the dub instead. Installed, it also takes the music out of the lines a
  voice is copied from, which makes such voices cleaner.
- **Voice cloning needs VieNeu-TTS 3.8** and speaks Vietnamese: make a voice in
  Voices → My voices from a recording or a file, after agreeing to a statement
  about whose voice it is ([VOICE_CLONING.md](VOICE_CLONING.md)).
- **Dense speech may overflow.** Lines are stretched or compressed to fit the
  original timing within limits; a line that still does not fit is flagged for
  review rather than silently overlapping the next one.
- **Translation quality varies by language pair**, especially for pairs that have
  to route through English.
- **No GPU voice on a Mac yet.** On Apple Silicon the VieNeu voice runs on the
  processor. Apple's GPU backend for PyTorch has not been validated with VieNeu,
  so no Mac GPU voice pack is offered rather than one of unknown quality.

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
- **Diagnostics** shows what the app is doing and what went wrong: its own
  health (memory, responsiveness), the graphics card and who is using it, the
  queue, the engines with their last output, disk use, recent warnings and
  errors, and crash reports. **Export support bundle** writes a zip of the logs
  and reports to attach to a bug report; it never contains API keys or site
  logins, and your home folder is written as `~`.

If the app's backend stops unexpectedly, the app restarts it by itself and the
dubs it was running continue; a banner says so while it restarts.

A dub's **warnings** appear on its Processing screen: things the app decided on
its own that the result depends on, such as a step that ran on the processor
because the graphics card was busy, speaker detection that failed (the dub then
uses one voice), transcription loops it repaired or could not repair (the lines
are marked in the editor's Problems), lines with nothing to say (left silent),
lines that still fail the translation checks or cannot fit their time, or the
video's own subtitles showing speech the transcript has no line for. A warning
about lines updates itself as you fix them, and **Dismiss** sets aside one you
have dealt with; running the step again raises it again if it still holds.

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
