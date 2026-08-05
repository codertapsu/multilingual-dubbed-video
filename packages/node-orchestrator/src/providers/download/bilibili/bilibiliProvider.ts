import { AppErrorException, pickClosestHeight } from '@videodubber/shared';

import {
  checkSession,
  fetchProgressiveStream,
  fetchStreams,
  fetchVideoInfo,
  mediaHeaders,
  resolveInput,
  setSessionCookie,
  type FetchLike,
} from './client.js';
import { qualityHeight, qualityLabel } from './quality.js';
import { BilibiliSessionStore } from './session.js';
import { looksLikeBilibili, type BilibiliRef } from './url.js';
import type {
  PreparedDownload,
  ResolvedSourceVideo,
  SourceProvider,
  SourceQuality,
  SourceVideoPart,
} from '../types.js';

/**
 * Bilibili as a {@link SourceProvider}.
 *
 * This is the only file that knows both vocabularies: Bilibili's `cid`/`qn` on
 * one side, the provider contract's opaque string ids on the other. Keeping the
 * translation in one place is what lets the modules underneath stay natural
 * (they talk about cids and qn, because that is what the API talks about)
 * without leaking either into the routes or the UI.
 */

export const BILIBILI_PROVIDER_ID = 'bilibili';

/**
 * Bilibili serves the same video through two different pipes, gated
 * differently, so both are offered and the better one wins per quality.
 *
 *   dash — adaptive: separate video+audio, needs a signed request and an
 *          ffmpeg merge. Richest at the top end (1080p+, 4K) but, measured on
 *          current videos, capped at 480p for a logged-out viewer.
 *   prog — legacy single file: unsigned, already muxed, no merge. Serves 720p
 *          to that same logged-out viewer.
 *
 * Which pipe a stream came from stays INSIDE this module: the contract deals in
 * pixel heights, so nothing above the provider has to know that Bilibili has
 * two pipes, or that the newer one is the more restricted.
 */
type StreamPath = 'dash' | 'prog';

/** A concrete stream one of the two pipes can serve. */
interface Candidate {
  pathKind: StreamPath;
  qn: number;
  heightPx: number;
  label: string;
}

/**
 * Build the output filename stem for one part.
 *
 * Single-part videos are just the title. Multi-part ones need a distinguishing
 * suffix or every part overwrites the last — but a part carrying no name of its
 * own falls back to the video title upstream, which would otherwise produce
 * "Title - P1 Title".
 */
export function partBaseName(
  info: { title: string; parts: readonly SourceVideoPart[] },
  part: SourceVideoPart,
): string {
  if (info.parts.length <= 1) return info.title;
  const suffix = part.title && part.title !== info.title ? ` ${part.title}` : '';
  return `${info.title} - P${part.page}${suffix}`;
}

/**
 * Every stream both pipes can serve for one part, best first.
 *
 * Deduplicated by height with the progressive path winning ties: at equal
 * resolution it is strictly cheaper (one request, no merge) and avoids a remux
 * of an already-correct container.
 */
async function probeCandidates(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
  cid: number,
): Promise<Candidate[]> {
  // Independent probes: one path failing must not hide the other, which is the
  // whole point of offering both.
  const [dash, prog] = await Promise.allSettled([
    fetchStreams(fetchImpl, ref, cid),
    fetchProgressiveStream(fetchImpl, ref, cid),
  ]);

  const byHeight = new Map<number, Candidate>();

  if (prog.status === 'fulfilled' && prog.value) {
    const heightPx = qualityHeight(prog.value.qn);
    if (heightPx) {
      byHeight.set(heightPx, {
        pathKind: 'prog',
        qn: prog.value.qn,
        heightPx,
        label: qualityLabel(prog.value.qn),
      });
    }
  }

  if (dash.status === 'fulfilled') {
    for (const q of dash.value.qualities) {
      const heightPx = q.heightPx ?? qualityHeight(q.qn);
      if (!heightPx || byHeight.has(heightPx)) continue;
      byHeight.set(heightPx, { pathKind: 'dash', qn: q.qn, heightPx, label: q.label });
    }
  }

  return [...byHeight.values()].sort((a, b) => b.heightPx - a.heightPx);
}

export interface BilibiliProviderDeps {
  configDir: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
}

export function createBilibiliProvider(deps: BilibiliProviderDeps): SourceProvider {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const store = new BilibiliSessionStore(deps.configDir);

  /** Shared by resolve() and prepare(): both start from a pasted string. */
  const lookup = async (
    input: string,
  ): Promise<{
    ref: Awaited<ReturnType<typeof resolveInput>>;
    info: Awaited<ReturnType<typeof fetchVideoInfo>>;
    parts: SourceVideoPart[];
  }> => {
    const ref = await resolveInput(fetchImpl, input);
    const info = await fetchVideoInfo(fetchImpl, ref);
    const parts = info.parts.map((p) => ({
      id: String(p.cid),
      page: p.page,
      title: p.title,
      durationSec: p.durationSec,
    }));
    return { ref, info, parts };
  };

  return {
    id: BILIBILI_PROVIDER_ID,

    matches: (input) => looksLikeBilibili(input),

    async resolve(input): Promise<ResolvedSourceVideo> {
      const { ref, info, parts } = await lookup(input);

      // Probe the requested part for what is actually on offer. A failure here
      // must not sink the whole preview: the title and part list are still
      // useful, and the download falls back to the best available anyway.
      const probe = parts.find((p) => p.page === ref.page) ?? parts[0];
      const candidates = probe ? await probeCandidates(fetchImpl, ref, Number(probe.id)) : [];
      const qualities: SourceQuality[] = candidates.map((c) => ({
        id: String(c.heightPx),
        label: c.label,
        heightPx: c.heightPx,
      }));

      return {
        providerId: BILIBILI_PROVIDER_ID,
        title: info.title,
        ...(info.coverUrl ? { coverUrl: info.coverUrl } : {}),
        durationSec: info.durationSec,
        ...(info.ownerName ? { ownerName: info.ownerName } : {}),
        parts,
        requestedPage: ref.page,
        qualities,
      };
    },

    async prepare(input, page, targetHeightPx): Promise<PreparedDownload> {
      const { ref, info, parts } = await lookup(input);
      const part = parts.find((p) => p.page === page) ?? parts[0];
      if (!part) {
        throw new AppErrorException('UNSUPPORTED_MEDIA', 'That video has no downloadable parts.', {
          remediation: 'Check the link opens a normal video page in a browser.',
        });
      }
      const cid = Number(part.id);
      const baseName = partBaseName({ title: info.title, parts }, part);

      // Snap the preference onto what this video can actually serve, using the
      // SAME rule the screen used to promise a result before starting.
      const candidates = await probeCandidates(fetchImpl, ref, cid);
      const height = pickClosestHeight(
        candidates.map((c) => c.heightPx),
        targetHeightPx,
      );
      const chosen = candidates.find((c) => c.heightPx === height);

      if (chosen?.pathKind === 'prog') {
        // Catch as well as null-check: this endpoint REJECTS (non-zero envelope
        // code) for some videos rather than returning an empty result, and
        // either way the right answer is to try the other pipe, not to fail.
        const prog = await fetchProgressiveStream(fetchImpl, ref, cid, chosen.qn).catch(
          () => undefined,
        );
        if (prog) {
          // No audioUrl: the file is already muxed, so the download skips the
          // ffmpeg step entirely rather than remuxing a complete file.
          return {
            videoUrl: prog.url,
            baseName,
            title: info.title,
            headers: mediaHeaders(),
          };
        }
        // Fall through to DASH rather than failing: the legacy path can vanish
        // for an individual video, and a working lower quality beats an error.
      }

      const streams = await fetchStreams(fetchImpl, ref, cid, chosen?.qn);
      return {
        videoUrl: streams.videoUrl,
        audioUrl: streams.audioUrl,
        baseName,
        title: info.title,
        headers: mediaHeaders(),
      };
    },

    session: {
      describe: () => store.describe(),
      async set(raw) {
        await store.set(raw);
        // Re-read rather than reusing `raw`: the store normalises what was
        // pasted, and the live cookie must match what was persisted.
        setSessionCookie(await store.get());
      },
      async clear() {
        await store.clear();
        setSessionCookie(undefined);
      },
      check: () => checkSession(fetchImpl),
      async load() {
        setSessionCookie(await store.get());
      },
    },
  };
}

/** Human label for a Bilibili quality id (exported for tests). */
export { qualityLabel };
