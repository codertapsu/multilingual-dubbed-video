/**
 * Line edits as the editor applies them before the server answers, and as
 * patches for the server. Framework-free, so the rules are unit-tested
 * (line-fields.spec.ts): this view must match what the server does with the
 * same patch (workspace/timelineEdit.ts), or a line shows as needing a new
 * voice that the server would not re-voice, and the other way round.
 */
import type { SegmentPatch, TimelineSegment } from '../../../core/models';
import type { LineFields } from './history';

/**
 * Apply line fields to a copy of the segments (null clears an override).
 * `voiceOf` (the shared voiceForLine with the project's settings) decides, as
 * on the server, whether a new speaker means a new voice to record.
 */
export function applyFields(
  segs: readonly TimelineSegment[],
  items: readonly { id: string; fields: LineFields }[],
  voiceOf?: (line: TimelineSegment) => string | undefined,
): TimelineSegment[] {
  if (items.length === 0) return segs as TimelineSegment[];
  const byId = new Map(items.map((i) => [i.id, i.fields]));
  return segs.map((s) => {
    const f = byId.get(s.id);
    if (!f) return s;
    const next: TimelineSegment = { ...s };
    if (f.translatedText !== undefined && f.translatedText !== s.translatedText) {
      next.translatedText = f.translatedText;
      next.ttsStale = true;
    }
    if (f.startMs !== undefined) next.startMs = f.startMs;
    if (f.endMs !== undefined) next.endMs = f.endMs;
    if (f.voiceId !== undefined) {
      if (f.voiceId === null) delete next.voiceId;
      else next.voiceId = f.voiceId;
      if ((f.voiceId ?? undefined) !== s.voiceId) next.ttsStale = true;
    }
    if (f.speakingRate !== undefined) {
      if (f.speakingRate === null || Math.abs(f.speakingRate - 1) < 1e-3) delete next.speakingRate;
      else next.speakingRate = f.speakingRate;
      if ((next.speakingRate ?? undefined) !== s.speakingRate) next.ttsStale = true;
    }
    if (f.locked !== undefined) {
      if (f.locked) next.locked = true;
      else delete next.locked;
    }
    if (f.speakerId !== undefined) {
      if (f.speakerId === null) delete next.speakerId;
      else next.speakerId = f.speakerId;
      // After the voice field: a line's own voice wins over its speaker's.
      if (voiceOf && voiceOf(next) !== voiceOf(s)) next.ttsStale = true;
    }
    return next;
  });
}

export function fieldsToPatch(f: LineFields): Omit<SegmentPatch, 'id'> {
  const p: Omit<SegmentPatch, 'id'> = {};
  if (f.translatedText !== undefined) p.translatedText = f.translatedText;
  if (f.startMs !== undefined) p.startMs = f.startMs;
  if (f.endMs !== undefined) p.endMs = f.endMs;
  if (f.voiceId !== undefined) p.voiceId = f.voiceId;
  if (f.speakingRate !== undefined) p.speakingRate = f.speakingRate;
  if (f.locked !== undefined) p.locked = f.locked;
  if (f.speakerId !== undefined) p.speakerId = f.speakerId;
  return p;
}

export function patchToFields(p: SegmentPatch): { id: string; fields: LineFields } {
  const { id, ...rest } = p;
  return { id, fields: rest };
}
