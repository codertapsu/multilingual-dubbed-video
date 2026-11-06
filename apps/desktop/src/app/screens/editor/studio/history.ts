/**
 * Undo/redo for the studio editor.
 *
 * Every edit is recorded as a list of per-line field changes with both the
 * BEFORE and AFTER values, so undo and redo are just "apply the other side" —
 * and both become ordinary patches to the server, exactly like the original
 * edit. Typing in one field coalesces into a single entry (keyed by line +
 * field, within a short window) so Ctrl+Z undoes a word, not a keystroke.
 *
 * Framework-free and unit-tested (history.spec.ts).
 */

/** The editable fields of a line, as the history and the server see them. */
export interface LineFields {
  translatedText?: string;
  startMs?: number;
  endMs?: number;
  voiceId?: string | null;
  speakingRate?: number | null;
  locked?: boolean;
}

export interface LineChange {
  id: string;
  before: LineFields;
  after: LineFields;
}

export interface HistoryEntry {
  /** i18n key describing the edit (shown in the undo button's tooltip). */
  label: string;
  changes: LineChange[];
  /** Entries with the same key, pushed within the coalesce window, merge. */
  coalesceKey?: string;
  at: number;
}

const COALESCE_WINDOW_MS = 1500;
const MAX_ENTRIES = 500;

export class EditHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The label of what Undo / Redo would do next. */
  peekUndo(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  push(entry: HistoryEntry): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      top &&
      entry.coalesceKey !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      entry.at - top.at <= COALESCE_WINDOW_MS
    ) {
      // Merge: keep the ORIGINAL before, take the newest after.
      for (const change of entry.changes) {
        const existing = top.changes.find((c) => c.id === change.id);
        if (existing) existing.after = { ...existing.after, ...change.after };
        else top.changes.push(change);
      }
      top.at = entry.at;
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    }
    // A new edit forks history: the redo branch is gone.
    this.redoStack = [];
  }

  /** Pop the newest entry; the caller applies each change's `before`. */
  undo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  /** Re-take an undone entry; the caller applies each change's `after`. */
  redo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** True when a change actually changes something (drop no-op edits). */
export function isEffective(change: LineChange): boolean {
  return (Object.keys(change.after) as (keyof LineFields)[]).some((k) => change.after[k] !== change.before[k]);
}
