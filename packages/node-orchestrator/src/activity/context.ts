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
const storage = new AsyncLocalStorage<{ initiator: ActivityInitiator }>();

export function currentInitiator(): ActivityInitiator {
  return storage.getStore()?.initiator ?? { kind: 'unknown' };
}

/** Run `fn` with `initiator` as the current one (a request, or work the app starts itself). */
export function runWithInitiator<T>(initiator: ActivityInitiator, fn: () => T): T {
  return storage.run({ initiator }, fn);
}

/** Work the app starts on its own (a series starting its parts, a retry once models are in). */
export function runAsScheduler<T>(fn: () => T): T {
  return runWithInitiator({ kind: 'scheduler' }, fn);
}

const header = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t.slice(0, 120) : undefined;
};

/** The initiator a request's headers declare (`x-vd-initiator`, `x-vd-client`, `x-vd-session`). */
export function initiatorFromHeaders(headers: Record<string, string | string[] | undefined>): ActivityInitiator {
  const kind = header(headers['x-vd-initiator']);
  const client = header(headers['x-vd-client']);
  const session = header(headers['x-vd-session']);
  const k = kind === 'ui' || kind === 'mcp' || kind === 'scheduler' ? kind : 'unknown';
  return { kind: k, ...(client ? { client } : {}), ...(session ? { session } : {}) };
}
