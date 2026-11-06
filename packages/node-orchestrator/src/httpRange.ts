/**
 * HTTP byte-range parsing for the `/file` preview route (RFC 9110 §14).
 *
 * WHY: WebKit — so WKWebView, the macOS shell's webview — plays and seeks a
 * `<video>`/`<audio>` only when the server honours `Range`: it probes with
 * `Range: bytes=0-1` and gives up on a server that answers 200 with the whole
 * body. `/file` used to stream the entire file for every request, which is why
 * the in-app preview fell back to "preview unavailable" in the desktop app and
 * why a timeline scrub could never seek a long video. Chromium (WebView2)
 * tolerates a 200 but re-downloads from byte 0 on every seek.
 *
 * Single ranges only: a multi-range request is answered with the full body (a
 * server MAY ignore Range, and no media element sends multipart ranges).
 */

/** What to send for a request against a file of `size` bytes. */
export type RangeDecision =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/** Decide the response for a `Range` header. Pure. */
export function decideRange(header: string | undefined, size: number): RangeDecision {
  if (!header) return { kind: 'full' };
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match) return { kind: 'full' }; // an unknown unit is ignored, not refused
  const spec = match[1]!.trim();
  if (spec.includes(',')) return { kind: 'full' };
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts) return { kind: 'full' };
  const [, rawStart, rawEnd] = parts;
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
