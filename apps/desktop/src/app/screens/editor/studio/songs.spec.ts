import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { markSongLines, SONG_REASON_KEYS, songActionFor, voicedOnly } from './songs';

/** A signal's call shape, enough for the helper. */
const sig = <T>(value: T) => Object.assign(() => value, { set: (_: T) => undefined });

describe('the song button', () => {
  it('keeps the selection as the original song when any line of it is spoken, dubs it again when all sing', () => {
    expect(songActionFor([])).toBeNull();
    expect(songActionFor([{ song: true }, {}])).toBe('keep');
    expect(songActionFor([{ song: true }, { song: true }])).toBe('dub');
  });

  it('never asks for a voice for a song line', () => {
    expect(voicedOnly(['a', 'b', 'c'], [{ id: 'a' }, { id: 'b', song: true }, { id: 'c' }])).toEqual(['a', 'c']);
  });
});

describe('marking from the editor', () => {
  const store = (opts: { flushed?: boolean; series?: boolean; running?: boolean } = {}) => {
    const calls: string[] = [];
    let error: unknown = null;
    return {
      calls,
      errorOf: () => error,
      store: {
        projectId: sig('proj_1'),
        dubRunning: sig(opts.running === true),
        project: sig(opts.series ? ({ series: { role: 'parent' } } as never) : null),
        error: Object.assign(() => error, { set: (e: unknown) => void (error = e) }) as never,
        flushNow: async () => {
          calls.push('flush');
          return opts.flushed !== false;
        },
        reload: async () => {
          calls.push('reload');
        },
      },
    };
  };

  it('saves the waiting edits first, marks, then reads the timeline again; a series marks its parts too', async () => {
    const s = store({ series: true });
    const bodies: unknown[] = [];
    const res = await markSongLines(s.store as never, { markSongs: async (_id, body) => (bodies.push(body), { song: true, changed: [{ id: 'seg_0002' }], revoice: [], songs: 1 }) }, ['seg_0002'], true);
    expect(res?.changed).toEqual([{ id: 'seg_0002' }]);
    expect(bodies).toEqual([{ lineIds: ['seg_0002'], song: true, applyToParts: true }]);
    expect(s.calls).toEqual(['flush', 'reload']);
  });

  it('does nothing while a dub runs or when the edits could not be saved, and shows a refusal', async () => {
    const never = { markSongs: async () => { throw new Error('should not be called'); } };
    expect(await markSongLines(store({ running: true }).store as never, never, ['a'], true)).toBeNull();
    expect(await markSongLines(store({ flushed: false }).store as never, never, ['a'], true)).toBeNull();
    const s = store();
    const refused = await markSongLines(s.store as never, { markSongs: async () => { throw new Error('Unknown line(s): a.'); } }, ['a'], true);
    expect(refused).toBeNull();
    expect(String((s.errorOf() as { message?: string })?.message)).toContain('Unknown line');
  });
});

describe('the reasons a line looks sung', () => {
  it('have a label and an explanation in every language', () => {
    for (const locale of ['en', 'vi']) {
      const tree = JSON.parse(readFileSync(join(__dirname, '../../../../i18n', `${locale}.json`), 'utf8')) as Record<string, unknown>;
      const get = (key: string): unknown => key.split('.').reduce<unknown>((c, k) => (c as Record<string, unknown> | undefined)?.[k], tree);
      for (const { label, title } of Object.values(SONG_REASON_KEYS)) {
        expect(typeof get(label), `${locale} ${label}`).toBe('string');
        expect(typeof get(title), `${locale} ${title}`).toBe('string');
      }
    }
  });
});
