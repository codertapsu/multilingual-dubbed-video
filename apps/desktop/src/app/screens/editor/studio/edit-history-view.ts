/**
 * How the History panel shows a project's edit history (node-orchestrator
 * activity/history.ts): what each entry changed, line by line, and why an
 * undo was refused. Pure, so the panel only renders.
 *
 * Not the editor's own undo stack (history.ts beside this file), which only
 * knows this editor's edits since it opened: this is every server-side write
 * of the lines, by anyone (the user, an agent, the app), kept with the project.
 */
import type { EditHistoryEntry, EditHistorySummary, UndoChange } from '../../../core/activity/activity-models';
import type { TranscriptSegment } from '../../../core/models';

/** A field the history shows, as an edit changes it. */
export type DiffField = 'sourceText' | 'translatedText' | 'timing' | 'speakerId' | 'voiceId' | 'speakingRate' | 'locked' | 'song';

const FIELDS: readonly DiffField[] = ['sourceText', 'translatedText', 'timing', 'speakerId', 'voiceId', 'speakingRate', 'locked', 'song'];

/**
 * Yes/no fields: their values are translation keys (`history.flag-yes`), shown
 * in the reader's language. They were the English words "yes"/"no".
 */
const FLAG_YES = 'history.flag-yes';
const FLAG_NO = 'history.flag-no';

/** Whether a shown value is a translation key rather than text (a yes/no field's). */
export function isFlagValue(value: string): boolean {
  return value === FLAG_YES || value === FLAG_NO;
}

const FIELD_KEYS: Record<DiffField, string> = {
  sourceText: 'history.field-source-text',
  translatedText: 'history.field-translation',
  timing: 'history.field-timing',
  speakerId: 'history.field-speaker',
  voiceId: 'history.field-voice',
  speakingRate: 'history.field-pace',
  locked: 'history.field-lock',
  song: 'history.field-song',
};

/** The translation key naming a field. */
export function fieldKey(field: DiffField): string {
  return FIELD_KEYS[field];
}

/** `m:ss` / `h:mm:ss`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A line's number as the editor shows it (`seg_0012` → `12`), else its id. */
export function lineNumber(id: string | undefined): string {
  const m = /^seg_0*(\d+)$/.exec(id ?? '');
  return m ? m[1]! : (id ?? '?');
}

function valueOf(line: TranscriptSegment, field: DiffField): string {
  switch (field) {
    case 'timing':
      return `${clock(line.startMs)}–${clock(line.endMs)}`;
    case 'locked':
      return line.locked ? FLAG_YES : FLAG_NO;
    case 'song':
      return line.song === true ? FLAG_YES : FLAG_NO;
    case 'speakingRate':
      return line.speakingRate === undefined ? '1×' : `${line.speakingRate}×`;
    case 'sourceText':
      return line.sourceText ?? '';
    case 'translatedText':
      return line.translatedText ?? '';
    default:
      return line[field] ?? '';
  }
}

export interface LineChangeView {
  id: string;
  atMs: number;
  fields: { field: DiffField; before: string; after: string }[];
}

/**
 * What an entry (not a range) changed in each line: the fields that differ
 * between the line before and after, at most `max` lines (`more` says how
 * many are left out).
 */
export function lineChanges(entry: Pick<EditHistoryEntry, 'before' | 'after'>, max = 30): { lines: LineChangeView[]; more: number } {
  const before = new Map(entry.before.map((l) => [l.id, l]));
  const lines: LineChangeView[] = [];
  for (const after of entry.after) {
    const was = before.get(after.id);
    const fields = FIELDS.filter((f) => !was || valueOf(was, f) !== valueOf(after, f)).map((field) => ({
      field,
      before: was ? valueOf(was, field) : '',
      after: valueOf(after, field),
    }));
    if (fields.length > 0) lines.push({ id: after.id, atMs: after.startMs, fields });
  }
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

export interface RangeLineView {
  atMs: number;
  text: string;
  speakerId?: string;
}

/** A range entry's lines as they were and as they became, at most `max` of each. */
export function rangeView(
  entry: Pick<EditHistoryEntry, 'before' | 'after'>,
  max = 20,
): { before: RangeLineView[]; after: RangeLineView[]; moreBefore: number; moreAfter: number } {
  const view = (lines: readonly TranscriptSegment[]): RangeLineView[] =>
    [...lines]
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, max)
      .map((l) => ({ atMs: l.startMs, text: l.sourceText ?? '', ...(l.speakerId ? { speakerId: l.speakerId } : {}) }));
  return {
    before: view(entry.before),
    after: view(entry.after),
    moreBefore: Math.max(0, entry.before.length - max),
    moreAfter: Math.max(0, entry.after.length - max),
  };
}

/** Translates a key with its values (TranslateService.instant). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

const UNDO = 'history.summary.undo';

/** The pieces of a "Changed …" entry, in the order the server lists them. */
const CHANGED_PARTS: readonly (readonly [string, string])[] = [
  ['text', 'history.summary.part-text'],
  ['timing', 'history.summary.part-timing'],
  ['speaker', 'history.summary.part-speaker'],
  ['voice', 'history.summary.part-voice'],
  ['pace', 'history.summary.part-pace'],
  ['lock', 'history.summary.part-lock'],
];

/** What a re-transcribed window's loop check did, after its line count. */
const RETRANSCRIBED_PARTS: readonly (readonly [string, string])[] = [
  ['removed', 'history.summary.part-loops-removed'],
  ['kept', 'history.summary.part-loops-kept'],
  ['left', 'history.summary.part-loops-left'],
  ['unassigned', 'history.summary.part-unassigned'],
];

/**
 * An entry's sentence in the reader's language, from its `summaryKey` and
 * values (activity/history.ts). The server's English `summary` stays the
 * answer for entries written before 0.18.0 and for a key this version does
 * not know (a newer app wrote the history).
 */
export function historySummary(entry: Pick<EditHistorySummary, 'summary' | 'summaryKey' | 'summaryParams'>, t: Translate): string {
  const params = entry.summaryParams ?? {};
  if (entry.summaryKey !== UNDO) return sentence(entry.summaryKey, params, t) ?? entry.summary;
  // An undo names the change it undid (`of`, with that change's values), and
  // how many undos deep it is: an undo of an undo says "Undid: Undid: …".
  const of = typeof params['of'] === 'string' && params['of'] !== '' ? params['of'] : undefined;
  let text = sentence(of, params, t) ?? (typeof params['text'] === 'string' ? params['text'] : undefined);
  if (text === undefined) return entry.summary;
  const depth = Math.min(10, Math.max(1, Math.floor(Number(params['depth'] ?? 1)) || 1));
  for (let i = 0; i < depth; i++) {
    const wrapped = known(t, UNDO, { what: text });
    if (wrapped === undefined) return entry.summary;
    text = wrapped;
  }
  return text;
}

/** `t(key)`, or undefined when this version has no such key (instant returns the key). */
function known(t: Translate, key: string, params?: Record<string, string | number>): string | undefined {
  const text = t(key, params);
  return text === key ? undefined : text;
}

function sentence(key: string | undefined, params: Record<string, string | number>, t: Translate): string | undefined {
  if (!key || key === UNDO) return undefined;
  const pieces = (list: readonly (readonly [string, string])[]): string[] | undefined => {
    const out: string[] = [];
    for (const [name, pieceKey] of list) {
      const n = Number(params[name] ?? 0);
      if (!(n > 0)) continue;
      const piece = known(t, pieceKey, { n });
      if (piece === undefined) return undefined;
      out.push(piece);
    }
    return out;
  };
  switch (key) {
    case 'history.summary.changed': {
      const list = pieces(CHANGED_PARTS);
      return list && list.length > 0 ? known(t, key, { parts: list.join(', ') }) : undefined;
    }
    case 'history.summary.retranscribed': {
      const head = known(t, key, params);
      const list = pieces(RETRANSCRIBED_PARTS);
      return head !== undefined && list ? [head, ...list].join(', ') : undefined;
    }
    default:
      return known(t, key, params);
  }
}

/** Why an undo was refused, as translation keys and parameters (one per change, at most `max`). */
export function refusalLines(changes: readonly UndoChange[], max = 5): { key: string; params: Record<string, string> }[] {
  return changes.slice(0, max).map((c): { key: string; params: Record<string, string> } => {
    const line = { line: lineNumber(c.id), at: c.atMs !== undefined ? clock(c.atMs) : '' };
    switch (c.what) {
      case 'missing':
        return { key: 'history.change-missing', params: line };
      case 'count':
        return { key: 'history.change-count', params: { now: c.now ?? '?', expected: c.expected ?? '?' } };
      case 'translated':
        return { key: 'history.refused-translated', params: {} };
      case 'structure':
        return { key: 'history.refused-structure', params: {} };
      case 'already-undone':
        return { key: 'history.refused-undone', params: {} };
      default: {
        // The server words a yes/no field's values in English (undo.ts): shown as yes/no keys.
        const flag = (v: string | undefined): string =>
          c.what === 'locked' ? (v === 'locked' ? FLAG_YES : FLAG_NO) : c.what === 'song' ? (v === 'dubbed' ? FLAG_NO : FLAG_YES) : (v ?? '');
        return { key: 'history.change-field', params: { ...line, field: fieldKey(c.what), now: flag(c.now), expected: flag(c.expected) } };
      }
    }
  });
}
