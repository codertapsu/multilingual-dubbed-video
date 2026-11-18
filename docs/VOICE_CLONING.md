# Voice cloning

VideoDubber can make a dubbing voice from a few seconds of someone speaking: your
own voice, or the voice of someone who agreed to it. The voice is made and kept
on your computer; nothing is uploaded anywhere.

> This page explains how the feature works and the commitments it asks for. It
> is not legal advice. Laws on synthetic voices differ by country and change;
> if you publish dubs commercially, check what applies to you.

## Making a voice

**Voices → My voices → + Make a cloned voice.** Four steps:

1. **Rights.** Say whose voice it is (yours, or someone who agreed), read the
   statement, and tick that you agree. Nothing else is enabled before that.
2. **Source.** Record in the app (pick the microphone, read the suggested text
   or say anything for 10–15 seconds), or import an audio or video file (a phone
   memo, MP3, M4A, WAV, a video…; the first ten minutes are read).
3. **Check.** The waveform shows where the speech is (blue) and the part the
   voice is made from (green, up to 8 seconds). Move it, listen to it, and read
   what the app measured (below). Cleaning background noise is on by default.
4. **Save.** Name the voice, add a note, and choose whether to keep the
   recording (recommended: it lets the voice be made again for another engine
   later). The new voice then speaks a sentence so you can hear it.

The voice appears in **My voices** and in every voice picker (wizard, editor)
of projects whose voice engine is **VieNeu-TTS 3.8**. Rename or delete it from
My voices; deleting removes the recording, the voice data and the statement.

## The voice of the person in the video

The dub can sound like the person speaking in the original video. Both ways
need the project's audio, so the dub must have reached speech-to-text once.

- **One speaker** (a vlog, a lecture, narration): in the editor, **Project tab →
  Voice from this video → Copy the speaker's voice…**. The app reads the video's
  own audio and proposes its clearest 8 seconds; the Check step is the same as
  above. When the voice is made, it is proposed as the project's voice; it takes
  effect when you re-dub from text-to-speech (nothing before that changes).
- **Several speakers, automatically:** when the lines have speakers (speaker
  detection, or set by hand in the Line tab), **Project tab → Speakers → Copy
  every speaker's voice…** asks for the statement once and makes one voice per
  speaker from that speaker's longest lines that nobody talks over (up to 60
  seconds), then gives each voice to its speaker, so all of their lines speak
  with it. A speaker with less than 3 seconds of clear speech is skipped and
  named; they keep the project voice. **Copy their voice…** on one speaker does
  the same with the Check step, to choose the part yourself.
- **Several speakers, by hand:** select one person's lines (in the line list or
  on the timeline: Ctrl/⌘-click adds a line, Shift-click a range), then in the
  **Line tab** choose **Make a voice from these lines…**. Pick lines of that
  person only (lines of two people make a mixed voice), about 10 seconds of
  clear speech in total; the app joins them with a short pause, at most 60
  seconds. When those lines all belong to one speaker the voice becomes that
  speaker's, otherwise it is given to those lines; either way it needs the
  project to speak with VieNeu-TTS 3.8. Then **re-voice** them to hear it.

The statement for these voices is: *I have the right to use the voices in this
video for its dub* (and the same commitments as below). Such a voice **stays in
its project**: it is not in My voices, it cannot be exported, and it is deleted
with the project. The Project tab lists them, with a play button and Delete.

The source video may be in any language: the voice is copied, then speaks the
dub's language. Accent carries over in part (a voice cloned from English speech
speaks Vietnamese with a hint of it); choose lines without music or laughter
under them.

## A good recording

| What the app says | What it means | What to do |
|---|---|---|
| Too little speech | Under 3 seconds of speech in the chosen part: the engine cannot make a voice from it. | Choose a longer part, or record again and speak for about 10 seconds. |
| A little short | Under about 5 seconds. | 6–8 seconds of speech gives a closer voice. |
| Quiet | The speech is very soft. | Speak closer to the microphone or raise its volume. |
| Distorted (too loud) | Many samples hit the maximum (clipping). | Record a little further away, or lower the microphone volume. |
| Noisy background | The background between words is loud compared with the voice. | Record somewhere quieter; noise cleaning stays on. |
| Contains a long pause | Over 1.5 s of silence inside the chosen part. | Move the window to continuous speech. |

Only "too little speech" stops you; everything else is a warning and you
decide. Tips: one speaker only, no music, a normal speaking pace, the language
you will dub into if you can (Vietnamese for VieNeu), and a quiet room.

Recording permissions:

- **Windows:** the first recording asks for the microphone. If it was refused:
  Settings → Privacy & security → Microphone → turn on "Let desktop apps access
  your microphone".
- **macOS:** the first recording asks once. If it was refused: System Settings →
  Privacy & Security → Microphone → turn on VideoDubber, then reopen the app.

## Engines

| Engine | Clones? | Reference it uses | Notes |
|---|---|---|---|
| **VieNeu-TTS 3.8** | Yes | 3–8 s of speech, no transcript | Vietnamese (with English code-switching). CPU, or NVIDIA GPU. |
| VieNeu v3 (ten earlier voices) | No | – | Preset voices only. |
| Piper, Kokoro, Supertonic, ZeroTTS | No | – | Preset voices only. |
| OpenAI | No | – | Cloud preset voices. |

A cloned voice is stored per engine: making it for an engine turns the kept
recording into that engine's voice data (an *enrollment*), automatically, the
first time a project uses it there. A voice saved **without** its recording can
only be used with the engine it was made for.

Technically (for the curious): VieNeu 3.8 turns the reference into a
192-number speaker embedding plus reference codec codes
(`workers/tts-engine-neural/vd_tts_engine/engine38.py`), saved as an `.npz` file
that is never unpickled. The voice is identified by a fingerprint of that data,
not by its name: renaming keeps every synthesized line, re-recording redoes them.

## Consent

Before a voice is made you agree to a statement such as:

> *Tôi xác nhận đây là giọng của chính tôi. Tôi sẽ không dùng giọng này để mạo
> danh, lừa đảo hay gây hiểu lầm, và sẽ ghi rõ giọng đọc do AI tạo khi đăng
> công khai.*
>
> *I confirm this is my own voice. I will not use it to impersonate, defraud or
> mislead anyone, and I will say that the voice is AI-generated when I publish.*

- The statement is stored **word for word** with the voice, in the language it
  was shown in, with its version and the time you agreed. If the statement
  changes, the app asks again.
- It is **your commitment, not identity verification**: the app cannot check
  whose voice a recording is, and does not pretend to.
- **Local only:** recordings, voice data and statements never leave the
  computer. The only network use is downloading engines and samples.
- **Agents cannot make voices.** The MCP server (Claude) can list and use your
  voices but has no way to create one or to agree to a statement; that is done
  by a person in the app.
- **Every rendered video is labelled** as containing AI-generated speech
  (container metadata, `comment` tag). When you publish, say so as well: the
  voice licences ask for it (VieNeu, Supertonic, ZeroTTS), Vietnam's Law on
  Artificial Intelligence (in force since 2026-03-01) asks for marks and notices
  on AI-generated media, and the EU AI Act's transparency duties apply to
  synthetic audio.

## Files

| Where | What |
|---|---|
| `<data>/voices/profiles/<id>/` | A voice: `profile.json` (with the statement), `reference.wav` (if kept), `vieneu.npz` (voice data), `preview.wav` |
| `<project>/voices/<id>/` | A voice private to one project (made from its video), deleted with the project |
| `<data>/voices/work/` | Recordings being checked; removed after a day |

`<data>` is the app's data folder (Settings → Storage shows it). API:
`docs/VOICES.md` lists the routes; cloning's are under `/voice-profiles`, and
`POST /projects/:id/voices/analyze { segmentIds? }` prepares a project's own
speech (`voices/sourceVoices.ts`). For such an analysis the server, not the
client, decides the voice's project, its source (`project-lines` or
`project-speaker`) and the statement it needs.
