/**
 * Speakers of a dub: who says each line, and the voice that speaks it.
 *
 * Speaker ids are "SPEAKER_00", "SPEAKER_01"... everywhere: diarization writes
 * them, the user may set them by hand, and the translation prompts read them in
 * that form (translationContext.ts switches on its pronoun plan when it sees
 * "SPEAKER_00: ..."), so there is one format and it is checked.
 *
 * Pure; the orchestrator (patches, settings, synthesis) and the editor (its
 * optimistic view) share it so they can never disagree about which voice speaks
 * a line.
 */

/** A speaker id as diarization writes it. */
export const SPEAKER_ID_RE = /^SPEAKER_\d{2,3}$/;

export function isSpeakerId(id: unknown): id is string {
  return typeof id === 'string' && SPEAKER_ID_RE.test(id);
}

/** 1 for SPEAKER_00: what people see ("Speaker 1"). */
export function speakerNumber(id: string): number {
  const n = Number(id.slice('SPEAKER_'.length));
  return Number.isFinite(n) ? n + 1 : 0;
}

/** The lowest free speaker id ("SPEAKER_02" when 00 and 01 are taken). */
export function nextSpeakerId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 0; n < 1000; n++) {
    const id = `SPEAKER_${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  return 'SPEAKER_999';
}

/** The settings a line's voice depends on. */
export interface LineVoiceSettings {
  ttsVoiceId?: string;
  speakerVoices?: readonly { speakerId: string; voiceId: string }[];
}

/**
 * The voice that speaks a line: its own (set in the editor), else its
 * speaker's, else the project's.
 */
export function voiceForLine(line: { voiceId?: string; speakerId?: string }, settings: LineVoiceSettings): string | undefined {
  if (line.voiceId) return line.voiceId;
  if (line.speakerId) {
    const assigned = settings.speakerVoices?.find((v) => v.speakerId === line.speakerId)?.voiceId;
    if (assigned) return assigned;
  }
  return settings.ttsVoiceId;
}

/**
 * The speaker → voice table a client may set: valid ids only, one entry per
 * speaker (the last wins), at most 100. Undefined when nothing valid is left.
 */
export function sanitizeSpeakerVoices(input: unknown): { speakerId: string; voiceId: string }[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const bySpeaker = new Map<string, string>();
  for (const item of input.slice(0, 1000)) {
    const speakerId = (item as { speakerId?: unknown } | null)?.speakerId;
    const voiceId = (item as { voiceId?: unknown } | null)?.voiceId;
    if (!isSpeakerId(speakerId) || typeof voiceId !== 'string') continue;
    const voice = voiceId.trim();
    if (voice === '' || voice.length > 200) continue;
    bySpeaker.set(speakerId, voice);
  }
  const out = [...bySpeaker].slice(0, 100).map(([speakerId, voiceId]) => ({ speakerId, voiceId }));
  return out.length > 0 ? out.sort((a, b) => a.speakerId.localeCompare(b.speakerId)) : undefined;
}

/** One speaker of a transcript, for lists. */
export interface SpeakerSummary {
  speakerId: string;
  /** Lines said. */
  lines: number;
  /** Their total length. */
  speechMs: number;
}

/** Every speaker in `segments`, most speech first. */
export function summarizeSpeakers(segments: readonly { speakerId?: string; startMs: number; endMs: number }[]): SpeakerSummary[] {
  const by = new Map<string, SpeakerSummary>();
  for (const s of segments) {
    if (!isSpeakerId(s.speakerId)) continue;
    const e = by.get(s.speakerId) ?? { speakerId: s.speakerId, lines: 0, speechMs: 0 };
    e.lines += 1;
    e.speechMs += Math.max(0, s.endMs - s.startMs);
    by.set(s.speakerId, e);
  }
  return [...by.values()].sort((a, b) => b.speechMs - a.speechMs || a.speakerId.localeCompare(b.speakerId));
}
