import type { AppError } from '../errors.js';
import type { ProjectSettings } from './domain.js';
import type { SeriesSettings } from './series.js';

/**
 * Source-video quality targets, shared by the orchestrator and the UI.
 *
 * The rule lives here rather than in either side because both need it and they
 * must agree: the screen promises "1080p selected → 720p will be downloaded"
 * before the download starts, and the provider then has to make exactly that
 * choice. Two copies of this rule would drift, and the symptom would be a
 * download quietly differing from what the user was shown.
 */

/** One rung of the quality ladder the user chooses from. */
export interface QualityTarget {
  /** Pixel height this rung asks for. */
  heightPx: number;
  /** i18n key suffix, so the UI names it without hardcoding a string here. */
  key: string;
}

/**
 * The ladder offered to the user, best first.
 *
 * Deliberately a fixed ladder of familiar names rather than the list of
 * qualities a particular video happens to offer. It is a standing PREFERENCE —
 * "give me 1080p when you can" — so every rung stays selectable even when this
 * video cannot serve it. That is the one place where showing an option the
 * source cannot satisfy is right rather than misleading, because the option
 * describes an intent, not a claim about this video.
 */
export const QUALITY_LADDER: readonly QualityTarget[] = [
  { heightPx: 2160, key: '4k' },
  { heightPx: 1440, key: '2k' },
  { heightPx: 1080, key: '1080p' },
  { heightPx: 720, key: '720p' },
  { heightPx: 480, key: '480p' },
  { heightPx: 360, key: '360p' },
];

/**
 * Resolve a target against what a source can actually deliver.
 *
 * Picks the highest available height that does not EXCEED the target, so
 * asking for 1080p on a video capped at 720p downloads 720p rather than
 * failing or silently jumping to something larger than requested.
 *
 * When every available height is above the target — asking for 360p from a
 * source that only serves 720p — it returns the lowest available rather than
 * nothing: the user asked for "small", and the smallest on offer is the honest
 * answer to that, where refusing to download would not be.
 *
 * No target means "the best there is".
 */
export function pickClosestHeight(
  available: readonly number[],
  targetHeightPx?: number,
): number | undefined {
  const heights = [...new Set(available.filter((h) => h > 0))].sort((a, b) => b - a);
  if (heights.length === 0) return undefined;
  if (targetHeightPx === undefined) return heights[0];

  const atOrBelow = heights.find((h) => h <= targetHeightPx);
  return atOrBelow ?? heights[heights.length - 1];
}

// ---------------------------------------------------------------- the queue

/**
 * Where a download is. `queued` waits for a free slot (two run at once);
 * `resolving` asks the site what to fetch; `downloading` / `merging` fetch and
 * combine the streams. `done`, `failed` and `cancelled` are final; a failed or
 * cancelled one can be retried, and an interrupted one (the app closed)
 * continues from its partial files at the next start.
 */
export type DownloadState = 'queued' | 'resolving' | 'downloading' | 'merging' | 'done' | 'failed' | 'cancelled';

/** The video a download is of, once the site has answered. */
export interface DownloadSource {
  providerId: string;
  /**
   * The download's identity: `bilibili:BV1xx411c7mD:p2`. Asking for the same
   * key again returns the existing download (Mother Claude's manifest is keyed
   * by it too).
   */
  sourceKey: string;
  /** The page a browser opens for it. */
  url: string;
  /** The video's title (a part's own name is in `partTitle`). */
  title: string;
  page: number;
  /** Parts the video has (Bilibili 分P); 1 for a single video. */
  partCount: number;
  partTitle?: string;
  ownerName?: string;
  durationSec?: number;
  coverUrl?: string;
  /** The site's chapter marks (Bilibili 视频看点), in the part's time: cut hints for a series. */
  chapters?: { startMs: number; title: string }[];
  /**
   * Subtitles the site publishes for it, saved beside the video (Bilibili CC,
   * or its AI subtitles when signed in): `useSourceSubtitles` uses them as the
   * transcript.
   */
  subtitles?: { language: string; label: string; path: string; ai: boolean }[];
}

/** One download in the queue (GET /downloads). */
export interface DownloadItem {
  /** `dl_<hex>`. */
  id: string;
  /** What was pasted (a link or a bare id). */
  input: string;
  /** 1-based part. */
  page: number;
  /** A preferred height (pickClosestHeight); none = the best on offer. */
  targetHeightPx?: number;
  state: DownloadState;
  /** 0-100, or null while the size is unknown. */
  percent: number | null;
  phase?: 'video' | 'audio' | 'merging';
  bytesDone?: number;
  bytesTotal?: number;
  /** Known offline for most links (a short link only once resolved). */
  sourceKey?: string;
  source?: DownloadSource;
  /** The finished file. */
  filePath?: string;
  /** Height actually delivered. */
  heightPx?: number;
  error?: AppError;
  /** A rate-limited download waits for this time before it tries again (`queued`). */
  retryAt?: string;
  /**
   * Waiting for a dub (`queued`, its bytes kept): `gpu-heavy` while a dub's
   * heavy step runs, `dubbing` while any dub runs (one task at a time),
   * `pressure` while the app is short of memory or responsiveness.
   */
  heldBy?: 'gpu-heavy' | 'dubbing' | 'pressure';
  /** Tries so far, including automatic ones after a rate limit. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Projects made from this file. */
  projectIds?: string[];
}

/** POST /downloads: add links to the queue. */
export interface DownloadRequest {
  input: string;
  /** 1-based part; default the one the link points at (or 1). */
  page?: number;
  targetHeightPx?: number;
}

/**
 * A saved set of dub choices ("Mẫu lồng tiếng"): New project, a batch of
 * downloads and the plugin start from one (GET/PUT/DELETE /presets).
 */
export interface DubPreset {
  /** `preset_<hex>`. */
  id: string;
  name: string;
  targetLanguage: string;
  /** Empty or absent: detect the spoken language. */
  sourceLanguage?: string;
  /** Applied over the settings the app recommends for this machine (engines, voice, subtitles, mix…). */
  settings: Partial<ProjectSettings>;
  /**
   * Where finished files go; absent = each project's own folder. `{series}`
   * (or `{name}`) is the job's name as a folder name, filled in when the job
   * is made: "D:\\Dubs\\{series}" gives each series its own folder.
   */
  outputDir?: string;
  /** Start dubbing as soon as a project is made from it. */
  start?: boolean;
  /** Long videos made from it are dubbed as a series of parts with these choices. */
  series?: PresetSeries;
  /** One of the presets every computer has (GET /presets/builtin); absent on the user's own. */
  builtin?: BuiltinPresetInfo;
  createdAt: string;
  updatedAt: string;
}

/**
 * The presets every computer has, worked out for it (GET /presets/builtin):
 * local engines only, never a cloud AI (the user's rule: a cloud AI runs only
 * where the user chooses it). Their ids start with {@link BUILTIN_PRESET_PREFIX}.
 */
export type BuiltinPresetKind = 'quality' | 'balanced' | 'economy';

/** `builtin:quality`, `builtin:balanced`, `builtin:economy`. */
export const BUILTIN_PRESET_PREFIX = 'builtin:';

/** Whether a preset id names a built-in preset. */
export function isBuiltinPresetId(id: string | undefined): boolean {
  return typeof id === 'string' && id.trim().startsWith(BUILTIN_PRESET_PREFIX);
}

/** A line about a built-in preset: the app's words (an i18n key, as ActivityPhrase) and the English text. */
export interface PresetNote {
  key: string;
  params?: Record<string, string | number>;
  text: string;
}

export interface BuiltinPresetInfo {
  kind: BuiltinPresetKind;
  /** What it gains and what it costs, then what holds for all of them. */
  tradeoffs: PresetNote[];
}

/**
 * A preset's series block: a video longer than `longerThanMinutes` (default
 * 1.5 x maxMinutes) made from the preset becomes a series of parts; a
 * shorter one is dubbed whole. A job that asks for a series itself lays its
 * own choices over these.
 */
export interface PresetSeries {
  minMinutes?: number;
  maxMinutes?: number;
  /** The AI that plans the parts: anthropic | openai | gemini | llama-cpp-chat, or an id from GET /series/ai-options. */
  aiProviderId?: string;
  recapSec?: number;
  autoStart?: boolean;
  /** How the parts are named: {series}, {n}, {nn}, {total}, {title} (needs {n} or {nn}). */
  nameTemplate?: string;
  longerThanMinutes?: number;
}

/** POST /downloads/dub: a project per finished download. */
export interface DubDownloadsRequest {
  downloadIds: string[];
  /** A preset to start from; the fields below override it. */
  presetId?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  settings?: Partial<ProjectSettings>;
  outputDir?: string;
  /** Start (or queue) each dub right away. */
  start?: boolean;
  /**
   * Dub the long ones as a series of parts (models/series.ts): only downloads
   * longer than `longerThanMinutes` (default 1.5 x maxMinutes); the rest whole.
   */
  series?: Partial<SeriesSettings> & { longerThanMinutes?: number };
}

/** One download's outcome in {@link DubDownloadsRequest}. */
export interface DubDownloadResult {
  downloadId: string;
  projectId?: string;
  name?: string;
  started?: boolean;
  queued?: boolean;
  /** Its models are still downloading; it starts once they are in. */
  waiting?: boolean;
  /** Split into parts (the request's `series`): projectId is the series; its parts are on GET /projects/:id/series. */
  series?: boolean;
  error?: AppError;
}

/** A change to the queue, on GET /download/events. */
export type DownloadQueueEvent =
  | { type: 'item'; item: DownloadItem; replay?: boolean }
  | { type: 'removed'; id: string };
