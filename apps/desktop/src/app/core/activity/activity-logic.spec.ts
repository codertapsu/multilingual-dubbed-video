import { describe, expect, it } from 'vitest';

import type { PipelineState } from '../models';
import {
  downloadLabel,
  downloadListing,
  downloadNews,
  isRenderRun,
  moveProgress,
  queuePollDelay,
  runLink,
  runNotice,
  runOutcome,
  runsThatEnded,
  type QueueView,
} from './activity-logic';

const queue = (running: string[], entries: string[] = [], paused = false): QueueView => ({
  paused,
  running: running.map((projectId) => ({ projectId, name: projectId })),
  entries: entries.map((projectId) => ({ projectId, name: projectId })),
});

const pipeline = (over: Partial<PipelineState> = {}): Pick<PipelineState, 'awaitingReview' | 'steps'> => ({
  steps: [
    { id: 'stt', label: 'STT', status: 'completed', progressPercent: 100 },
    { id: 'translation', label: 'Translate', status: 'failed', progressPercent: 40, error: 'timed out' },
  ],
  ...over,
});

describe('dubs from the queue', () => {
  it('a run that was seen running and left has ended; one back in the queue has not', () => {
    expect(runsThatEnded(['a', 'b', 'c'], queue(['a'], ['b']))).toEqual(['c']);
    expect(runsThatEnded([], queue(['a']))).toEqual([]);
  });

  it('what the project says once its run left the queue', () => {
    expect(runOutcome({ status: 'completed' }, pipeline())).toEqual({ kind: 'done' });
    expect(runOutcome({ status: 'failed' }, pipeline())).toEqual({ kind: 'failed', step: 'translation' });
    expect(runOutcome({ status: 'failed' }, null)).toEqual({ kind: 'failed' });
    expect(runOutcome({ status: 'paused' }, pipeline({ awaitingReview: true }))).toEqual({ kind: 'review' });
    // A pause (or a cancel, or the app quitting) is a stop, never a failure.
    expect(runOutcome({ status: 'paused' }, pipeline())).toEqual({ kind: 'stopped' });
    expect(runOutcome({ status: 'created' }, null)).toEqual({ kind: 'stopped' });
    expect(runOutcome({ status: 'running' }, null)).toEqual({ kind: 'unsettled' });
  });

  it('announces a render as a render, a series analysis as one, and a stop not at all', () => {
    expect(isRenderRun('render')).toBe(true);
    expect(isRenderRun('audio-mix')).toBe(true);
    expect(isRenderRun('stt')).toBe(false);
    expect(isRenderRun(undefined)).toBe(false);
    expect(runNotice({ kind: 'done' }, { seriesParent: false, render: false })).toMatchObject({ tone: 'success', titleKey: 'activity.dub-done-title' });
    expect(runNotice({ kind: 'done' }, { seriesParent: false, render: true })).toMatchObject({ titleKey: 'activity.render-done-title' });
    expect(runNotice({ kind: 'done' }, { seriesParent: true, render: false })).toMatchObject({
      titleKey: 'activity.series-done-title',
      bodyKey: 'activity.series-done-body',
    });
    expect(runNotice({ kind: 'failed', step: 'tts' }, { seriesParent: false, render: false })).toMatchObject({
      tone: 'error',
      state: 'failed',
      titleKey: 'activity.dub-failed-title',
    });
    expect(runNotice({ kind: 'failed' }, { seriesParent: false, render: true })).toMatchObject({ titleKey: 'activity.render-failed-title' });
    expect(runNotice({ kind: 'review' }, { seriesParent: false, render: false })).toMatchObject({ tone: 'info', titleKey: 'activity.review-title' });
    expect(runNotice({ kind: 'stopped' }, { seriesParent: false, render: false })).toBeNull();
    expect(runNotice({ kind: 'unsettled' }, { seriesParent: false, render: false })).toBeNull();
  });

  it('links a series to its page and anything else to its progress', () => {
    expect(runLink('proj_1', false)).toBe('/project/proj_1/processing');
    expect(runLink('proj_1', true)).toBe('/project/proj_1/series');
  });

  it('polls steadily, and backs off while the backend does not answer', () => {
    expect(queuePollDelay(0)).toBe(4000);
    expect(queuePollDelay(1)).toBe(8000);
    expect(queuePollDelay(10)).toBe(30_000);
  });
});

describe('downloads', () => {
  it('lists what downloads and what waits; a finished one is announced instead', () => {
    expect(downloadListing({ state: 'downloading' })).toBe('running');
    expect(downloadListing({ state: 'resolving' })).toBe('running');
    expect(downloadListing({ state: 'merging' })).toBe('running');
    expect(downloadListing({ state: 'queued' })).toBe('waiting');
    expect(downloadListing({ state: 'done' })).toBeNull();
    expect(downloadListing({ state: 'cancelled' })).toBeNull();
  });

  it('the list replayed at launch is not news, a change the app saw is', () => {
    // First sight: yesterday's finished and failed downloads stay quiet.
    expect(downloadNews(undefined, { state: 'done' })).toBeNull();
    expect(downloadNews(undefined, { state: 'failed' })).toBeNull();
    // Seen downloading, now done or failed (also across a reconnect).
    expect(downloadNews('downloading', { state: 'done' })).toBe('done');
    expect(downloadNews('merging', { state: 'failed' })).toBe('failed');
    // A done one updated again (a project made from it) is not news twice.
    expect(downloadNews('done', { state: 'done' })).toBeNull();
    expect(downloadNews('downloading', { state: 'cancelled' })).toBeNull();
  });

  it('names a download by its title once known', () => {
    expect(downloadLabel({ input: 'BV1xx', source: undefined })).toBe('BV1xx');
    expect(
      downloadLabel({
        input: 'BV1xx',
        source: { providerId: 'bilibili', sourceKey: 'bilibili:BV1xx:p1', url: 'https://x', title: 'Episode 1', page: 1, partCount: 1 },
      }),
    ).toBe('Episode 1');
  });
});

describe('the projects-folder move', () => {
  it('reports how far it is, and nothing once it ended', () => {
    expect(moveProgress({ moving: { to: 'E:\\VD\\projects', done: 3, total: 12 } })).toEqual({ done: 3, total: 12, percent: 25 });
    expect(moveProgress({ moving: { to: 'E:\\VD\\projects', done: 0, total: 0 } })).toEqual({ done: 0, total: 0, percent: null });
    expect(moveProgress({})).toBeNull();
  });
});
