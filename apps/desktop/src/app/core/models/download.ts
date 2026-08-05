/**
 * Source-video downloader view models (experimental).
 *
 * Mirrors the orchestrator's `/download/*` contract, following the same
 * transport-seam pattern as {@link ./setup.ts}: the UI talks to these shapes,
 * not to the provider's own types.
 */
import type { AppError } from './index';

/** One selectable part of a (possibly multi-part) video. */
export interface DownloadPart {
  /** Provider-specific id, opaque to the UI. */
  id: string;
  /** 1-based part number, matching `?p=` in the original link. */
  page: number;
  title: string;
  durationSec: number;
}

/** A quality the viewer can actually be served for this video. */
export interface QualityOption {
  /** Provider-specific id, opaque to the UI. */
  id: string;
  label: string;
  heightPx?: number;
}

/** The preview shown before the user commits to a download. */
export interface ResolvedVideo {
  /** Which provider handled this input. */
  providerId: string;
  title: string;
  coverUrl?: string;
  durationSec: number;
  ownerName?: string;
  parts: DownloadPart[];
  /** The part the pasted link pointed at, so the picker can preselect it. */
  requestedPage: number;
  /** What can actually be delivered, best first. Empty if it could not be probed. */
  qualities: QualityOption[];
}

/** Which stage of the job is running. */
export type DownloadPhase = 'video' | 'audio' | 'merging';

export type DownloadEvent = (
  | { type: 'progress'; jobId: string; phase: DownloadPhase; percent: number | null }
  | { type: 'done'; jobId: string; filePath: string; title: string }
  | { type: 'error'; jobId: string; error: AppError }
) & {
  /** Set on catch-up events sent when the stream is (re)connected. */
  replay?: boolean;
};
