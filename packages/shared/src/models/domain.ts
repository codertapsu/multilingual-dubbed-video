/**
 * Core domain types: language codes, project settings, projects, transcripts,
 * TTS/alignment segments, and subtitle styling.
 */

import type { BrandingSettings, TimeSpan } from './branding.js';
import type { DownloadSource } from './download.js';
import type { SeriesInfo, SeriesSettings } from './series.js';
import type { MediaInfo } from './media.js';
import type { BlurRegion } from './picture.js';

/**
 * A BCP-47-ish language code such as `"en"`, `"en-US"`, or `"vi-VN"`.
 *
 * Always normalize with `normalizeLanguageCode` before persisting or comparing.
 */
export type LanguageCode = string;

/** How (if at all) subtitles are emitted in the final render. */
export type SubtitleExportMode =
  | 'none'
  | 'srt-file'
  | 'vtt-file'
  | 'embedded-soft'
  | 'burned-in';

/** Whether processing stays fully local or may use cloud providers. */
export type ProcessingMode = 'local' | 'cloud-enhanced';

/**
 * What happens to the original soundtrack in the final mix:
 * - `keep`           — original kept as background, ducked under the dub.
 * - `remove`         — dub fully replaces the original audio.
 * - `replace-vocals` — separate the original into vocals + music/effects (M&E),
 *                      drop the original vocals, and mix the dub over the
 *                      full-volume M&E bed (professional dubbing approach;
 *                      requires a separation engine pack).
 */
export type OriginalAudioMode = 'keep' | 'remove' | 'replace-vocals';

/**
 * Final-render encode quality / speed trade-off. Only matters when the video is
 * re-encoded, i.e. for burned-in subtitles (every other mode copies the stream):
 * - `quality` — software x264 (medium, CRF 20); the default.
 * - `fast`    — prefer a hardware encoder; x264 when none works.
 * - `auto`    — hardware when this machine has an encoder that works, else x264.
 *
 * `fast` and `auto` resolve identically in the media worker; `auto` is the name
 * for "let the app decide", `fast` stays so settings saved before it still load.
 *
 * "Works" is proven by a 0.2 s synthetic encode per candidate, never assumed
 * from the encoder's name: the bundled ffmpeg LISTS NVENC, QSV and AMF on every
 * machine, so picking by name sent AMD/Intel-only PCs to NVENC and failed the
 * render. Hardware settings are tuned for visual parity with x264 CRF 20, and a
 * hardware encode that fails is retried once with x264.
 */
export type RenderQuality = 'quality' | 'fast' | 'auto';

/**
 * Time-stretch engine used to fit a synthesized clip to its window:
 * - `ffmpeg-atempo`  — ffmpeg `atempo` (universal default).
 * - `rubberband`     — Rubber Band R3, formant-preserving (more natural for
 *                      speech above ~1.3x; requires the rubberband engine pack).
 * - `auto`           — Rubber Band when installed and the ratio warrants it,
 *                      else atempo.
 */
export type TimeStretchEngine = 'ffmpeg-atempo' | 'rubberband' | 'auto';

/** A detected speaker mapped to a chosen TTS voice (diarized multi-voice dub). */
export interface SpeakerVoiceAssignment {
  /** Diarization speaker id (matches TranscriptSegment.speakerId). */
  speakerId: string;
  /** TTS voice id to use for this speaker. */
  voiceId: string;
}

/** Identifier for each ordered step of the dubbing pipeline. */
export type PipelineStepId =
  | 'probe-video'
  | 'extract-audio'
  | 'stt'
  | 'translation'
  | 'refine'
  | 'tts'
  | 'alignment'
  | 'audio-mix'
  | 'render';

/**
 * Visual styling for burned-in subtitles. Every field is optional: an absent
 * style (the usual case) renders the defaults described on each field.
 *
 * The burn is drawn from a generated ASS script whose canvas IS the video's
 * pixel size, so the percentages below mean the same thing at 480p and at 4K.
 * Before that, ffmpeg's built-in SRT style applied (~40 px Arial at 720p, 2.5 px
 * outline, no shadow, 25 px from the bottom): the exact strip where many Chinese
 * sources carry their own burned-in subtitles, so the two collided.
 *
 * `fontSize` / `outlineWidth` / `alignment` are the original fields, kept with
 * their original meaning so a style saved by the older renderer still renders
 * the same; prefer `sizePercent` and `position`, which win when both are set.
 */
export interface SubtitleStyle {
  /**
   * Font family. Default: the bundled Be Vietnam Pro SemiBold (OFL, full
   * Vietnamese coverage), shipped so every machine draws the same glyphs instead
   * of whatever the OS substitutes for a missing family.
   */
  fontFamily?: string;
  /**
   * Legacy size: font size on the 288-line canvas libass used for an SRT burned
   * with `force_style` (16 there ≈ ffmpeg's default). Ignored if `sizePercent`.
   */
  fontSize?: number;
  /** Text size, as the font's em height in % of the frame's shorter side. Default 5.5. */
  sizePercent?: number;
  /** Primary text color (e.g. "#FFFFFF"). Default white. */
  primaryColor?: string;
  /** Outline color (e.g. "#000000"). Default black. */
  outlineColor?: string;
  /** Legacy outline width, on the same 288-line canvas as `fontSize`. Default: 8% of the text size. */
  outlineWidth?: number;
  /** Legacy vertical placement; `position` wins when both are set. */
  alignment?: 'bottom' | 'top' | 'center';
  /**
   * Where the dub's text sits:
   * - `bottom` (default) — the conventional subtitle strip.
   * - `raised` — just above that strip, so a source's own burned-in subtitles
   *   stay readable instead of colliding with the dub's.
   * - `top`    — the top of the frame.
   */
  position?: 'bottom' | 'raised' | 'top';
  /**
   * Draw a full-width band over the bottom strip of the frame, where sources
   * burn in their own subtitles, to hide them. It covers that strip whatever
   * `position` says (with `bottom`, the dub's text sits on the band). Default false.
   *
   * `true` and `'solid'` are the same opaque band, drawn with the burned-in
   * subtitles (so only in that mode, as it always was). `'blur'` blurs the
   * band instead, the picture still showing through: a picture filter, so it
   * applies whatever the subtitle mode (the 27.8-hour series asked for it
   * over its Chinese hardsubs, claude-dubber report 2026-11-23).
   */
  coverOriginal?: boolean | 'solid' | 'blur';
  /**
   * Where the band is, full width: its top `y` and height `h`, 0–1 of the
   * frame height (the series' hardsubs sit at 76–81 %, not at the bottom
   * edge). Found by the picture detection (POST /projects/:id/picture/detect).
   * Absent: the bottom strip, `coverHeightPercent` high.
   */
  coverBand?: { y: number; h: number };
  /** How strongly a blurred band blurs, 1–10. Default 5. */
  coverStrength?: number;
  /**
   * Put the dub's burned-in subtitles inside the band, where the source's own
   * were, instead of where `position` says.
   */
  subtitlesInBand?: boolean;
  /**
   * Band opacity, 0..1. Default 1 (opaque): on a real 720p source a white
   * hardsub still ghosted through behind the dub's text at 0.9 and even 0.96.
   */
  coverOpacity?: number;
  /**
   * Band height in % of the frame height. Default 18, grown when needed so two
   * lines of the dub's text fit on it.
   */
  coverHeightPercent?: number;
}

/** All user-configurable settings for a dubbing project. */
export interface ProjectSettings {
  /** Source (spoken) language of the input video. */
  sourceLanguage: LanguageCode;
  /** Target (dubbed) language. */
  targetLanguage: LanguageCode;
  /** How subtitles are exported in the final render. */
  subtitleExportMode: SubtitleExportMode;
  /** Local-only vs cloud-enhanced processing. */
  processingMode: ProcessingMode;
  /** Selected speech-to-text provider id. */
  sttProviderId: string;
  /** Selected translation provider id. */
  translationProviderId: string;
  /** Selected text-to-speech provider id. */
  ttsProviderId: string;
  /** Optional explicit TTS voice id. */
  ttsVoiceId?: string;
  /** Optional STT model override (e.g. "small", "medium"). */
  sttModel?: string;
  /** Keep the original background audio underneath the dub. */
  includeOriginalBackgroundAudio: boolean;
  /** Duck (lower) the original audio while the dub plays. */
  duckOriginalAudio: boolean;
  /** Ducking level in decibels (negative = quieter). */
  duckingLevelDb: number;
  /**
   * How the original soundtrack is treated in the final mix. When set it takes
   * precedence over the legacy include/duck booleans (which are kept for
   * back-compat and derived from this). Defaults to `keep`.
   */
  originalAudioMode?: OriginalAudioMode;
  /** Gain applied to the synthesized TTS track in decibels. */
  ttsGainDb: number;
  /** Maximum allowed time-stretch ratio for fitting TTS to a window. */
  maxSpeedRatio: number;
  /** Allowed overflow past a segment window before it is flagged, in ms. */
  allowedOverflowMs: number;
  /**
   * Auto-fit overflowing translations: after alignment, re-translate any
   * `timing-conflict` segment with a tighter word budget, re-synthesize, and
   * re-align so it fits. Works with LLM translation providers that can shorten
   * on request (Ollama/llama.cpp/cloud); a harmless no-op for Argos. Default on
   * — set false to keep the literal translation and fix conflicts in the editor.
   */
  autoFitOverflow?: boolean;
  /**
   * Optional review-and-refine pass after translation: a context-capable LLM
   * (cloud, or the local Gemma 3 chat model) re-reads the whole transcript
   * with the character sheet and polishes each line — pronouns/terms of
   * address, terminology consistency, naturalness — returning lines unchanged
   * when they're already good. Unset/'none' skips the step. Especially useful
   * when the TRANSLATION provider is context-free (Argos, TranslateGemma).
   */
  refineProviderId?: string;
  /**
   * Re-time the SUBTITLE cues (SRT/VTT sidecars + burned-in) to when the dub
   * voice actually speaks each line inside a merged synthesis group, instead
   * of the original speech's cue times. Bounded by the group drift cap, so
   * cues move at most a few hundred ms. Default on; the canonical segment
   * timings (editor, re-runs) are never altered.
   */
  syncSubtitlesToVoice?: boolean;
  /**
   * Pause the pipeline after the transcript is translated (and refined, when
   * configured) so the user can review and hand-adjust the segments in the
   * editor BEFORE any voice is synthesized. Continuing (run again, or the
   * editor's "Continue dubbing") resumes from the TTS step. Default off.
   */
  reviewBeforeSynthesis?: boolean;
  /** Time-stretch engine for fitting clips to windows (default `auto`). */
  timeStretchEngine?: TimeStretchEngine;
  /**
   * Merge consecutive same-speaker segments into one synthesis utterance so the
   * TTS engine speaks whole thoughts with coherent intonation, instead of
   * resetting its prosody at every subtitle cue. Default on — set false to
   * synthesize strictly cue-by-cue (the pre-0.4 behavior).
   */
  synthesisGrouping?: boolean;
  /**
   * When the original soundtrack is removed, lay a very quiet pink-noise room
   * tone under the dub so pauses are never digital silence (which reads as
   * "broken audio"). Default on; ignored when the original audio is kept.
   */
  roomTone?: boolean;
  /** Final-render encode quality/speed (default `quality`). */
  renderQuality?: RenderQuality;
  /** STT model override (e.g. "large-v3-turbo"). Mirrors sttModel for clarity. */
  /** Run forced alignment for word-accurate timing (needs an alignment pack). */
  forcedAlignment?: boolean;
  /** Run speaker diarization to split the transcript per speaker. */
  diarize?: boolean;
  /**
   * How many people speak, when the user knows (2-20); absent = let speaker
   * detection decide. Known, it is far more reliable: in Phase 0 no automatic
   * setting kept one character in one speaker on a real drama clip.
   */
  diarizeSpeakers?: number;
  /**
   * Spot-check the transcript against the audio at the end of speech-to-text:
   * a minute of every half hour decoded again without context and compared
   * with the lines (pipeline/spotCheck.ts). Absent = on for videos over 2
   * hours, where a garbled stretch (a bad join: 5.3 hours of the 27.8-hour
   * series) is otherwise found only by listening; false = never; true = also
   * on shorter videos. Costs about 3-5 % of the speech-to-text time.
   */
  transcriptSpotCheck?: boolean;
  /** Per-speaker TTS voice assignments (used when diarization is on). */
  speakerVoices?: SpeakerVoiceAssignment[];
  /** Each detected speaker's gender (speaker detection writes it), for the default voices below. */
  speakerGenders?: Record<string, 'female' | 'male'>;
  /** The voice of a man / a woman with no voice of their own (cast_voices sets them). */
  defaultMaleVoiceId?: string;
  defaultFemaleVoiceId?: string;
  /**
   * How many voices the minor speakers share per gender (cast_voices rotates
   * them); absent = from the number of minor speakers, 3–6. One shared voice
   * for 59 minor characters (the user's own clone) was the 27.8-hour series'
   * casting problem (claude-dubber report, 2026-11-23).
   */
  minorVoices?: number;
  /**
   * Show subtitles for lines kept as the original song (`TranscriptSegment.song`).
   * Default off: the user's choice was "the original song plays untouched".
   */
  songSubtitles?: boolean;
  /**
   * Regions of the picture blurred, pixelated or removed (a watermark): in 0–1
   * coordinates, so they work at any resolution (models/picture.ts).
   */
  blurRegions?: BlurRegion[];
  /**
   * Phases whose engine the APP picked for this project (an installed GPU
   * engine, recommendProjectSettings) rather than the user. Speech-to-text and
   * translation fall back to the built-in engine when the picked one cannot
   * start; an engine the user chose explicitly fails loudly instead, as
   * before. The voice never falls back: voices belong to their engine, and a
   * dub whose whole sound silently changed is worse than a clear failure.
   */
  autoSelectedPhases?: ('stt' | 'translation' | 'tts')[];
  /** Optional style for burned-in subtitles. */
  burnSubtitleStyle?: SubtitleStyle;
  /** Logo and spoken greeting (models/branding.ts); absent = neither. */
  branding?: BrandingSettings;
  /**
   * Use the subtitles the source site published (Bilibili CC, or its AI
   * subtitles when the session is signed in) as the transcript instead of
   * speech-to-text, when the download carries them in this project's spoken
   * language. Much faster on a long video; timing is the site's.
   */
  useSourceSubtitles?: boolean;
}

/** Lifecycle status of a project. */
export type ProjectStatus = 'created' | 'queued' | 'running' | 'paused' | 'failed' | 'completed';

/**
 * Queue bookkeeping for a project waiting for a run slot. Persisted on
 * `project.json` (already written atomically) so the queue survives a restart
 * with no second source of truth to reconcile. `queuedAt` is the ONLY ordering
 * authority — "run next" rewrites it rather than storing a position.
 */
export interface ProjectQueueEntry {
  /** ISO-8601 enqueue time; the ordering key. */
  queuedAt: string;
  /** Retry origin, when the queued run is a retry-from-step. */
  fromStep?: PipelineStepId;
  /** Status to restore if the user cancels while still queued. */
  previousStatus: ProjectStatus;
}

/** A dubbing project: input, workspace, settings, and current status. */
export interface Project {
  /** Unique project id. */
  id: string;
  /** Human-friendly project name. */
  name: string;
  /** Absolute path to the input video file. */
  inputVideoPath: string;
  /** Absolute path to the per-project workspace directory. */
  workspaceDir: string;
  /**
   * Absolute path to the directory that receives the finished video and its
   * subtitle files: the workspace's render/ folder by default, or a folder the
   * user chose for this project (pipeline/output.ts).
   */
  outputDir: string;
  /**
   * Base name of the finished files in a folder the user chose ("My video.vi"
   * for "My video.vi.mp4"), fixed when the folder is chosen so projects that
   * share a folder never overwrite each other. Absent: "output".
   */
  outputFileName?: string;
  /** Project settings. */
  settings: ProjectSettings;
  /** Current lifecycle status. */
  status: ProjectStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
  /** Cached media probe result, if available. */
  mediaInfo?: MediaInfo;
  /** Set while `status === 'queued'` (waiting for a run slot). */
  queue?: ProjectQueueEntry;
  /** The download it was made from (site, link, uploader), when it was. */
  source?: DownloadSource;
  /** Where the finished dub was posted, newest last (POST /projects/:id/published). */
  published?: PublishedRecord[];
  /** A long video dubbed in parts: the parent analyses, each part dubs (models/series.ts). */
  series?: SeriesInfo;
  /**
   * The window of the input video this project dubs (a series part); absent =
   * the whole video. Every time inside the project (transcript, dub, mix,
   * subtitles) is relative to `startMs`.
   */
  sourceRange?: TimeSpan;
  /**
   * The files a joined project was built from, in order (New project → "Join
   * several videos"): where each starts in the joined input and how long it
   * is. The series planner prefers these boundaries as cuts; watermark
   * detection runs per file. Absent: the project has one input file.
   */
  inputFiles?: ProjectInputFile[];
}

/** One of the files a joined project's input was built from. */
export interface ProjectInputFile {
  /** Absolute path of the original file. */
  path: string;
  /** Its file name, for display ("P4.mp4"). */
  name: string;
  /** Where it starts in the joined input, in milliseconds. */
  startMs: number;
  /** Its picture's length, in milliseconds (its audio was cut to exactly this). */
  durationMs: number;
}

/** A single word with timing inside a transcript segment. */
export interface TranscriptWord {
  /** The word text (verbatim). */
  word: string;
  /** Word start time in integer milliseconds. */
  startMs: number;
  /** Word end time in integer milliseconds. */
  endMs: number;
  /** Optional confidence in the range 0..1. */
  confidence?: number;
}

/** A transcribed (and optionally translated) caption segment. */
export interface TranscriptSegment {
  /** Stable id, zero-padded e.g. "seg_0001". */
  id: string;
  /** Ordinal index of the segment (0-based). */
  index: number;
  /** Segment start time in integer milliseconds. */
  startMs: number;
  /** Segment end time in integer milliseconds. */
  endMs: number;
  /** Original transcribed text. */
  sourceText: string;
  /** Translated text, when translation has run. */
  translatedText?: string;
  /** Optional diarization speaker id. */
  speakerId?: string;
  /**
   * The speaker is only speaker detection's best guess: the line failed the
   * strict rule (enough of it inside one speaker's turns), so it took the
   * speaker it overlaps most, the nearest turn, or its nearest neighbour's.
   * Until 0.17 such lines kept no speaker: on the field report's 10-hour
   * drama that was one line in twelve, dubbed in the project voice. Shown in
   * the editor's Issues; cleared when someone sets the line's speaker by hand.
   */
  speakerLowConfidence?: true;
  /** Optional segment-level confidence in 0..1. */
  confidence?: number;
  /** Optional per-word timings. */
  words?: TranscriptWord[];
  /**
   * Per-line TTS voice override, set in the editor. Wins over the speaker's
   * assigned voice and the project voice, in a full run AND in a single-line
   * regenerate — so a re-dub no longer quietly reverts a voice the user picked.
   * Synthesis groups never merge lines that resolve to different voices.
   */
  voiceId?: string;
  /**
   * Per-line speaking-rate multiplier for TTS (1 = natural; engines that honour
   * a native rate read it faster/slower rather than time-stretching). Lines
   * with different rates never share a synthesis group.
   */
  speakingRate?: number;
  /**
   * The user wrote or approved this translation by hand. Automatic rewriting
   * passes (auto-fit shortening, review-and-refine) leave locked lines exactly
   * as they are — before this flag, re-running from alignment could silently
   * replace a hand-tuned line with a machine-shortened one.
   */
  locked?: boolean;
  /**
   * The text, voice or rate changed since this line's audio was synthesized, so
   * the clip on the timeline no longer matches it. Set by the editor's segment
   * patch; cleared whenever the line is (re-)synthesized.
   */
  ttsStale?: boolean;
  /**
   * Automatic checks this translation still FAILS after every repair the
   * pipeline tried, so a person has to look at it:
   *   - `untranslated`  the line is (still) the source text, or empty;
   *   - `wrong-script`  characters the target language cannot be spoken in
   *                     (Han, Kana, Hangul, Thai, Cyrillic… in a Vietnamese line);
   *   - `pinyin`        a romanized Chinese name left as-is ("Kunlun Xu"), which
   *                     a Vietnamese voice mispronounces instead of reading the
   *                     Hán-Việt form;
   *   - `alternatives`  a hedge like "thầy/cô" — the voice reads the slash;
   *   - `no-diacritics` four or more words without a single Vietnamese
   *                     diacritic: English, or Vietnamese with its tones lost.
   * Before this existed, all of these shipped silently (a zh→vi dub kept "Nữ
   * Th娲", "Kunlun Xu", a Thai letter in "Mุ่ง" and "thầy/cô"). Absent = clean.
   * Rewritten whenever the pipeline re-translates or reviews the line.
   */
  qualityFlags?: ('untranslated' | 'wrong-script' | 'pinyin' | 'alternatives' | 'no-diacritics')[];
  /**
   * Inside a range that looked like a transcription loop and could not be
   * repaired (pipeline/loopRepair.ts): the editor lists it as a problem and
   * get_transcript marks it, so a person checks it before it is dubbed.
   */
  loopSuspect?: true;
  /**
   * A sung line kept as the original song: no voice is made for it, the
   * original plays there, and its subtitle shows only when the project's
   * `songSubtitles` is on. Set per line (the editor, MCP `mark_song`): in the
   * 27.8-hour series' funeral scene, calls and dialogue sat between the lyrics
   * and stayed dubbed (claude-dubber report, 2026-11-23).
   */
  song?: boolean;
}

/**
 * One editor change to a segment (PATCH /projects/:id/segments). Every field
 * except `id` is optional; `null` CLEARS an override. Timing edits may move or
 * trim a line but never reorder it past a neighbour — the timeline order is
 * the order of the WAVs on disk and of every gap-aware alignment window.
 */
export interface SegmentPatch {
  /** Segment id (e.g. "seg_0001"). */
  id: string;
  /** New translation text. A real change also marks the line `locked`. */
  translatedText?: string;
  /** New start on the original timeline (ms). */
  startMs?: number;
  /** New end on the original timeline (ms). */
  endMs?: number;
  /** Voice override; `null` returns the line to the speaker/project voice. */
  voiceId?: string | null;
  /**
   * Who says the line ("SPEAKER_00"...); `null` makes it nobody's. Diarization
   * sets it; the user corrects it. Changing it re-voices the line only when its
   * voice changes with it (a speaker voice is assigned).
   */
  speakerId?: string | null;
  /** Speaking-rate override (0.5..2); `null` returns it to natural rate. */
  speakingRate?: number | null;
  /** Explicitly lock/unlock the line against automatic rewriting. */
  locked?: boolean;
}

/** A synthesized speech clip for a single segment. */
export interface TtsSegment {
  /** Id of the source transcript segment. */
  segmentId: string;
  /** The text that was synthesized. */
  text: string;
  /** Absolute path to the generated WAV file. */
  audioPath: string;
  /** Measured duration of the generated audio in integer milliseconds. */
  durationMs: number;
  /** Intended placement start in the final timeline, in ms. */
  startMs: number;
  /** Intended placement end in the final timeline, in ms. */
  endMs: number;
  /** Speed ratio applied during synthesis, if any. */
  speedRatio?: number;
}

/** Outcome classification after fitting a TTS clip into its window. */
export type AlignmentStatus = 'ok' | 'needs-review' | 'timing-conflict';

/** A TTS clip placed onto the final timeline with fit metadata. */
export interface AlignedSegment {
  /** Id of the source transcript segment. */
  segmentId: string;
  /** Placement start in the final timeline, in ms. */
  startMs: number;
  /** Placement end in the final timeline, in ms. */
  endMs: number;
  /** Absolute path to the (possibly re-timed) audio clip. */
  audioPath: string;
  /**
   * Duration of the generated clip before fitting, in ms — of the part that
   * plays (trimStartMs..trimEndMs) when the clip is trimmed.
   */
  generatedDurationMs: number;
  /** Duration actually placed on the timeline, in ms. */
  placedDurationMs: number;
  /** Applied time-stretch ratio (1.0 = unchanged). */
  speedRatio: number;
  /** Amount the clip exceeded its window, in ms (0 if it fit). */
  overflowMs: number;
  /** Alignment quality classification. */
  status: AlignmentStatus;
  /** Optional human-readable note about the alignment decision. */
  note?: string;
  /**
   * The part of the clip that plays, in ms of the clip itself (unset = all of
   * it): from just before its first sound to just after its last, or — for a
   * clip the engine botched — up to its first long silence (clipSpeech.ts).
   * Edge silence used to count as speech to fit (28–41 clips per dub stretched
   * only for it), and a 12 s clip holding one word played over the next lines.
   */
  trimStartMs?: number;
  trimEndMs?: number;
}

/** Input to create a new project. */
export interface CreateProjectInput {
  /** Project name. */
  name: string;
  /** Absolute path to the input video file. */
  inputVideoPath: string;
  /** Initial project settings. */
  settings: ProjectSettings;
  /**
   * Where to save the finished video and subtitles (an absolute folder path).
   * Absent or empty: the project's own render/ folder inside the app's data.
   */
  outputDir?: string;
  /**
   * Hard-link the video into the project instead of copying it (a download
   * the app made: no second copy on the same drive). Copied when it cannot.
   */
  linkInputVideo?: boolean;
  /** The download it was made from (site, link, uploader), for the caption. */
  source?: DownloadSource;
  /** Dub the video as a series of parts (a parent project; models/series.ts). */
  series?: SeriesSettings;
}

/** Where a finished dub was posted (POST /projects/:id/published, Mother Claude). */
export interface PublishedRecord {
  /** The post's address. */
  url: string;
  /** ISO time it was recorded. */
  at: string;
  /** The part of a series, 1-based (Phase 3); absent for a single video. */
  part?: number;
}

/**
 * PUT /projects/:id: New project sends its form again after Back. Replaces
 * the name and every setting of a project that has never run; where it saves
 * is kept. `inputVideoPath` only when the video changed (it is copied again).
 */
export interface ReviseProjectInput {
  name: string;
  settings: ProjectSettings;
  inputVideoPath?: string;
  /**
   * "Split into parts" as the form now holds it: settings replace the old
   * ones, null makes it a single video again. Absent: unchanged (a client
   * older than 0.18.0). The first Back-then-Continue kept whatever the first
   * Continue had chosen, unticking the box included.
   */
  series?: SeriesSettings | null;
}
