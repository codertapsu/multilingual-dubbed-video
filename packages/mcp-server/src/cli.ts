#!/usr/bin/env node
/**
 * `videodubber-mcp` — the MCP server for a source checkout (the shipped app
 * runs the same server as `videodubber-orchestrator --mcp`). Needs the app's
 * backend running: `pnpm dev` or `pnpm app`.
 */
import { runStdio } from './stdio.js';

runStdio().catch((err: unknown) => {
  console.error('[videodubber-mcp] failed to start:', err);
  process.exit(1);
});
