/**
 * The editor's explanations, said in the user's language.
 *
 * The orchestrator writes its fit notes, Tighten's reasons and the casting
 * notes as English sentences, for its logs and the MCP server ("Overflows by
 * 420ms into the next line even at 1.300x. Consider shortening the
 * translation."), and the editor showed them as they came: English in a
 * Vietnamese-first app, where "1.300x" and "420ms" were the only words a
 * viewer could read. The API carries no structured field for the overflow
 * the line was allowed, the "into the next line" case, the voice's native
 * rate or why a shortening was refused, so the sentences are read here and
 * said again from their numbers. Anything not recognised is shown as the
 * server wrote it, never hidden: a new note must not vanish from the editor.
 *
 * The translator parameter is named `instant`, like TranslateService's, and
 * called with literal keys, so scripts/check-i18n.mjs sees (and checks) them.
 */

/** TranslateService.instant, injected so this stays pure (and testable in Node). */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

const seconds = (ms: string): string => (Number(ms) / 1000).toFixed(2);
const times = (x: string): string => Number(x).toFixed(2);

/**
 * A clip's fit note in words (alignment/align.ts, and the runner's pass that
 * re-voices a line at the voice's own faster rate). Null without a note.
 */
export function describeFitNote(note: string | undefined, instant: Translate): string | null {
  if (!note) return null;
  const n = note.trim();
  let m: RegExpExecArray | null;
  if (/^Zero-length target window/i.test(n)) return instant('studio.fit-why.no-window');
  if ((m = /^Sped up to ([\d.]+)x to fit the window\.?$/i.exec(n))) return instant('studio.fit-why.sped-up', { x: times(m[1]!) });
  if ((m = /^Sped up to ([\d.]+)x; overflows by (\d+) ?ms \(within allowed (\d+) ?ms\)\.?$/i.exec(n))) {
    return instant('studio.fit-why.sped-up-over', { x: times(m[1]!), s: seconds(m[2]!), allowed: seconds(m[3]!) });
  }
  if ((m = /^Overflows by (\d+) ?ms \(within allowed (\d+) ?ms\)\.?$/i.exec(n))) {
    return instant('studio.fit-why.over', { s: seconds(m[1]!), allowed: seconds(m[2]!) });
  }
  if ((m = /^Overflows by (\d+) ?ms into the next line even at ([\d.]+)x\b/i.exec(n))) {
    return instant('studio.fit-why.into-next', { s: seconds(m[1]!), x: times(m[2]!) });
  }
  if ((m = /^Overflows by (\d+) ?ms beyond allowed (\d+) ?ms even at ([\d.]+)x\b/i.exec(n))) {
    return instant('studio.fit-why.beyond', { s: seconds(m[1]!), allowed: seconds(m[2]!), x: times(m[3]!) });
  }
  if ((m = /^Spoken at ~?([\d.]+)x native rate to fit the window\.?$/i.exec(n))) {
    return instant('studio.fit-why.native-rate', { x: times(m[1]!) });
  }
  return n;
}

/** The line checks' labels (the chips the line itself shows), by flag. */
const CHECK_LABELS: Readonly<Record<string, string>> = {
  untranslated: 'editor.untranslated',
  'wrong-script': 'editor.quality.wrong-script',
  pinyin: 'editor.quality.pinyin',
  alternatives: 'editor.quality.alternatives',
  'no-diacritics': 'editor.quality.no-diacritics',
};

/** The checks a "fails line checks: …" reason names (lineQuality.describeFlags' sentences). */
function failedChecks(reason: string): string[] {
  const out: string[] = [];
  if (/\bnot translated\b/i.test(reason)) out.push('untranslated');
  if (/characters (that are not Vietnamese|from a script)/i.test(reason)) out.push('wrong-script');
  if (/\bpinyin\b/i.test(reason)) out.push('pinyin');
  if (/\bno Vietnamese diacritics\b/i.test(reason)) out.push('no-diacritics');
  if (/\balternatives with\b/i.test(reason)) out.push('alternatives');
  return out;
}

/**
 * Why "Tighten to fit" kept a line as it was (refitSegment's `reason`:
 * contextEngine.judgeShortening, dubPasses.tightenOneLine), as a clause that
 * follows "Line N was kept as it was:". Engine errors come back as they are.
 */
export function describeTightenReason(reason: string, instant: Translate): string {
  const r = reason.trim();
  if (/^the line is already as short as it can be/i.test(r)) return instant('studio.tighten-why.shortest');
  if (/^No instruction-following model/i.test(r)) return instant('studio.tighten-why.no-model');
  if (/^The line has no translation yet/i.test(r)) return instant('studio.tighten-why.untranslated');
  if (/^(the model returned nothing usable|no proposal)\.?$/i.test(r)) return instant('studio.tighten-why.nothing');
  if (/^echoes the source/i.test(r)) return instant('studio.tighten-why.echo');
  if (/^copies a neighbouring line/i.test(r)) return instant('studio.tighten-why.neighbour');
  if (/^not shorter\b/i.test(r)) return instant('studio.tighten-why.not-shorter');
  if (/^cut too far\b/i.test(r)) return instant('studio.tighten-why.cut-too-far');
  if (/^refused\.?$/i.test(r)) return instant('studio.tighten-why.refused');
  if (/^fails line checks\b/i.test(r)) {
    const problems = failedChecks(r).map((flag) => instant(CHECK_LABELS[flag]!));
    return problems.length > 0
      ? instant('studio.tighten-why.checks', { problems: problems.join(', ') })
      : instant('studio.tighten-why.refused');
  }
  return r;
}

/** A note of "Choose voices by gender" (voices/casting.ts proposeCast) in words. */
export function describeCastNote(note: string, instant: Translate): string {
  const n = note.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(male|female): paired by voice print\b/i.exec(n))) {
    return isFemale(m[1]!) ? instant('editor.cast-note.print-female') : instant('editor.cast-note.print-male');
  }
  if ((m = /^(male|female): no pitch measured\b/i.exec(n))) {
    return isFemale(m[1]!) ? instant('editor.cast-note.order-female') : instant('editor.cast-note.order-male');
  }
  if ((m = /^No (male|female) voice to cast: (\d+)\b/i.exec(n))) {
    const count = { n: Number(m[2]) };
    return isFemale(m[1]!) ? instant('editor.cast-note.none-female', count) : instant('editor.cast-note.none-male', count);
  }
  if ((m = /^(\d+) speaker\(s\) of unknown gender\b/i.exec(n))) return instant('editor.cast-note.unknown', { n: Number(m[1]) });
  return n;
}

function isFemale(word: string): boolean {
  return word.toLowerCase() === 'female';
}
