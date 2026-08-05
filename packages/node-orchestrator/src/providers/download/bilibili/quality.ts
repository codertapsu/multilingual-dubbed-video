/**
 * Quality and codec tables for Bilibili DASH streams, plus the stream-picking
 * rules.
 *
 * Kept separate from the HTTP client so the selection rules are testable
 * without a network: picking the wrong stream is silent — you get a file, it
 * plays, and only the dubbing run afterwards is slower or lower quality than
 * it should have been.
 */

/** `qn` quality codes, best first. Values are Bilibili's, not ours. */
export const QUALITY_LABELS: Record<number, string> = {
  127: '8K',
  126: 'Dolby Vision',
  125: 'HDR',
  120: '4K',
  116: '1080p60',
  112: '1080p+',
  80: '1080p',
  74: '720p60',
  64: '720p',
  32: '480p',
  16: '360p',
  6: '240p',
};

/**
 * Codec ids from the DASH response.
 *
 * Both reference implementations carry the same three.
 */
export const CODEC_AVC = 7;
export const CODEC_HEVC = 12;
export const CODEC_AV1 = 13;

export const CODEC_LABELS: Record<number, string> = {
  [CODEC_AVC]: 'AVC',
  [CODEC_HEVC]: 'HEVC',
  [CODEC_AV1]: 'AV1',
};

/**
 * Codec preference for a DUBBING source, best first.
 *
 * Deliberately the opposite of a "smallest file" preference. Bilibili offers
 * every quality in all three codecs, and at a given resolution AV1/HEVC are far
 * smaller — but this file is not the deliverable, it is the INPUT to a pipeline
 * that must decode it repeatedly (transcribe, align, mix, re-encode). AVC
 * decodes fastest and is the one format every downstream tool handles without
 * argument, so a slightly larger download buys a materially faster, less
 * fragile dub. The size difference is a one-off; the decode cost is not.
 */
const CODEC_PREFERENCE = [CODEC_AVC, CODEC_HEVC, CODEC_AV1];

/** A DASH video stream as the API returns it (fields we care about). */
export interface DashVideo {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  height?: number;
  width?: number;
  codecid?: number;
  codecs?: string;
  bandwidth?: number;
}

/** A DASH audio stream. */
export interface DashAudio {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  codecs?: string;
  bandwidth?: number;
}

/** A quality the user can actually be given for this video, right now. */
export interface QualityOption {
  /** Bilibili `qn` code. */
  qn: number;
  label: string;
  heightPx?: number;
}

/** Human label for a `qn`, falling back to the raw number. */
export function qualityLabel(qn: number): string {
  return QUALITY_LABELS[qn] ?? String(qn);
}

/**
 * The qualities actually on offer, best first.
 *
 * Derived from the DASH streams themselves, NOT from the response's
 * `accept_quality` field. `accept_quality` lists what the VIDEO supports, which
 * for a logged-out client is routinely far more than what is served — a real
 * response advertised 1080p+ while delivering only 480p and 360p. Offering the
 * user a quality that cannot be delivered is worse than not offering it.
 */
export function availableQualities(videos: readonly DashVideo[]): QualityOption[] {
  const byQn = new Map<number, QualityOption>();
  for (const v of videos) {
    if (v.id === undefined) continue;
    const existing = byQn.get(v.id);
    if (!existing) {
      byQn.set(v.id, {
        qn: v.id,
        label: qualityLabel(v.id),
        ...(v.height ? { heightPx: v.height } : {}),
      });
    } else if (!existing.heightPx && v.height) {
      existing.heightPx = v.height;
    }
  }
  return [...byQn.values()].sort((a, b) => b.qn - a.qn);
}

/**
 * Pick the video stream to download.
 *
 * `wantQn` is a request, not a guarantee: the caller may ask for a quality this
 * account tier cannot receive, so fall back to the best on offer rather than
 * failing. Among streams of the chosen quality, prefer the codec the dubbing
 * pipeline handles best, then the highest bitrate.
 */
export function pickVideo(
  videos: readonly DashVideo[],
  wantQn?: number,
): DashVideo | undefined {
  if (videos.length === 0) return undefined;

  const qualities = availableQualities(videos);
  const target =
    wantQn !== undefined && qualities.some((q) => q.qn === wantQn)
      ? wantQn
      : (qualities[0]?.qn ?? undefined);

  const candidates = videos.filter((v) => v.id === target);
  const pool = candidates.length > 0 ? candidates : [...videos];

  return [...pool].sort((a, b) => {
    const rank = (v: DashVideo): number => {
      const idx = CODEC_PREFERENCE.indexOf(v.codecid ?? -1);
      // An unknown codec sorts last rather than first: a new codec id is more
      // likely to be exotic than to be the safe one.
      return idx === -1 ? CODEC_PREFERENCE.length : idx;
    };
    const byCodec = rank(a) - rank(b);
    if (byCodec !== 0) return byCodec;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  })[0];
}

/**
 * Pick the audio stream: highest bitrate wins.
 *
 * Explicitly NOT "highest id". Within the plain audio list the ids happen to
 * ascend with bitrate (30216 < 30232 < 30280), which makes id-ordering look
 * correct — but Dolby (30250) and Hi-Res (30251) carry higher ids while
 * arriving in separate response fields, so any future handling of those turns
 * the coincidence into a bug. Bandwidth is what the ordering actually means.
 */
export function pickAudio(audios: readonly DashAudio[]): DashAudio | undefined {
  if (audios.length === 0) return undefined;
  return [...audios].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}

/** DASH streams carry the URL under one of two spellings depending on the field. */
export function streamUrl(s: DashVideo | DashAudio | undefined): string | undefined {
  return s?.baseUrl ?? s?.base_url;
}
