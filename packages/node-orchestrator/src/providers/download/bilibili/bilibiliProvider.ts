import { AppErrorException } from '@videodubber/shared';

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
import type { BilibiliRef } from './url.js';
import { qualityHeight, qualityLabel } from './quality.js';
import { BilibiliSessionStore } from './session.js';
import { looksLikeBilibili } from './url.js';
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
 * The quality id carries which pipe it came from, which is exactly what the
 * contract's opaque ids are for — nothing above the provider has to know that
 * Bilibili has two.
 */
type StreamPath = 'dash' | 'prog';

function encodeQualityId(pathKind: StreamPath, qn: number): string {
  return `${pathKind}:${qn}`;
}

function decodeQualityId(id: string | undefined): { pathKind?: StreamPath; qn?: number } {
  if (!id) return {};
  const [kind, raw] = id.split(':');
  const qn = Number(raw);
  if ((kind !== 'dash' && kind !== 'prog') || !Number.isFinite(qn)) return {};
  return { pathKind: kind, qn };
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
 * Everything both pipes can deliver for one part, best first.
 *
 * Deduplicated by height with the progressive path winning ties: at equal
 * resolution it is strictly cheaper (one request, no merge) and avoids a remux
 * of an already-correct container.
 */
async function probeQualities(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
  cid: number,
): Promise<SourceQuality[]> {
  // Independent probes: one path failing must not hide the other, which is the
  // whole point of offering both.
  const [dash, prog] = await Promise.allSettled([
    fetchStreams(fetchImpl, ref, cid),
    fetchProgressiveStream(fetchImpl, ref, cid),
  ]);

  const byHeight = new Map<number, SourceQuality>();

  if (prog.status === 'fulfilled' && prog.value) {
    const h = qualityHeight(prog.value.qn);
    byHeight.set(h, {
      id: encodeQualityId('prog', prog.value.qn),
      label: qualityLabel(prog.value.qn),
      ...(h ? { heightPx: h } : {}),
    });
  }

  if (dash.status === 'fulfilled') {
    for (const q of dash.value.qualities) {
      const h = q.heightPx ?? qualityHeight(q.qn);
      if (byHeight.has(h)) continue;
      byHeight.set(h, {
        id: encodeQualityId('dash', q.qn),
        label: q.label,
        ...(h ? { heightPx: h } : {}),
      });
    }
  }

  return [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([, q]) => q);
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
      const qualities = probe ? await probeQualities(fetchImpl, ref, Number(probe.id)) : [];

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

    async prepare(input, page, qualityId): Promise<PreparedDownload> {
      const { ref, info, parts } = await lookup(input);
      const part = parts.find((p) => p.page === page) ?? parts[0];
      if (!part) {
        throw new AppErrorException('UNSUPPORTED_MEDIA', 'That video has no downloadable parts.', {
          remediation: 'Check the link opens a normal video page in a browser.',
        });
      }
      const cid = Number(part.id);
      const baseName = partBaseName({ title: info.title, parts }, part);

      // No explicit choice means "best available", which requires knowing what
      // both pipes offer — the adaptive one is not always the richer.
      let { pathKind, qn } = decodeQualityId(qualityId);
      if (!pathKind) {
        const best = (await probeQualities(fetchImpl, ref, cid))[0];
        ({ pathKind, qn } = decodeQualityId(best?.id));
      }

      if (pathKind === 'prog') {
        // Catch as well as null-check: this endpoint REJECTS (non-zero envelope
        // code) for some videos rather than returning an empty result, and
        // either way the right answer is to try the other pipe, not to fail.
        const prog = await fetchProgressiveStream(fetchImpl, ref, cid, qn ?? 80).catch(
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

      const streams = await fetchStreams(fetchImpl, ref, cid, qn);
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
