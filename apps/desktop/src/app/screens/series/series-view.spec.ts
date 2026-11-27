import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { parsePartList, partBadge, partStarts, rebuildReportLine, seriesAiName, startReport } from './series-view';

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
      // Paused on its own: the series start leaves it (2026-11-27).
      { projectId: 'p6', held: true },
      { nonsense: true },
    ],
  };
  const index: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6 };

  it('says what happened to every part, and why one did not start', () => {
    const lines = startReport(partStarts(answer), (id) => index[id]);
    expect(lines.map((l) => l.key)).toEqual([
      'series.start-done',
      'series.start-started',
      'series.start-queued',
      'series.start-waiting',
      'series.start-failed',
      'series.start-held',
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
    expect(startReport(partStarts(answer), () => undefined).map((l) => l.params['n'])).toEqual([1, 2, 3, 4, 5, 6]);
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

describe('parsePartList', () => {
  it('reads part numbers and ranges, and an empty field as every part', () => {
    expect(parsePartList('')).toEqual([]);
    expect(parsePartList(' 24, 23 ')).toEqual([23, 24]);
    expect(parsePartList('1, 5-7; 6')).toEqual([1, 5, 6, 7]);
    expect(parsePartList('30–28')).toEqual([28, 29, 30]);
  });

  it('refuses what is not a part number', () => {
    expect(parsePartList('23, x')).toBeNull();
    expect(parsePartList('0')).toBeNull();
    expect(parsePartList('1-5000')).toBeNull();
  });
});

describe('rebuildReportLine', () => {
  const parts = [
    { index: 22, rebuilt: true, oldLines: 500, newLines: 510, speakers: 5 },
    { index: 23, rebuilt: true, queued: true, oldLines: 480, newLines: 470, speakers: 6 },
    { index: 24, rebuilt: true, translationDiscarded: true, oldLines: 400, newLines: 400, speakers: 4 },
    { index: 25, rebuilt: false, skipped: 'running', reason: 'is being dubbed now' },
    { index: 26, rebuilt: false, skipped: 'running', reason: 'is busy in the editor (a line being voiced again)' },
    { index: 27, rebuilt: false, skipped: 'translated' },
    { index: 28, rebuilt: false, skipped: 'missing' },
  ];

  it('says how each part was rebuilt, or why it was left', () => {
    expect(parts.map((p) => rebuildReportLine(p).key)).toEqual([
      'series.report-rebuilt',
      'series.report-rebuilt-queued',
      'series.report-rebuilt-forced',
      'series.report-kept-running',
      'series.report-kept-busy',
      'series.report-kept-translated',
      'series.report-kept-missing',
    ]);
    expect(rebuildReportLine(parts[4]!).params['why']).toBe('is busy in the editor (a line being voiced again)');
  });

  it('only uses keys both languages define, with the same placeholders', () => {
    for (const { key, params } of parts.map(rebuildReportLine)) {
      for (const locale of [en, vi]) {
        const s = text(locale, key);
        expect(typeof s, key).toBe('string');
        for (const name of Object.keys(params)) expect(s as string, `${key} {{${name}}}`).toContain(`{{${name}}}`);
      }
    }
  });
});
