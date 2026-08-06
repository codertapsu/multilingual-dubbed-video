import {
  fetchVideoInfo,
  mediaHeaders,
  playUrl,
  resolveInput,
  type DouyinFetch,
} from './client.js';
import { looksLikeDouyin } from './url.js';
import type {
  PreparedDownload,
  ResolvedSourceVideo,
  SourceProvider,
  SourceQuality,
} from '../types.js';

/**
 * Douyin as a {@link SourceProvider}.
 *
 * Much smaller than the Bilibili provider, and that is the point: the contract
 * asked for `matches`, `resolve` and `prepare`, and a source with one stream,
 * one part and no credential implements exactly those and nothing else.
 *
 * Three parts of the contract that Bilibili needed are simply absent here:
 *   - `audioUrl` is omitted, because Douyin serves one already-muxed file, so
 *     no ffmpeg merge runs at all.
 *   - `session` is omitted, so the credentials card does not appear for it.
 *   - `parts` has a single entry, so the part picker hides itself.
 */

export const DOUYIN_PROVIDER_ID = 'douyin';

export interface DouyinProviderDeps {
  /** Injectable for tests. */
  fetchImpl?: DouyinFetch;
}

export function createDouyinProvider(deps: DouyinProviderDeps = {}): SourceProvider {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as DouyinFetch);

  return {
    id: DOUYIN_PROVIDER_ID,

    matches: (input) => looksLikeDouyin(input),

    async resolve(input): Promise<ResolvedSourceVideo> {
      const ref = await resolveInput(fetchImpl, input);
      const info = await fetchVideoInfo(fetchImpl, ref);

      // One stream, so one quality. Reporting the height we were told keeps the
      // target ladder honest: asking for 4K on a 1080p clip resolves to 1080p
      // through the same rule every other source uses.
      const qualities: SourceQuality[] = info.heightPx
        ? [{ id: String(info.heightPx), label: `${info.heightPx}p`, heightPx: info.heightPx }]
        : [];

      return {
        providerId: DOUYIN_PROVIDER_ID,
        title: info.title,
        ...(info.coverUrl ? { coverUrl: info.coverUrl } : {}),
        durationSec: info.durationSec,
        ...(info.ownerName ? { ownerName: info.ownerName } : {}),
        // A Douyin post is always a single video; the page picker stays hidden.
        parts: [
          {
            id: info.awemeId,
            page: 1,
            title: info.title,
            durationSec: info.durationSec,
          },
        ],
        requestedPage: 1,
        qualities,
      };
    },

    async prepare(input): Promise<PreparedDownload> {
      const ref = await resolveInput(fetchImpl, input);
      const info = await fetchVideoInfo(fetchImpl, ref);

      // The target height is accepted and ignored on purpose: there is exactly
      // one stream, so every target resolves to it. Pretending to honour a
      // choice we cannot make would be worse than plainly taking what exists.
      return {
        videoUrl: playUrl(info.playUri),
        baseName: info.title,
        title: info.title,
        headers: mediaHeaders(),
      };
    },
  };
}
