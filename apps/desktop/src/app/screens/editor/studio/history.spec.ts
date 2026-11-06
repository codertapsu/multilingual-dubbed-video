import { describe, expect, it } from 'vitest';
import { EditHistory, isEffective } from './history';

describe('EditHistory', () => {
  it('undoes and redoes whole entries', () => {
    const h = new EditHistory();
    h.push({ label: 'move', changes: [{ id: 'a', before: { startMs: 0 }, after: { startMs: 100 } }], at: 0 });
    expect(h.canUndo).toBe(true);
    const undone = h.undo()!;
    expect(undone.changes[0]!.before.startMs).toBe(0);
    expect(h.canRedo).toBe(true);
    expect(h.redo()!.changes[0]!.after.startMs).toBe(100);
  });

  it('coalesces typing in one field into a single undo step', () => {
    const h = new EditHistory();
    h.push({ label: 'text', coalesceKey: 'a:text', changes: [{ id: 'a', before: { translatedText: '' }, after: { translatedText: 'X' } }], at: 1000 });
    h.push({ label: 'text', coalesceKey: 'a:text', changes: [{ id: 'a', before: { translatedText: 'X' }, after: { translatedText: 'Xi' } }], at: 1500 });
    const entry = h.undo()!;
    expect(entry.changes).toEqual([{ id: 'a', before: { translatedText: '' }, after: { translatedText: 'Xi' } }]);
    expect(h.canUndo).toBe(false);
  });

  it('does not coalesce across the window or across keys', () => {
    const h = new EditHistory();
    h.push({ label: 't', coalesceKey: 'k', changes: [{ id: 'a', before: {}, after: {} }], at: 0 });
    h.push({ label: 't', coalesceKey: 'k', changes: [{ id: 'a', before: {}, after: {} }], at: 5000 });
    h.push({ label: 't', coalesceKey: 'other', changes: [{ id: 'a', before: {}, after: {} }], at: 5100 });
    h.undo();
    h.undo();
    expect(h.canUndo).toBe(true);
  });

  it('drops the redo branch when a new edit is made', () => {
    const h = new EditHistory();
    h.push({ label: 'a', changes: [], at: 0 });
    h.undo();
    h.push({ label: 'b', changes: [], at: 10 });
    expect(h.canRedo).toBe(false);
  });
});

describe('isEffective', () => {
  it('filters edits that change nothing', () => {
    expect(isEffective({ id: 'a', before: { startMs: 1 }, after: { startMs: 1 } })).toBe(false);
    expect(isEffective({ id: 'a', before: { voiceId: null }, after: { voiceId: 'v' } })).toBe(true);
  });
});
