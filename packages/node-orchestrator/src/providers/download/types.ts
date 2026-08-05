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

/** Display-safe view of a stored credential. */
export interface SessionInfo {
  configured: boolean;
  /** Masked value, so the user can confirm which one is stored. */
  masked?: string;
  /** True when it comes from the environment rather than the stored file. */
  fromEnv?: boolean;
}

/** Result of asking the site whether a stored credential is still live. */
export interface SessionCheck {
  valid: boolean;
  /** Account name, when the credential is live. */
  uname?: string;
}

/**
 * Optional per-provider credential.
 *
 * Declared as a capability rather than assumed, because it is genuinely
 * optional: a provider needing no credential simply omits it, and the UI hides
 * the whole section rather than showing a control that does nothing.
 */
export interface SessionCapability {
  /** Masked status; never the raw value. */
  describe(): Promise<SessionInfo>;
  /** Store (or, given an empty value, clear) the credential. */
  set(raw: string): Promise<void>;
  clear(): Promise<void>;
  /** Ask the site whether the stored credential still works. */
  check(): Promise<SessionCheck>;
  /** Load the persisted value and apply it, at boot. */
  load(): Promise<void>;
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
  /**
   * Resolve concrete media URLs for one part.
   *
   * `targetHeightPx` is a PREFERENCE, not a demand: the provider serves the
   * closest it can (see `pickClosestHeight`), because a target the source
   * cannot meet should downgrade rather than fail. Undefined means "the best
   * there is".
   */
  prepare(input: string, page: number, targetHeightPx?: number): Promise<PreparedDownload>;
  /** Present only when the provider accepts an optional credential. */
  session?: SessionCapability;
}

/** What the UI needs to render provider-specific affordances. */
export interface ProviderDescriptor {
  id: string;
  supportsSession: boolean;
  /** Current credential status, when the provider has one. */
  session?: SessionInfo;
}

/** Raised when nothing recognises the pasted input. */
export interface UnsupportedInput {
  error: AppError;
}
