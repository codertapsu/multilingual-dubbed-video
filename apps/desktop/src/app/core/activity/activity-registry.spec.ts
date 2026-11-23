import { describe, expect, it } from 'vitest';

import {
  agentName,
  announceEnd,
  entryLink,
  followedElsewhere,
  initiatorView,
  kindLabelKey,
  mergeEntries,
  registryRow,
} from './activity-logic';
import type { ActivityEntry } from './activity-models';

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'act_1',
  kind: 'speakers.detect',
  title: 'Detecting speakers',
  projectId: 'proj_1',
  initiator: { kind: 'mcp', client: 'claude-code', session: 's1' },
  state: 'running',
  percent: 40,
  startedAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:05:00.000Z',
  ...over,
});

const live = { replay: false, seenRunning: true };

describe('the server\'s activity list in the top bar', () => {
  it('never lists twice what the app already follows from its own streams', () => {
    for (const kind of ['dub.run', 'dub.render', 'download', 'engine.install', 'model.install', 'projects.move']) {
      expect(followedElsewhere(kind)).toBe(true);
      expect(registryRow(entry({ kind }), live)).toBeNull();
      expect(announceEnd(entry({ kind, state: 'done', endedAt: '2026-11-23T10:06:00.000Z' }), live)).toBe(false);
    }
    // What nothing else follows is listed, with a link to its project's activity.
    for (const kind of ['speakers.detect', 'lines.retranscribe', 'project.join', 'picture.watermark', 'series.plan', 'series.rebuild', 'voices.regenerate', 'external']) {
      expect(registryRow(entry({ kind }), live)).toEqual({ id: 'job:act_1', state: 'running', percent: 40, link: '/project/proj_1/activity' });
    }
  });

  it('drops what was stopped, and history replayed on connect; announces only what ended while watched', () => {
    expect(registryRow(entry({ state: 'cancelled', endedAt: 'x' }), live)).toBeNull();
    const ended = entry({ state: 'done', endedAt: '2026-11-23T10:06:00.000Z' });
    expect(registryRow(ended, { replay: true, seenRunning: false })).toBeNull();
    expect(registryRow(ended, { replay: true, seenRunning: true })?.state).toBe('done');
    expect(announceEnd(ended, live)).toBe(true);
    expect(announceEnd(ended, { replay: true, seenRunning: true })).toBe(false);
    expect(announceEnd(ended, { replay: false, seenRunning: false })).toBe(false);
    expect(announceEnd(entry({ state: 'failed', endedAt: 'x' }), live)).toBe(true);
    // The window's own re-voicing is shown by the editor; an agent's is news.
    expect(announceEnd(entry({ kind: 'voices.regenerate', state: 'done', endedAt: 'x', initiator: { kind: 'ui' } }), live)).toBe(false);
    expect(announceEnd(entry({ kind: 'voices.regenerate', state: 'done', endedAt: 'x' }), live)).toBe(true);
  });

  it('names the kinds it knows, families of new ones, and who asked', () => {
    expect(kindLabelKey('speakers.detect')).toBe('activity.kind-speakers-detect');
    expect(kindLabelKey('picture.band')).toBe('activity.kind-picture');
    expect(kindLabelKey('speakers.ranged')).toBe('activity.kind-speakers');
    expect(kindLabelKey('something.new')).toBeNull();
    expect(agentName('claude-code')).toBe('Claude Code');
    expect(agentName('claude-ai')).toBe('Claude Desktop');
    expect(agentName('mother-claude')).toBe('Mother Claude');
    expect(agentName('my-script')).toBe('my-script');
    expect(agentName(undefined)).toBeNull();
    expect(initiatorView({ kind: 'ui' })).toEqual({ key: 'activity.by-you' });
    expect(initiatorView({ kind: 'mcp', client: 'claude-code' })).toEqual({ key: 'activity.by-agent', params: { name: 'Claude Code' } });
    expect(initiatorView({ kind: 'mcp' })).toEqual({ key: 'activity.by-some-agent' });
    expect(initiatorView({ kind: 'scheduler' })).toEqual({ key: 'activity.by-app' });
    expect(initiatorView({ kind: 'unknown' })).toEqual({ key: 'activity.by-unknown' });
    expect(initiatorView({ kind: 'mcp', client: 'claude-ai' }, true)).toEqual({ key: 'activity.reported-by', params: { name: 'Claude Desktop' } });
    expect(entryLink({})).toBe('/activity');
  });
});

describe('the Activity page\'s list', () => {
  it('keeps one row per entry, the latest, newest first, keeping a name already known', () => {
    const a = entry({ id: 'a', startedAt: '2026-11-23T09:00:00.000Z', projectName: 'Tập 1' });
    const b = entry({ id: 'b', startedAt: '2026-11-23T11:00:00.000Z' });
    let list = mergeEntries([], [a, b]);
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
    list = mergeEntries(list, [{ ...a, state: 'done', updatedAt: '2026-11-23T12:00:00.000Z', projectName: undefined }]);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ id: 'a', state: 'done', projectName: 'Tập 1' });
    // An older copy (a slow reload) never undoes a newer one.
    list = mergeEntries(list, [{ ...a, state: 'running', updatedAt: '2026-11-23T09:30:00.000Z' }]);
    expect(list[1]?.state).toBe('done');
    expect(mergeEntries([], [a, b], 1).map((e) => e.id)).toEqual(['b']);
  });
});
