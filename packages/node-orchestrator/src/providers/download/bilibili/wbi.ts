import { createHash } from 'node:crypto';

/**
 * Request signing for Bilibili's `wbi` endpoints.
 *
 * The playback-URL endpoint rejects unsigned queries, so this is not optional
 * decoration — without it every request comes back with an auth error and no
 * hint as to why. The scheme is public and simple: the site serves two image
 * URLs whose FILENAMES are the signing material, those are shuffled by a fixed
 * index table into a 32-character key, and each request is signed by hashing
 * its sorted query string plus that key.
 *
 * Kept separate from the HTTP client so it can be tested without a network:
 * a signing bug produces an opaque server-side rejection, which is exactly the
 * kind of failure that is miserable to debug from the outside.
 */

/**
 * The published index permutation used to derive the mixin key. It is part of
 * the wire protocol, like a magic number in a file header — not a tunable.
 *
 * EXACTLY 64 entries, a permutation of 0..63 over the 64 characters of
 * `img_key + sub_key`. Any other table silently yields a well-formed but WRONG
 * key: the request still looks valid and, because Bilibili does not currently
 * enforce the signature on the anonymous playurl path, it still succeeds — so a
 * corrupt table survives live testing and only surfaces if enforcement is
 * turned on. Verified identical to both reference implementations.
 */
const MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** Take the filename (without extension) out of one of the `wbi_img` URLs. */
export function wbiKeyPart(url: string | undefined): string {
  if (!url) return '';
  const last = url.split('/').pop() ?? '';
  const dot = last.indexOf('.');
  return dot === -1 ? last : last.slice(0, dot);
}

/**
 * Derive the 32-character mixin key from the two `wbi_img` URLs.
 *
 * Truncating to 32 is part of the scheme, not a safety measure — the table
 * indexes past that point and the server expects only the first 32.
 */
export function mixinKey(imgUrl: string | undefined, subUrl: string | undefined): string {
  const raw = wbiKeyPart(imgUrl) + wbiKeyPart(subUrl);
  let out = '';
  for (const index of MIXIN_KEY_TABLE) {
    if (index < raw.length) out += raw[index];
  }
  return out.slice(0, 32);
}

/**
 * `!'()*` are legal in a query string but the server hashes them as if they
 * were absent, so they are stripped from values before signing AND before
 * sending. Leaving them in makes the signature disagree with the request for
 * exactly the titles that contain punctuation.
 */
function sanitize(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

/**
 * Sign a query.
 *
 * `nowSeconds` is injected rather than read from the clock so the signature is
 * reproducible in a test — the timestamp is part of the hashed input.
 */
export function signWbi(
  params: Record<string, string | number>,
  key: string,
  nowSeconds: number,
): Record<string, string> {
  const withTs: Record<string, string> = { wts: String(nowSeconds) };
  for (const [k, v] of Object.entries(params)) withTs[k] = sanitize(String(v));

  // Sorted by key: the server hashes the canonical ordering, not ours.
  const canonical = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(withTs[k] as string)}`)
    .join('&');

  const wRid = createHash('md5').update(canonical + key).digest('hex');
  return { ...withTs, w_rid: wRid };
}

/** Build a signed query string ready to append to a wbi endpoint. */
export function signedQuery(
  params: Record<string, string | number>,
  key: string,
  nowSeconds: number,
): string {
  const signed = signWbi(params, key, nowSeconds);
  return new URLSearchParams(signed).toString();
}
