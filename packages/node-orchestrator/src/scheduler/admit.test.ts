import { describe, expect, it } from 'vitest';
import { decideAdmissions, type AdmissionCandidate, type RunningRun } from './admit.js';

const local = (id: string): AdmissionCandidate => ({ projectId: id, points: 2, needsHeavyEngine: false });
const cloud = (id: string): AdmissionCandidate => ({ projectId: id, points: 1, needsHeavyEngine: false });
const heavy = (id: string): AdmissionCandidate => ({ projectId: id, points: 2, needsHeavyEngine: true });
const runningLocal = (id: string): RunningRun => ({ projectId: id, points: 2, needsHeavyEngine: false });
const runningHeavy = (id: string): RunningRun => ({ projectId: id, points: 2, needsHeavyEngine: true });

const ctx = (budgetPoints: number, paused = false) => ({ budgetPoints, paused });

describe('decideAdmissions', () => {
  it('starts as many runs as the points budget allows, in queue order', () => {
    // 2 slots = 4 points; three local runs (2 each) -> the first two start.
    const d = decideAdmissions([local('a'), local('b'), local('c')], [], ctx(4));
    expect(d.start).toEqual(['a', 'b']);
    expect(d.held.get('c')?.reason).toBe('no-slot');
  });

  it('prices cloud-only runs cheaper, so more of them fit', () => {
    const d = decideAdmissions([cloud('a'), cloud('b'), cloud('c'), cloud('d')], [], ctx(4));
    expect(d.start).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts what is already running against the budget', () => {
    const d = decideAdmissions([local('b')], [runningLocal('a')], ctx(4));
    expect(d.start).toEqual(['b']);
    const full = decideAdmissions([local('c')], [runningLocal('a'), runningLocal('b')], ctx(4));
    expect(full.start).toEqual([]);
    expect(full.held.get('c')?.reason).toBe('no-slot');
  });

  it('allows only ONE heavy run at a time, whatever the budget', () => {
    const d = decideAdmissions([heavy('a'), heavy('b')], [], ctx(100));
    expect(d.start).toEqual(['a']);
    expect(d.held.get('b')?.reason).toBe('heavy-busy');
    // And none at all while a heavy run is already executing.
    const blocked = decideAdmissions([heavy('b')], [runningHeavy('a')], ctx(100));
    expect(blocked.start).toEqual([]);
    expect(blocked.held.get('b')?.reason).toBe('heavy-busy');
  });

  it('lets a LIGHT run start while a heavy one is executing (if points allow)', () => {
    const d = decideAdmissions([cloud('b')], [runningHeavy('a')], ctx(4));
    expect(d.start).toEqual(['b']);
  });

  it('names the blocking project in the heavy-busy message', () => {
    const d = decideAdmissions([heavy('b')], [runningHeavy('a')], {
      ...ctx(100),
      nameOf: (id) => (id === 'a' ? 'Ocean Doc' : undefined),
    });
    expect(d.held.get('b')?.message).toContain('Ocean Doc');
  });

  it('reserves the blocked head so cheap runs backfill but cannot starve it', () => {
    // Budget 4, one local running (2 used, 2 free). Head is a local run (2) —
    // it fits exactly, so it starts.
    expect(decideAdmissions([local('b'), cloud('c')], [runningLocal('a')], ctx(4)).start).toEqual(['b']);
    // Now budget 3: the head (2) does not fit in the 1 free point, so it is
    // held AND reserves its 2 points — the cheap cloud run behind it must NOT
    // consume the last point.
    const d = decideAdmissions([local('b'), cloud('c')], [runningLocal('a')], ctx(3));
    expect(d.start).toEqual([]);
    expect(d.held.get('b')?.reason).toBe('no-slot');
    expect(d.held.get('c')?.reason).toBe('no-slot');
  });

  it('backfills behind a heavy-blocked head only within the reservation', () => {
    // Heavy head is blocked by the running heavy job and reserves 2 points;
    // budget 6 - 2 used - 2 reserved = 2 free, so both cloud runs (1 each) fit.
    const d = decideAdmissions([heavy('b'), cloud('c'), cloud('d')], [runningHeavy('a')], ctx(6));
    expect(d.start).toEqual(['c', 'd']);
    expect(d.held.get('b')?.reason).toBe('heavy-busy');
  });

  it('starts nothing while the queue is paused, and says so', () => {
    const d = decideAdmissions([local('a'), cloud('b')], [], ctx(100, true));
    expect(d.start).toEqual([]);
    expect(d.held.get('a')?.reason).toBe('paused');
    expect(d.held.get('b')?.message).toMatch(/paused/i);
  });

  it('is a no-op on an empty queue', () => {
    expect(decideAdmissions([], [runningLocal('a')], ctx(4))).toEqual({ start: [], held: new Map() });
  });
});
