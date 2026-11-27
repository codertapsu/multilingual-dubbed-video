import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadItem, DownloadQueueEvent, EngineInstallEvent, PipelineState, SetupEvent } from '@videodubber/shared';

import type { PipelineEvent } from '../events.js';
import { AgentSessions } from './agents.js';
import { headerValue, initiatorFromHeaders, runWithInitiator } from './context.js';
import { DubRunTracker } from './dubRuns.js';
import { ActivityRegistry } from './registry.js';
import { RevoiceTracker } from './revoicing.js';
import { followDownloads, followEngineInstalls, followModelInstalls } from './sources.js';

const state = (over: Partial<PipelineState>): PipelineEvent => ({
  type: 'state',
  pipeline: { projectId: 'p1', steps: [], progressPercent: 0, status: 'running', updatedAt: '', ...over },
});

describe('who asked, from the headers', () => {
  it('decodes what the MCP server percent-encodes, and keeps a stray % as it came', () => {
    expect(initiatorFromHeaders({ 'x-vd-initiator': 'mcp', 'x-vd-client': 'Claude%20Desktop', 'x-vd-session': 'mcp-1a2b' })).toEqual({
      kind: 'mcp',
      client: 'Claude Desktop',
      session: 'mcp-1a2b',
    });
    expect(headerValue('M%E1%BA%B9 Claude')).toBe('Mẹ Claude');
    expect(headerValue('100%')).toBe('100%');
    expect(headerValue(['ui', 'mcp'])).toBe('ui');
    expect(headerValue('a\u0007b')).toBe('ab');
    expect(headerValue('x'.repeat(300))).toHaveLength(120);
    expect(initiatorFromHeaders({ 'x-vd-initiator': 'ui' })).toEqual({ kind: 'ui' });
  });
});

describe('connected agents', () => {
  it('lists the MCP sessions of the last hour with their client, calls and last tools', () => {
    let now = Date.UTC(2026, 10, 23, 10, 0, 0);
    const agents = new AgentSessions(() => now);
    const call = (session: string, requestId: string, tool: string, client = 'claude-code') =>
      agents.seen({ 'x-vd-initiator': 'mcp', 'x-vd-session': session, 'x-vd-client': client, 'x-request-id': requestId, 'x-vd-tool': tool });
    call('s1', 'mcp-a', 'get_status');
    call('s1', 'mcp-a', 'get_status'); // the same call's second request
    now += 60_000;
    call('s1', 'mcp-b', 'get_transcript');
    call('s1', 'mcp-c', 'get_status');
    now += 1000;
    call('s2', 'mcp-d', 'start_dubbing', 'Mother Claude');
    agents.seen({ 'x-vd-initiator': 'ui' });
    agents.seen({ 'x-vd-initiator': 'mcp' }); // no session: not counted

    const list = agents.list();
    expect(list.map((s) => s.session)).toEqual(['s2', 's1']);
    expect(list[1]).toMatchObject({ client: 'claude-code', calls: 3, tools: ['get_status', 'get_transcript'] });
    expect(list[1]!.firstAt).toBe(new Date(Date.UTC(2026, 10, 23, 10, 0, 0)).toISOString());
    expect(list[0]).toMatchObject({ client: 'Mother Claude', calls: 1, tools: ['start_dubbing'] });

    now += 61 * 60_000;
    expect(agents.list()).toEqual([]);
  });
});

describe('dub runs as activity', () => {
  it('follows a queued dub to its end, with who asked for it when it was queued', () => {
    const reg = new ActivityRegistry();
    const runs = new DubRunTracker(reg);
    runWithInitiator({ kind: 'mcp', client: 'claude-code' }, () => runs.scheduled({ id: 'p1', name: 'Part 1' }, { queued: true }));
    const [entry] = reg.list({ projectId: 'p1' });
    expect(entry).toMatchObject({ kind: 'dub.run', state: 'waiting', title: 'Dubbing “Part 1”', initiator: { kind: 'mcp', client: 'claude-code' } });

    // Started hours later by the queue, in someone else's context.
    runWithInitiator({ kind: 'ui' }, () => {
      runs.onEvent('p1', state({ status: 'running', currentStep: 'translation', progressPercent: 41.6 }));
      runs.onEvent('p1', state({ status: 'running', currentStep: 'translation', progressPercent: 41.6 }));
    });
    expect(reg.get(entry!.id)).toMatchObject({ state: 'running', percent: 42, message: 'Translate', initiator: { kind: 'mcp' } });
    runs.onEvent('p1', { type: 'done' });
    expect(reg.get(entry!.id)).toMatchObject({ state: 'done', percent: 100 });
    runs.onEvent('p1', { type: 'error', error: { code: 'UNKNOWN', message: 'late' } });
    expect(reg.get(entry!.id)?.state).toBe('done');
  });

  it('gives the time left from the run\'s own pace, and every text as a phrase the app translates', () => {
    const reg = new ActivityRegistry();
    let now = 1_000_000;
    const runs = new DubRunTracker(reg, () => now);
    runs.scheduled({ id: 'p2', name: 'Part 2' }, { queued: false });
    const [entry] = reg.list({ projectId: 'p2' });
    expect(entry).toMatchObject({ titlePhrase: { key: 'activity.text.dub-run', params: { name: 'Part 2' } }, messagePhrase: { key: 'activity.text.starting' } });
    // Resumed at 60 %: the estimate counts only what this run did.
    runs.onEvent('p2', state({ status: 'running', currentStep: 'tts', progressPercent: 60 }));
    expect(reg.get(entry!.id)?.etaSec).toBeUndefined();
    now += 100_000;
    runs.onEvent('p2', state({ status: 'running', currentStep: 'tts', progressPercent: 70 }));
    // 10 points in 100 s: 30 points left take 300 s.
    expect(reg.get(entry!.id)).toMatchObject({ etaSec: 300, messagePhrase: { key: 'opt.step.tts' } });
    expect(runs.etaOf('p2')).toBe(300);
    // Nothing moves for 200 s: the time left grows with it, when asked (it
    // read "about 8 min" for an hour, 2026-11-27), and the list follows at
    // the next write, as it drifted by more than a minute.
    now += 200_000;
    expect(runs.etaOf('p2')).toBe(900);
    runs.onEvent('p2', state({ status: 'running', currentStep: 'tts', progressPercent: 70 }));
    expect(reg.get(entry!.id)?.etaSec).toBe(900);
    now += 10_000;
    runs.onEvent('p2', state({ status: 'running', currentStep: 'tts', progressPercent: 70 }));
    expect(reg.get(entry!.id)?.etaSec).toBe(900);
    runs.onEvent('p2', state({ status: 'paused', currentStep: 'tts', pausedStep: 'tts', progressPercent: 70 }));
    expect(reg.get(entry!.id)).toMatchObject({ state: 'cancelled', messagePhrase: { key: 'activity.text.paused-at', params: { stepKey: 'opt.step.tts' } } });
  });

  it('says a render is a render, a pause a pause, and a review stop a stop for the user', () => {
    const reg = new ActivityRegistry();
    const runs = new DubRunTracker(reg);
    runs.scheduled({ id: 'r', name: 'R' }, { queued: false, fromStep: 'render' });
    expect(reg.list({ projectId: 'r' })[0]).toMatchObject({ kind: 'dub.render', title: 'Rendering “R”' });

    runs.scheduled({ id: 'p', name: 'P' }, { queued: false });
    // A continued run re-reads its old pause first: not its end.
    runs.onEvent('p', state({ status: 'paused' }));
    expect(reg.list({ projectId: 'p' })[0]?.state).toBe('running');
    runs.onEvent('p', state({ status: 'running', currentStep: 'tts', progressPercent: 70 }));
    runs.onEvent('p', state({ status: 'paused', pausedStep: 'tts' }));
    expect(reg.list({ projectId: 'p' })[0]).toMatchObject({ state: 'cancelled', message: expect.stringContaining('Paused at “') });

    runs.scheduled({ id: 'v', name: 'V' }, { queued: false });
    runs.onEvent('v', state({ status: 'running', currentStep: 'refine', progressPercent: 40 }));
    runs.onEvent('v', state({ status: 'running', awaitingReview: true }));
    expect(reg.list({ projectId: 'v' })[0]).toMatchObject({ state: 'done', result: expect.stringContaining('review') });
  });

  it('ends what leaves the queue unstarted, or stops without an event', () => {
    const reg = new ActivityRegistry();
    const runs = new DubRunTracker(reg);
    runs.scheduled({ id: 'q', name: 'Q' }, { queued: true });
    runs.dequeued('q');
    expect(reg.list({ projectId: 'q' })[0]).toMatchObject({ state: 'cancelled', message: 'Taken out of the queue' });
    runs.scheduled({ id: 'x', name: 'X' }, { queued: false });
    runs.ended('x');
    expect(reg.list({ projectId: 'x' })[0]?.state).toBe('cancelled');
  });

  it('gives a queue read back at start-up the asker of the project’s last run', () => {
    const reg = new ActivityRegistry();
    const runs = new DubRunTracker(reg);
    // Re-queued before the activity was read back…
    runs.scheduled({ id: 'p9', name: 'P9' }, { queued: true, restored: true });
    const open = reg.list({ projectId: 'p9' })[0]!;
    expect(open.initiator).toEqual({ kind: 'scheduler' });
    reg.restore([
      { id: 'act_old', kind: 'dub.run', title: 'Dubbing', projectId: 'p9', initiator: { kind: 'mcp', client: 'claude-code' }, state: 'cancelled', percent: null, startedAt: '2026-11-22T10:00:00.000Z', updatedAt: '2026-11-22T10:00:00.000Z', endedAt: '2026-11-22T10:00:00.000Z' },
    ]);
    runs.adoptRestored();
    expect(reg.get(open.id)?.initiator).toEqual({ kind: 'mcp', client: 'claude-code' });
  });
});

describe('re-voicing batches', () => {
  it('makes one entry per batch, with the progress the agent says is left', () => {
    const reg = new ActivityRegistry();
    const revoice = new RevoiceTracker(reg, 60_000);
    const agent = { kind: 'mcp' as const, session: 's1' };
    for (let left = 3; left >= 1; left--) {
      revoice.started('p1', agent, left);
      revoice.ended('p1', agent, true);
    }
    const entries = reg.list({ projectId: 'p1' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'voices.regenerate', state: 'done', result: 'Re-voiced 3 line(s)', initiator: agent });
  });

  it('ends a batch with no count after a pause, and keeps two askers apart', () => {
    vi.useFakeTimers();
    try {
      const reg = new ActivityRegistry();
      const revoice = new RevoiceTracker(reg, 90_000);
      const ui = { kind: 'ui' as const };
      const agent = { kind: 'mcp' as const, session: 's1' };
      revoice.started('p1', ui);
      revoice.started('p1', agent, 5);
      revoice.ended('p1', ui, true);
      revoice.ended('p1', agent, false, 'engine failed');
      expect(reg.list({ projectId: 'p1', active: true })).toHaveLength(2);
      expect(reg.list({ projectId: 'p1' }).find((e) => e.initiator.kind === 'mcp')).toMatchObject({ percent: 20, message: '0 line(s) re-voiced, 1 failed, 4 left' });
      vi.advanceTimersByTime(90_001);
      const ended = reg.list({ projectId: 'p1' });
      expect(ended.find((e) => e.initiator.kind === 'ui')).toMatchObject({ state: 'done', result: 'Re-voiced 1 line(s)' });
      expect(ended.find((e) => e.initiator.kind === 'mcp')).toMatchObject({ state: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A stream that replays nothing and lets the test emit. */
function stream<E>() {
  const listeners = new Set<(e: E) => void>();
  return {
    subscribe(l: (e: E) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(e: E) {
      for (const l of listeners) l(e);
    },
  };
}

describe('installs and downloads as activity', () => {
  it('follows an engine install and a model download to their ends', () => {
    const reg = new ActivityRegistry();
    const engines = stream<EngineInstallEvent>();
    const models = stream<SetupEvent>();
    followEngineInstalls(engines, reg, (id) => `Pack ${id}`);
    followModelInstalls(models, reg);
    engines.emit({ type: 'progress', packId: 'tts-vieneu', percent: 12.4, message: 'downloading' });
    engines.emit({ type: 'log', level: 'info', message: 'x' });
    engines.emit({ type: 'error', packId: 'tts-vieneu', error: { code: 'ENGINE_PACK_FAILED', message: 'checksum' } });
    models.emit({ type: 'progress', item: 'whisper:large-v3', percent: 5, message: '' });
    models.emit({ type: 'progress', item: 'argos:en->vi', percent: 5, message: '' });
    models.emit({ type: 'item-done', item: 'whisper:large-v3' });
    models.emit({ type: 'done', status: {} as never });
    const all = reg.list();
    expect(all.find((e) => e.kind === 'engine.install')).toMatchObject({ title: 'Installing Pack tts-vieneu', state: 'failed', error: { code: 'ENGINE_PACK_FAILED' } });
    expect(all.filter((e) => e.kind === 'model.install').map((e) => [e.title, e.state]).sort()).toEqual([
      ['Downloading the speech model large-v3', 'done'],
      ['Downloading the translation pack en → vi', 'done'],
    ]);
  });

  it('follows a download from waiting to done; the finished list replayed at start is not work', () => {
    const reg = new ActivityRegistry();
    const queue = stream<DownloadQueueEvent>();
    followDownloads(queue, reg);
    const item = (over: Partial<DownloadItem>): DownloadItem => ({
      id: 'dl_1',
      input: 'BV1xx',
      page: 1,
      state: 'queued',
      percent: null,
      attempts: 0,
      createdAt: '',
      updatedAt: '',
      ...over,
    });
    queue.emit({ type: 'item', item: item({ id: 'dl_old', state: 'done' }), replay: true });
    queue.emit({ type: 'item', item: item({}) });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ kind: 'download', state: 'waiting', title: 'Downloading “BV1xx”' });
    queue.emit({ type: 'item', item: item({ state: 'downloading', percent: 33, source: { title: 'Xuyên Không' } as never }) });
    expect(reg.list()[0]).toMatchObject({ state: 'running', percent: 33, title: 'Downloading “Xuyên Không”' });
    queue.emit({ type: 'item', item: item({ state: 'queued', heldBy: 'gpu-heavy' }) });
    expect(reg.list()[0]).toMatchObject({ state: 'waiting', message: 'Waiting: a dub is using the GPU' });
    // This machine's own kind of path: a Windows one is a single name to path.basename on macOS.
    queue.emit({ type: 'item', item: item({ state: 'done', filePath: path.join(os.tmpdir(), 'v', 'x.mp4') }) });
    expect(reg.list()[0]).toMatchObject({ state: 'done', result: 'Saved as x.mp4' });
  });
});
