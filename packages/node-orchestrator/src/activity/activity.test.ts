import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from '@videodubber/shared';

import { currentInitiator, initiatorFromHeaders, runAsScheduler, runWithInitiator } from './context.js';
import { changedLines, listEdits, recordEdit } from './history.js';
import { ActivityRegistry } from './registry.js';

const line = (id: string, sourceText: string, speakerId?: string): TranscriptSegment =>
  ({ id, index: 0, startMs: 0, endMs: 1000, sourceText, ...(speakerId ? { speakerId } : {}) }) as TranscriptSegment;

describe('initiator context', () => {
  it('reads who asked from the headers', () => {
    expect(initiatorFromHeaders({ 'x-vd-initiator': 'mcp', 'x-vd-client': 'claude-code', 'x-vd-session': 's1' })).toEqual({
      kind: 'mcp',
      client: 'claude-code',
      session: 's1',
    });
    expect(initiatorFromHeaders({ 'x-vd-initiator': 'nonsense' })).toEqual({ kind: 'unknown' });
    expect(initiatorFromHeaders({})).toEqual({ kind: 'unknown' });
  });

  it('follows async work started inside a request', async () => {
    const seen = await runWithInitiator({ kind: 'ui' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentInitiator();
    });
    expect(seen).toEqual({ kind: 'ui' });
    expect(runAsScheduler(() => currentInitiator())).toEqual({ kind: 'scheduler' });
    expect(currentInitiator()).toEqual({ kind: 'unknown' });
  });
});

describe('ActivityRegistry', () => {
  it('records a job from start to end, with who started it', () => {
    const reg = new ActivityRegistry();
    const seen: string[] = [];
    reg.subscribe((e) => seen.push(`${e.state}:${e.percent ?? '-'}`));
    const job = runWithInitiator({ kind: 'mcp', client: 'claude-code' }, () =>
      reg.start({ kind: 'speakers.detect', title: 'Detecting speakers', projectId: 'p1' }),
    );
    job.progress(42.4, 'part 3/12', 600);
    job.done('12 speakers');
    job.progress(10); // ignored after the end
    const e = reg.get(job.id)!;
    expect(e.initiator).toEqual({ kind: 'mcp', client: 'claude-code' });
    expect(e.state).toBe('done');
    expect(e.result).toBe('12 speakers');
    expect(e.endedAt).toBeDefined();
    expect(seen).toEqual(['running:-', 'running:42', 'done:100']);
    expect(reg.list({ projectId: 'p1' })).toHaveLength(1);
    expect(reg.list({ active: true })).toHaveLength(0);
  });

  it('only lets an agent update the work it reported itself', () => {
    const reg = new ActivityRegistry();
    const own = reg.start({ kind: 'lines.retranscribe', title: 'x' });
    expect(reg.report(own.id, { state: 'done' })).toBeUndefined();
    const ext = reg.start({ kind: 'external', title: 'Joining audio', external: true });
    expect(reg.report(ext.id, { percent: 50 })?.percent).toBe(50);
    expect(reg.report(ext.id, { state: 'done' })?.endedAt).toBeDefined();
  });
});

describe('edit history', () => {
  it('keeps only the lines a write changed', () => {
    const before = [line('s1', 'a', 'SPEAKER_00'), line('s2', 'b'), line('s3', 'c')];
    const after = [line('s1', 'a', 'SPEAKER_00'), line('s2', 'B'), line('s4', 'd')];
    const diff = changedLines(before, after);
    expect(diff.before.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(diff.after.map((s) => s.id)).toEqual(['s2', 's4']);
  });

  it('records nothing when nothing changed, and the change otherwise', async () => {
    const lines = [line('s1', 'a')];
    expect(await recordEdit({ projectId: 'p9', target: 'source', summary: 'none', before: lines, after: lines })).toBeUndefined();
    const e = await recordEdit({ projectId: 'p9', target: 'source', summary: 'Replaced 1 line', before: lines, after: [line('s1', 'z')] });
    expect(e?.before[0]?.sourceText).toBe('a');
    expect((await listEdits('p9'))[0]?.summary).toBe('Replaced 1 line');
  });
});
