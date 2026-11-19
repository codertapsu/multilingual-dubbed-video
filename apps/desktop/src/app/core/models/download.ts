/**
 * Source-video downloader view models (experimental).
 *
 * Mirrors the orchestrator's `/download/*` contract, following the same
 * transport-seam pattern as {@link ./setup.ts}: the UI talks to these shapes,
 * not to the provider's own types.
 */
import type { AppError } from './index';
import type { DownloadItem } from '@videodubber/shared';

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

/** The download queue (GET /downloads, events on /download/events): the shared contract. */
export type {
  DownloadItem,
  DownloadQueueEvent,
  DownloadRequest,
  DownloadSource,
  DownloadState,
  DubDownloadResult,
  DubPreset,
} from '@videodubber/shared';

/** POST /downloads's answer. */
export interface AddDownloadsResult {
  added: DownloadItem[];
  existing: DownloadItem[];
  rejected: { input: string; error: AppError }[];
}

/** Whether an optional provider credential is configured (never the value). */
export interface SessionInfo {
  configured: boolean;
  /** Masked cookie, so the user can confirm which value is stored. */
  masked?: string;
  /** True when it comes from BILIBILI_SESSDATA rather than the stored file. */
  fromEnv?: boolean;
}

/** Result of asking the site whether a stored credential is still live. */
export interface SessionCheck {
  valid: boolean;
  uname?: string;
  /** A paid membership: 1080P60 / 4K where the video has them. */
  premium?: boolean;
}

/** A source this build can download from. */
export interface DownloadProvider {
  id: string;
  /** Whether it accepts an optional credential (drives the whole session UI). */
  supportsSession: boolean;
  session?: SessionInfo;
}
