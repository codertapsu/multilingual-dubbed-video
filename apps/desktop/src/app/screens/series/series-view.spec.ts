import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { partBadge, partStarts, seriesAiName, startReport } from './series-view';

/** A dotted key's text in a locale tree (undefined when missing). */
function text(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], tree);
}

describe('seriesAiName', () => {
  const options = [
    { id: 'anthropic-translate', label: 'Claude', ready: true, viaMotherClaude: true },
    { id: 'llama-cpp-chat', label: 'Gemma', ready: true },
  ];

  it('names the AI instead of printing its id', () => {
    expect(seriesAiName('llama-cpp-chat', options)).toBe('Gemma');
    expect(seriesAiName('anthropic-translate', options)).toBe('Claude (Mother Claude)');
  });

  it('falls back to the id for an AI the server did not list', () => {
    expect(seriesAiName('openai-translate', options)).toBe('openai-translate');
  });
});

describe('partBadge', () => {
  it('turns a known status into a badge, and nothing else', () => {
    expect(partBadge('running')).toBe('running');
    expect(partBadge('completed')).toBe('completed');
    expect(partBadge('exploded')).toBeNull();
    expect(partBadge(undefined)).toBeNull();
  });
});

describe('the Start every part report', () => {
  const answer = {
    parts: [
      { projectId: 'p1', done: true },
      { projectId: 'p2', started: true, queued: false },
      { projectId: 'p3', started: false, queued: true, position: 1 },
      { projectId: 'p4', waiting: true },
      { projectId: 'p5', error: 'The speech-to-text model is not installed.' },
      { nonsense: true },
    ],
  };
  const index: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5 };

  it('says what happened to every part, and why one did not start', () => {
    const lines = startReport(partStarts(answer), (id) => index[id]);
    expect(lines.map((l) => l.key)).toEqual([
      'series.start-done',
      'series.start-started',
      'series.start-queued',
      'series.start-waiting',
      'series.start-failed',
    ]);
    expect(lines[4]).toEqual({
      key: 'series.start-failed',
      params: { n: 5, why: 'The speech-to-text model is not installed.' },
      failed: true,
      projectId: 'p5',
    });
    expect(lines.filter((l) => l.failed).map((l) => l.projectId)).toEqual(['p5']);
  });

  it('numbers a part it cannot place by its place in the answer', () => {
    expect(startReport(partStarts(answer), () => undefined).map((l) => l.params['n'])).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads nothing from an answer without parts', () => {
    expect(partStarts(null)).toEqual([]);
    expect(partStarts({ parts: 'no' })).toEqual([]);
  });

  it('only uses keys both languages define, with the same placeholders', () => {
    const lines = startReport(partStarts(answer), (id) => index[id]);
    for (const { key, params } of lines) {
      for (const locale of [en, vi]) {
        const s = text(locale, key);
        expect(typeof s, key).toBe('string');
        for (const name of Object.keys(params)) expect(s as string, `${key} {{${name}}}`).toContain(`{{${name}}}`);
      }
    }
  });
});
