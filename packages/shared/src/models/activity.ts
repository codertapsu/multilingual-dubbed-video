import type { AppError } from '../errors.js';
import type { TranscriptSegment } from './domain.js';

/**
 * Who started a piece of work: the app's own window, an AI agent over MCP
 * (Claude Code, Claude Desktop, Mother Claude…), or the app itself (a series
 * starting its parts, a retry once models are in).
 *
 * WHY: a 27.8-hour production ran mostly over MCP, and the user saw almost none
 * of it in the app: speaker detection for five hours, 33 re-transcriptions, 21
 * line replacements, part creation and renames, rebuilds (claude-dubber report,
 * 2026-11-23). Every job and edit now says who asked for it.
 */
export type ActivityInitiatorKind = 'ui' | 'mcp' | 'scheduler' | 'unknown';

export interface ActivityInitiator {
  kind: ActivityInitiatorKind;
  /** The MCP client's own name from its handshake ("claude-code", "Claude Desktop"…). */
  client?: string;
  /** The MCP session, so one agent's calls can be told apart from another's. */
  session?: string;
}

export type ActivityState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** One piece of long work, as the activity list shows it (GET /activity). */
export interface ActivityEntry {
  id: string;
  /**
   * What kind of work: `speakers.detect`, `lines.retranscribe`, `series.plan`,
   * `series.rebuild`, `project.join`, `voices.regenerate`, `external` (reported
   * by an agent), …
   */
  kind: string;
  /** A sentence for the list ("Detecting speakers", "Re-transcribing 24:12:04–24:27:04"). */
  title: string;
  projectId?: string;
  initiator: ActivityInitiator;
  state: ActivityState;
  /** 0..100, or null while unknown. */
  percent: number | null;
  /** The step it is on, or how it ended. */
  message?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  /** Seconds left, when the work can tell. */
  etaSec?: number;
  /** What it produced ("14 lines replaced"), when it ended well. */
  result?: string;
  error?: AppError;
  /** Reported by an agent for work it did outside the app (MCP `report_activity`). */
  external?: boolean;
  /**
   * The tool call that started it, when an agent did (the MCP's request id,
   * `mcp-…`): the same reference its tool errors give, so the app's log lines
   * of that call can be found. The entry's own id is logged too.
   */
  logRef?: string;
  /** The project's name when the entry was listed (GET /activity fills it in; not stored). */
  projectName?: string;
}

/** A change of the activity list, as `GET /activity/events` streams it. */
export interface ActivityStreamEvent {
  type: 'entry';
  entry: ActivityEntry;
  /** Sent on connect: the state of things, not news. */
  replay?: boolean;
}

/**
 * An MCP session seen in the last hour (GET /activity/agents): which agent,
 * since when, and what it did last, so the user sees who is driving the app.
 */
export interface ActivityAgentSession {
  /** The session the MCP server names in `x-vd-session`. */
  session: string;
  /** The client's own name from its handshake ("claude-code", "claude-ai"…). */
  client?: string;
  firstAt: string;
  lastAt: string;
  /** Tool calls seen (each may make several requests to the app). */
  calls: number;
  /** The last tools it used, newest first. */
  tools: string[];
}

/**
 * An agent's report about work it does outside the app (POST
 * /activity/report, MCP `report_activity`): the first one (no `id`) creates
 * the entry, later ones update it by the id it got back.
 */
export interface ActivityReport {
  id?: string;
  projectId?: string;
  title?: string;
  state?: ActivityState;
  /** 0..100, or null when unknown. */
  percent?: number | null;
  /** The step it is on, or how it ended. */
  detail?: string;
}

/**
 * One change to a project's lines, with the lines before and after, so it can
 * be read back ("Claude replaced 14 lines at 24:12:04 (loop fixed)") and undone.
 * Only the changed lines are kept (a re-transcribed window changes ~300).
 */
export interface EditHistoryEntry {
  id: string;
  projectId: string;
  at: string;
  initiator: ActivityInitiator;
  /** What changed, in a sentence (English: for agents and logs). */
  summary: string;
  /**
   * The same sentence as a translation key (`history.summary.*`) and its
   * values, so the History tab shows it in the reader's language; absent on
   * entries written before 0.18.0 (the tab shows `summary`).
   */
  summaryKey?: string;
  summaryParams?: Record<string, string | number>;
  /** `source` = the transcript (source.json); `translation` = the translated lines. */
  target: 'source' | 'translation';
  /**
   * Set for a change to the line STRUCTURE in this time range (lines replaced,
   * re-transcribed): every line after it was renumbered, so `before` and
   * `after` are the range's lines (not an id diff), and undo replaces the
   * range again.
   */
  range?: { fromMs: number; toMs: number };
  /** The changed lines as they were (speaker ids included: undo restores them too). */
  before: TranscriptSegment[];
  /** The same lines as they are after the change. */
  after: TranscriptSegment[];
  /** Set when the change was undone. */
  undoneAt?: string;
  /** This change is the undo of that entry. */
  undoOf?: string;
}

/**
 * A history entry as the list shows it (GET /projects/:id/history): everything
 * but the lines themselves, which can be hundreds (GET …/history/:entryId has
 * them).
 */
export interface EditHistorySummary extends Omit<EditHistoryEntry, 'before' | 'after'> {
  /** How many lines the change touched, as they were and as they became. */
  beforeCount: number;
  afterCount: number;
}

/** POST /projects/:id/history/:entryId/undo: the entry undone, and the undo's own entry. */
export interface UndoEditResult {
  undone: EditHistorySummary;
  /** The undo as recorded in the history (absent when nothing had to be written). */
  entry?: EditHistorySummary;
}
