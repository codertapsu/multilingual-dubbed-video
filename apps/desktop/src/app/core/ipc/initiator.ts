/**
 * Who asked, on every request the window sends to the orchestrator: it
 * records it on every job and edit (node-orchestrator activity/context.ts),
 * so the activity list and a project's edit history can tell the user's own
 * clicks from an agent's calls over MCP and from what the app starts by
 * itself. The desktop shell's Rust proxy sends the same for the commands it
 * forwards (orchestrator_client.rs).
 *
 * EventSource streams cannot send headers; they change nothing, so they need
 * none. The orchestrator's CORS answer allows the header and keeps its
 * preflight 10 minutes (server.ts).
 *
 * WHY: a 27.8-hour production ran mostly over MCP and nothing in the app said
 * who had started what (claude-dubber report, 2026-11-23, R3).
 */
export const INITIATOR_HEADER = 'x-vd-initiator';

/** `init` with the window's initiator header added (any other header kept). */
export function withInitiator(init: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  headers[INITIATOR_HEADER] = 'ui';
  return { ...init, headers };
}
