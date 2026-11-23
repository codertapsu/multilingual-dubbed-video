/**
 * The AI agents driving the app: every MCP session seen in the last hour, with
 * its client, when it first and last called, and the tools it used last
 * (GET /activity/agents; the activity panel lists them).
 *
 * Fed by every request (activityRoutes.ts' onRequest hook) from the headers
 * the MCP server sends (packages/mcp-server/src/api.ts): `x-vd-initiator:
 * mcp`, `x-vd-client` (the client's name from its handshake), `x-vd-session`,
 * `x-vd-tool` (the tool being called) and `x-request-id` (the tool call). In
 * memory only: an hour is what is shown, and a restart ends the sessions
 * anyway (the installer closes every MCP connection).
 *
 * WHY: the 27.8-hour production was driven by an agent the user could not see
 * in the app at all; with several agents connected (Claude Code, Claude
 * Desktop, Mother Claude) nothing said which one did what (claude-dubber
 * report, 2026-11-23, R3).
 */
import type { ActivityAgentSession } from '@videodubber/shared';

import { headerValue } from './context.js';

const WINDOW_MS = 60 * 60_000;
const MAX_SESSIONS = 50;
const MAX_TOOLS = 8;
/** Tool-call ids remembered per session, to count calls rather than requests. */
const RECENT_CALLS = 20;

interface Session {
  session: string;
  client?: string;
  firstAt: number;
  lastAt: number;
  calls: number;
  tools: string[];
  recentCalls: string[];
}

export class AgentSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** One request to the app: counted when an MCP session sent it. */
  seen(headers: Record<string, string | string[] | undefined>): void {
    if (headerValue(headers['x-vd-initiator']) !== 'mcp') return;
    const id = headerValue(headers['x-vd-session']);
    if (!id) return;
    const now = this.now();
    let s = this.sessions.get(id);
    if (!s) {
      s = { session: id, firstAt: now, lastAt: now, calls: 0, tools: [], recentCalls: [] };
      this.sessions.set(id, s);
      this.prune(now);
    }
    s.lastAt = now;
    const client = headerValue(headers['x-vd-client']);
    if (client) s.client = client;
    const call = headerValue(headers['x-request-id']) ?? `request-${now}`;
    if (!s.recentCalls.includes(call)) {
      s.calls++;
      s.recentCalls.push(call);
      if (s.recentCalls.length > RECENT_CALLS) s.recentCalls.shift();
    }
    const tool = headerValue(headers['x-vd-tool']);
    if (tool && /^[\w.-]{1,64}$/.test(tool)) {
      s.tools = [tool, ...s.tools.filter((t) => t !== tool)].slice(0, MAX_TOOLS);
    }
  }

  /** The sessions seen in the last hour, the most recent first. */
  list(): ActivityAgentSession[] {
    const now = this.now();
    this.prune(now);
    return [...this.sessions.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((s) => ({
        session: s.session,
        ...(s.client ? { client: s.client } : {}),
        firstAt: new Date(s.firstAt).toISOString(),
        lastAt: new Date(s.lastAt).toISOString(),
        calls: s.calls,
        tools: [...s.tools],
      }));
  }

  /** Forget sessions older than the window, and the oldest beyond the cap. */
  private prune(now: number): void {
    for (const [id, s] of this.sessions) if (now - s.lastAt > this.windowMs) this.sessions.delete(id);
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const s of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(s.session);
  }
}
