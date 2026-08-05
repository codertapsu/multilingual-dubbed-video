/**
 * The contract every source-video provider implements.
 *
 * Bilibili is the only provider today, but the shape is chosen so a second one
 * (Douyin, YouTube, a plain direct link) is an additive change: a new file
 * implementing {@link SourceProvider} plus one line in the registry. Nothing
 * above this layer — routes, the job service, the screen — mentions a provider
 * by name.
 *
 * Provider-specific vocabulary stops here. Bilibili's `cid` and `qn` are
 * meaningful only inside its own module; at this boundary they become opaque
 * string ids, so a provider whose parts are UUIDs or whose qualities are named
 * "hd"/"sd" needs no change to anything shared.
 */
import type { AppError } from '@videodubber/shared';

/** One selectable part of a (possibly multi-part) video. */
export interface SourceVideoPart {
  /** Provider-specific identifier, opaque to everything above. */
  id: string;
  /** 1-based part number as the user would see it in a URL. */
  page: number;
  title: string;
  durationSec: number;
}

/** A quality the viewer can actually be served. */
export interface SourceQuality {
  /** Provider-specific identifier, opaque to everything above. */
  id: string;
  label: string;
  heightPx?: number;
}

/** The preview shown before committing to a download. */
export interface ResolvedSourceVideo {
  providerId: string;
  title: string;
  coverUrl?: string;
  durationSec: number;
  ownerName?: string;
  parts: SourceVideoPart[];
  /** The part the pasted link pointed at, so the picker can preselect it. */
  requestedPage: number;
  /** What can actually be delivered, best first. Empty if it could not be probed. */
  qualities: SourceQuality[];
}

/**
 * Everything needed to fetch one video, resolved and ready.
 *
 * `audioUrl` is optional on purpose. Bilibili serves adaptive streams, where
 * video and audio arrive separately and must be muxed; plenty of other sites
 * hand back a single already-muxed file. Making the second stream optional
 * means such a provider skips the merge instead of having to fake one.
 */
export interface PreparedDownload {
  videoUrl: string;
  audioUrl?: string;
  /** Filename stem, without extension; sanitised downstream. */
  baseName: string;
  /** Human title, for the completion message. */
  title: string;
  /** Headers the media fetch must carry (Referer, Cookie, …). */
  headers: Record<string, string>;
}

/** A source of downloadable videos. */
export interface SourceProvider {
  /** Stable id used in routes and by the UI to pick its labels. */
  id: string;
  /**
   * Whether this provider recognises the pasted input.
   *
   * Must be cheap and offline — it runs for every provider on every paste, and
   * is what decides which one gets to make network calls.
   */
  matches(input: string): boolean;
  /** Look the input up without downloading anything. */
  resolve(input: string): Promise<ResolvedSourceVideo>;
  /** Resolve concrete media URLs for one part at (at most) the given quality. */
  prepare(input: string, page: number, qualityId?: string): Promise<PreparedDownload>;
}

/** What the UI needs to render provider-specific affordances. */
export interface ProviderDescriptor {
  id: string;
}

/** Raised when nothing recognises the pasted input. */
export interface UnsupportedInput {
  error: AppError;
}
