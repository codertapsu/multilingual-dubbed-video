import { AppErrorException } from '@videodubber/shared';

import {
  fetchStreams,
  fetchVideoInfo,
  mediaHeaders,
  resolveInput,
  type FetchLike,
} from './client.js';
import { qualityLabel } from './quality.js';
import { looksLikeBilibili } from './url.js';
import type {
  PreparedDownload,
  ResolvedSourceVideo,
  SourceProvider,
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

export interface BilibiliProviderDeps {
  configDir: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
}

export function createBilibiliProvider(deps: BilibiliProviderDeps): SourceProvider {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

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
      let qualities: ResolvedSourceVideo['qualities'] = [];
      const probe = parts.find((p) => p.page === ref.page) ?? parts[0];
      if (probe) {
        try {
          const streams = await fetchStreams(fetchImpl, ref, Number(probe.id));
          qualities = streams.qualities.map((q) => ({
            id: String(q.qn),
            label: q.label,
            ...(q.heightPx ? { heightPx: q.heightPx } : {}),
          }));
        } catch {
          /* leave empty; the UI hides the picker rather than lying */
        }
      }

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

      // An unparseable id would become NaN and silently request the wrong
      // quality, so treat it as "no preference" instead.
      const wantQn = qualityId !== undefined ? Number(qualityId) : undefined;
      const streams = await fetchStreams(
        fetchImpl,
        ref,
        Number(part.id),
        Number.isFinite(wantQn) ? wantQn : undefined,
      );

      return {
        videoUrl: streams.videoUrl,
        audioUrl: streams.audioUrl,
        baseName: partBaseName({ title: info.title, parts }, part),
        title: info.title,
        headers: mediaHeaders(),
      };
    },

  };
}

/** Human label for a Bilibili quality id (exported for tests). */
export { qualityLabel };
