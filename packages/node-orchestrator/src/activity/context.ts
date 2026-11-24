import { AsyncLocalStorage } from 'node:async_hooks';

import type { ActivityInitiator } from '@videodubber/shared';

/**
 * Who started the request being handled, available anywhere below the route
 * without threading it through every call: jobs and edits record it
 * (activity/registry.ts, activity/history.ts).
 *
 * Set per request from headers (`initiatorFromHeaders`): the desktop window
 * sends `x-vd-initiator: ui`; the MCP server sends `mcp` with the client's name
 * and session; the app's own starts (series parts, retries) run inside
 * {@link runAsScheduler}. Absent: `unknown` (curl, a script).
 */
const storage = new AsyncLocalStorage<{ initiator: ActivityInitiator; requestId?: string }>();

export function currentInitiator(): ActivityInitiator {
  return storage.getStore()?.initiator ?? { kind: 'unknown' };
}

/**
 * The agent's tool call behind the current request (`x-request-id`, `mcp-…`),
 * when there is one: what its tool errors call the log reference, so an
 * activity it started can be found in the same log lines.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Run `fn` with `initiator` as the current one (a request, or work the app starts itself). */
export function runWithInitiator<T>(initiator: ActivityInitiator, fn: () => T, extra: { requestId?: string } = {}): T {
  return storage.run({ initiator, ...(extra.requestId ? { requestId: extra.requestId } : {}) }, fn);
}

/** Work the app starts on its own (a series starting its parts, a retry once models are in). */
export function runAsScheduler<T>(fn: () => T): T {
  return runWithInitiator({ kind: 'scheduler' }, fn);
}

/**
 * One header's value, cleaned: the first of several, trimmed, control
 * characters dropped, at most 120 characters. The MCP server percent-encodes
 * what it sends (`x-vd-client: Claude%20Desktop`): an HTTP header carries no
 * Vietnamese or Chinese, and a client may well be named in them. A value that
 * is not valid percent-encoding (a stray `%` from curl) is kept as it came.
 */
export function headerValue(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  let t = s?.trim();
  if (!t) return undefined;
  if (t.includes('%')) {
    try {
      t = decodeURIComponent(t);
    } catch {
      /* not percent-encoded after all */
    }
  }
  // eslint-disable-next-line no-control-regex
  const clean = t.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, 120) : undefined;
}

/** The initiator a request's headers declare (`x-vd-initiator`, `x-vd-client`, `x-vd-session`). */
export function initiatorFromHeaders(headers: Record<string, string | string[] | undefined>): ActivityInitiator {
  const kind = headerValue(headers['x-vd-initiator']);
  const client = headerValue(headers['x-vd-client']);
  const session = headerValue(headers['x-vd-session']);
  const k = kind === 'ui' || kind === 'mcp' || kind === 'scheduler' ? kind : 'unknown';
  return { kind: k, ...(client ? { client } : {}), ...(session ? { session } : {}) };
}
