/**
 * A long video dubbed as a series of shorter parts ("Chia thành nhiều phần").
 *
 * The parent project analyses the whole video once (speech-to-text, the
 * speech map), an AI chosen in Settings picks the cut points among the pauses
 * between lines, and each part becomes a normal project over a window of the
 * same video: the editor, Export, the queue and pausing work on it unchanged.
 * Part n+1 opens a few seconds before part n's cut (a short recap).
 */
import type { AppError } from '../errors.js';

/** The choices a series is made with. */
export interface SeriesSettings {
  /** Part length the cuts aim for, in minutes (default 15–20). */
  minMinutes: number;
  maxMinutes: number;
  /**
   * The AI that chooses the cuts and names the parts: `anthropic` (an API key
   * or Mother Claude), `openai`, `gemini` or `llama-cpp-chat` (the built-in
   * Gemma). One of GET /series/ai-options.
   */
  aiProviderId: string;
  /** The next part starts this many seconds before the cut (3–5, default 4). */
  recapSec: number;
  /** Create the parts and dub them without stopping for a review of the cuts. */
  autoStart: boolean;
  /**
   * How the parts' projects (and their finished files in a chosen folder) are
   * named: {series}, {n}, {nn} (two digits), {total}, {title}
   * (pipeline/seriesNames.ts). Absent: "<series> - Phần 01", as before.
   */
  nameTemplate?: string;
  /**
   * The series' name on its parts and their title cards, when it is not this
   * project's own name: a series that continues another carries that name on.
   */
  seriesName?: string;
  /**
   * The parts are numbered from this + 1: a series continuing one of 48 parts
   * starts at part 49 (a later season). Absent: 0.
   */
  partNumberOffset?: number;
  /** The total its cards and {total} say ("Phần 49/60"). Absent: the offset + this series' own parts. */
  totalParts?: number;
  /**
   * The series (its parent project's id) this one continues: its name,
   * numbering and name template carry on, and its voices go to the speakers
   * here whose voice prints match its speakers'.
   */
  continues?: string;
  /**
   * A project joined from several files: one part per file, cut exactly where
   * one file ends and the next begins (the files' own lengths, whatever the
   * minutes above say). claude-dubber offered the user that choice for the
   * nine episodes of 《反相之地》 (2026-11-25).
   */
  perFile?: boolean;
}

export const DEFAULT_SERIES_SETTINGS: Omit<SeriesSettings, 'aiProviderId'> = {
  minMinutes: 15,
  maxMinutes: 20,
  recapSec: 4,
  autoStart: false,
};

/** The short names agents use for the AI that plans a series (`ai: "anthropic"`), as the app's ids. */
export const SERIES_AI_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'anthropic-translate',
  claude: 'anthropic-translate',
  openai: 'openai-translate',
  gemini: 'gemini-translate',
};

/** The built-in Gemma chat model on this computer: the series' AI unless one is chosen. */
export const LOCAL_SERIES_AI_ID = 'llama-cpp-chat';

/**
 * The AI that plans a series' cuts when none is chosen: the built-in Gemma
 * chat model when it can run here, never a cloud AI (the user's rule,
 * 2026-11-25: "Prioritize keeping local-only, and use AI only when the user
 * chooses to engage it"). Undefined: the user (or the agent) must choose one.
 * Pure.
 */
export function defaultSeriesAiId(options: readonly Pick<SeriesAiOption, 'id' | 'ready'>[]): string | undefined {
  return options.find((o) => o.ready && o.id === LOCAL_SERIES_AI_ID)?.id;
}

/** A series AI as the app's id: a short name ("anthropic") mapped, any other id as it is. Pure. */
export function seriesAiId(id: string): string {
  return SERIES_AI_ALIASES[id.trim().toLowerCase()] ?? id.trim();
}

/** Where a series is. */
export type SeriesState = 'analysing' | 'planning' | 'review' | 'parts' | 'failed';

/** On the parent project. */
export interface SeriesParentInfo {
  role: 'parent';
  settings: SeriesSettings;
  state: SeriesState;
  /** The part projects, in order, once made. */
  partIds?: string[];
  error?: AppError;
  /**
   * Why a series asked to start by itself stopped at review instead: its
   * analysis was not clean (speaker detection failed, transcription loops were
   * left). The field report's series made and dubbed 17 parts from a
   * transcript with one speaker and 56 loop ranges (B3, 2026-11-21).
   */
  reviewReasons?: SeriesReviewReason[];
}

/** Why a series stopped at review (the code is for the UI's words, the message for agents). */
export interface SeriesReviewReason {
  code: 'speakers-failed' | 'loops-left' | 'transcript-mismatch';
  message: string;
}

/** On each part project. */
export interface SeriesPartInfo {
  role: 'part';
  parentId: string;
  /**
   * The part's number as shown, 1-based: its place in the series, after the
   * parts of the series it continues (`partNumberOffset`; plain 1..n for any
   * other series). Its place in `partIds` is `index - partNumberOffset`.
   */
  index: number;
  /** How many parts the viewer is told there are (`totalParts`, else the offset + the series' parts). */
  count: number;
  /** The series' name (the parent project's), for the title card. */
  seriesName: string;
  title?: string;
  summary?: string;
  /** In the part's own time: where its recap of the previous part ends (0 for the first part). */
  recapEndMs: number;
}

export type SeriesInfo = SeriesParentInfo | SeriesPartInfo;

/** One part of a plan, in the source video's time. */
export interface SeriesPlanPart {
  /** The part's number as shown (after `partNumberOffset`). */
  index: number;
  /** Where the part's own content starts (the previous cut; 0 for the first). */
  startMs: number;
  /** Where it ends (the next cut; the video's end for the last). */
  endMs: number;
  /** Where its video begins: a few seconds before `startMs`, at the start of a line. */
  recapStartMs: number;
  title: string;
  summary: string;
  /** What chose the cut that starts this part. */
  cutBy: 'start' | 'ai' | 'pause' | 'manual' | 'file';
  /** What the user wrote in review: planning again with `keepTitles` keeps it. */
  edited?: { title?: boolean; summary?: boolean };
}

/** A candidate cut: a pause between lines. */
export interface SeriesCandidate {
  ms: number;
  /** Higher is better (a long pause, a scene change, a chapter mark). */
  score: number;
  /** Where one file of a joined project ends and the next begins: a preferred cut. */
  boundary?: true;
}

/** `<parent>/series/plan.json`, shown for review. */
export interface SeriesPlan {
  aiProviderId: string;
  parts: SeriesPlanPart[];
  candidates: SeriesCandidate[];
  createdAt: string;
  /** What did not go as asked ("the AI did not answer for cut 3; the longest pause was used"). */
  notes: string[];
}

/** An AI the series can use (GET /series/ai-options). */
export interface SeriesAiOption {
  id: string;
  label: string;
  /** Set up and usable now. */
  ready: boolean;
  /** Claude through Mother Claude (the default when Mother Claude drives). */
  viaMotherClaude?: boolean;
}

/** GET /projects/:id/series: the series a project belongs to, with its parts. */
export interface SeriesView {
  parentId: string;
  name: string;
  state: SeriesState;
  /**
   * The parent's own run (`ProjectStatus`): an `analysing` series whose run
   * was never started, or is paused, is waiting for the user, not working.
   */
  parentStatus?: string;
  settings: SeriesSettings;
  plan?: SeriesPlan;
  /** Why it stopped at review although asked to start by itself (SeriesParentInfo.reviewReasons). */
  reviewReasons?: SeriesReviewReason[];
  parts: {
    index: number;
    projectId?: string;
    title: string;
    /** The part's one-sentence summary, once it has one. */
    summary?: string;
    /** The part's project name, once it is made. */
    name?: string;
    startMs: number;
    endMs: number;
    status?: string;
    progressPercent?: number;
  }[];
  /** The series this one continues (`settings.continues`), by name. */
  continues?: { parentId: string; name: string };
  error?: AppError;
}

/** GET /series: a series a new one can continue (a later season). */
export interface SeriesListItem {
  parentId: string;
  /** Its name, as on its parts and cards. */
  name: string;
  state: SeriesState;
  /** Its parts as numbered (made, or planned): first..last. */
  firstNumber: number;
  lastNumber: number;
  /** The total its cards say. */
  total: number;
  targetLanguage: string;
  /** Its name template, which a series continuing it carries on. */
  nameTemplate?: string;
}
