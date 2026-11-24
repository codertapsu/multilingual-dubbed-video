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
    // The minor speakers' pool (plan 1.4), verbatim from casting.ts.
    [
      'male: 61 minor speaker(s) share 6 voice(s), about 10 each; speakers who answer each other get different voices where possible.',
      'editor.cast-note.pool-male {"n":61,"k":6,"each":10}',
    ],
    [
      'male: no spare built-in voice, so the voices of the least-heard cast speaker(s) SPEAKER_17, SPEAKER_16 are shared too.',
      'editor.cast-note.reused-male {"speakers":"18, 17"}',
    ],
    [
      'female: only 1 spare built-in voice(s), so the voices of the least-heard cast speaker(s) SPEAKER_93 are shared too.',
      'editor.cast-note.reused-female {"speakers":"94"}',
    ],
    [
      'female: no built-in voice is free for 4 minor speaker(s): they keep the project voice (choose voices for them).',
      'editor.cast-note.no-pool-female {"n":4}',
    ],
    [
      'Built-in voice "Thiện Minh" is left out of shared use: it sounds like your cloned voice "Thiện Minh - Nam - Miền Bắc" (0.84).',
      'editor.cast-note.soundalike {"voice":"Thiện Minh","clone":"Thiện Minh - Nam - Miền Bắc"}',
    ],
  ])('%s', (note, said) => {
    expect(describeCastNote(note, t)).toBe(said);
  });

  it('keeps a note it does not know', () => {
    expect(describeCastNote('Something else.', t)).toBe('Something else.');
  });

  it('knows the notes the cast panel shows as lists instead', async () => {
    const { castNoteShownElsewhere } = await import('./notes');
    expect(castNoteShownElsewhere('male: 61 minor speaker(s) share 6 voice(s), about 10 each; speakers who answer…')).toBe(true);
    expect(castNoteShownElsewhere('Built-in voice "A" is left out of shared use: it sounds like your cloned voice "B" (0.80).')).toBe(true);
    expect(castNoteShownElsewhere('male: no spare built-in voice, so the voices of …')).toBe(false);
  });
});
