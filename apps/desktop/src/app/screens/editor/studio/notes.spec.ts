import { describe, expect, it } from 'vitest';

import { describeCastNote, describeFitNote, describeTightenReason, type Translate } from './notes';

/** A translator that shows what it was asked: the key and its parameters. */
const t: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe('fit notes (alignment/align.ts) in words', () => {
  // Every sentence the orchestrator writes today, verbatim.
  it.each([
    ['Zero-length target window; segment cannot be placed cleanly.', 'studio.fit-why.no-window'],
    ['Sped up to 1.300x to fit the window.', 'studio.fit-why.sped-up {"x":"1.30"}'],
    ['Sped up to 1.250x; overflows by 420ms (within allowed 500ms).', 'studio.fit-why.sped-up-over {"x":"1.25","s":"0.42","allowed":"0.50"}'],
    ['Overflows by 120ms (within allowed 500ms).', 'studio.fit-why.over {"s":"0.12","allowed":"0.50"}'],
    [
      'Overflows by 420ms into the next line even at 1.300x. Consider shortening the translation.',
      'studio.fit-why.into-next {"s":"0.42","x":"1.30"}',
    ],
    [
      'Overflows by 1250ms beyond allowed 500ms even at 1.300x. Consider shortening the translation.',
      'studio.fit-why.beyond {"s":"1.25","allowed":"0.50","x":"1.30"}',
    ],
    ['Spoken at ~1.15x native rate to fit the window.', 'studio.fit-why.native-rate {"x":"1.15"}'],
  ])('%s', (note, said) => {
    expect(describeFitNote(note, t)).toBe(said);
  });

  it('says nothing without a note, and keeps a note it does not know', () => {
    expect(describeFitNote(undefined, t)).toBeNull();
    expect(describeFitNote('', t)).toBeNull();
    expect(describeFitNote('Some new note.', t)).toBe('Some new note.');
  });
});

describe("Tighten's reasons (contextEngine.judgeShortening, dubPasses) in words", () => {
  it.each([
    ['the line is already as short as it can be', 'studio.tighten-why.shortest'],
    [
      'No instruction-following model is available to shorten the line (set a review model or install the Gemma chat model).',
      'studio.tighten-why.no-model',
    ],
    ['The line has no translation yet.', 'studio.tighten-why.untranslated'],
    ['the model returned nothing usable', 'studio.tighten-why.nothing'],
    ['no proposal', 'studio.tighten-why.nothing'],
    ['echoes the source', 'studio.tighten-why.echo'],
    ['copies a neighbouring line', 'studio.tighten-why.neighbour'],
    ['not shorter (12 vs 12)', 'studio.tighten-why.not-shorter'],
    ['cut too far (3 of 12, target about 9)', 'studio.tighten-why.cut-too-far'],
    ['refused', 'studio.tighten-why.refused'],
  ])('%s', (reason, said) => {
    expect(describeTightenReason(reason, t)).toBe(said);
  });

  it('names the failed checks with the labels the line chips use', () => {
    const reason =
      'fails line checks: it contains characters that are not Vietnamese (Chinese/Japanese/Korean/Thai/Cyrillic) — write every name in Hán-Việt with Vietnamese letters; it offers alternatives with "/" — choose exactly ONE form; the line is spoken aloud';
    expect(describeTightenReason(reason, t)).toBe(
      'studio.tighten-why.checks {"problems":"editor.quality.wrong-script, editor.quality.alternatives"}',
    );
  });

  it('keeps an engine error as it came', () => {
    expect(describeTightenReason('Request timed out after 120 s', t)).toBe('Request timed out after 120 s');
  });
});

describe('casting notes (voices/casting.ts) in words', () => {
  it.each([
    ['male: paired by voice print (best 2.41 against 1.90 ± 0.20).', 'editor.cast-note.print-male'],
    ['female: no pitch measured for every speaker and voice, so the most-heard speakers got the voices in list order.', 'editor.cast-note.order-female'],
    ['No female voice to cast: 2 female speaker(s) keep the project voice.', 'editor.cast-note.none-female {"n":2}'],
    ['3 speaker(s) of unknown gender keep the project voice (set them in the editor).', 'editor.cast-note.unknown {"n":3}'],
  ])('%s', (note, said) => {
    expect(describeCastNote(note, t)).toBe(said);
  });

  it('keeps a note it does not know', () => {
    expect(describeCastNote('Something else.', t)).toBe('Something else.');
  });
});
