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
}

export const DEFAULT_SERIES_SETTINGS: Omit<SeriesSettings, 'aiProviderId'> = {
  minMinutes: 15,
  maxMinutes: 20,
  recapSec: 4,
  autoStart: false,
};

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
}

/** On each part project. */
export interface SeriesPartInfo {
  role: 'part';
  parentId: string;
  /** 1-based. */
  index: number;
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
  cutBy: 'start' | 'ai' | 'pause' | 'manual';
}

/** A candidate cut: a pause between lines. */
export interface SeriesCandidate {
  ms: number;
  /** Higher is better (a long pause, a scene change, a chapter mark). */
  score: number;
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
  parts: {
    index: number;
    projectId?: string;
    title: string;
    startMs: number;
    endMs: number;
    status?: string;
    progressPercent?: number;
  }[];
  error?: AppError;
}
