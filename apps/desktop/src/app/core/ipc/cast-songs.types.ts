/**
 * What the casting and song routes answer (the orchestrator's
 * voices/speakerCast.ts CastResult and songs/songRoutes.ts), as the editor
 * reads them.
 */

/** One voice the minor speakers of a gender share. */
export interface CastPoolVoiceView {
  voiceId: string;
  name: string;
  /** spare: a built-in no main speaker has; reused: also a main speaker's; picked: the user's choice. */
  from: 'spare' | 'reused' | 'picked';
  sharedWith?: string;
  speakers: string[];
  minutes: number;
}

export interface CastProposalView {
  assignments: { speakerId: string; voiceId: string; voiceName: string; by: string }[];
  defaults: { male?: string; female?: string };
  unassigned: string[];
  unconfirmed: { voiceId: string; name: string }[];
  notes: string[];
  /** Per gender, the voices its minor speakers share (absent from an older backend). */
  pools?: Partial<Record<'male' | 'female', { minorSpeakers: number; size: number; voices: CastPoolVoiceView[] }>>;
  /** Built-in voices left out of shared use: they sound like one of the user's clones. */
  soundalikes?: { voiceId: string; name: string; cloneId: string; cloneName: string; similarity: number }[];
  /** Speakers of unknown gender, with their three longest lines and talk time. */
  unknown?: { speakerId: string; minutes: number; lines: number; samples: { id: string; text: string; startMs?: number; endMs?: number }[] }[];
  /** The voices a pool may use, per gender. */
  candidates?: Partial<Record<'male' | 'female', { voiceId: string; name: string; kind: 'profile' | 'preset' }[]>>;
  /** The pool size the proposal used when one was asked for or set. */
  minorVoices?: number;
  applied?: boolean;
  refused?: boolean;
  message?: string;
}

/** Why a line looks sung. */
export type SongReason = 'traditional' | 'repeats' | 'sung';

export interface SongsView {
  /** The lines kept as the original song. */
  songs: { id: string; startMs: number; endMs: number; text: string; translatedText?: string }[];
  /** The lines that look sung, waiting for a decision. */
  suggestions: { lineId: string; startMs: number; endMs: number; text: string; reasons: SongReason[] }[];
  checkedAt?: string;
  songSubtitles: boolean;
  /** A series part: its suggestions are reviewed in the series (this project). */
  seriesParentId?: string;
}
