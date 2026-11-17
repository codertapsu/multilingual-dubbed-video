/**
 * Serve the VideoDubber MCP server over stdio — how Claude Desktop and Claude
 * Code start local servers. In the shipped app this runs as
 * `videodubber-orchestrator --mcp` (scripts/package/orchestrator-entry.mjs);
 * from a source checkout, `node packages/mcp-server/dist/cli.js`.
 *
 * STDOUT IS THE PROTOCOL. Nothing else may ever be written to it: a single
 * stray console.log corrupts the JSON-RPC stream and the client drops the
 * server. Diagnostics go to stderr, which MCP clients keep as the server log.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { VideoDubberApi } from './api.js';
import { findDesktopApp } from './launcher.js';
import { createVideoDubberServer } from './server.js';

export interface StdioOptions {
  version?: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** `--url http://127.0.0.1:5100`, then VIDEODUBBER_URL, then the app's default port. */
export function resolveBaseUrl(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const i = argv.indexOf('--url');
  const fromArg = i >= 0 ? argv[i + 1] : undefined;
  return (fromArg ?? env.VIDEODUBBER_URL ?? 'http://127.0.0.1:5100').trim();
}

export async function runStdio(options: StdioOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const baseUrl = resolveBaseUrl(argv, env);
  const launch = findDesktopApp(process.execPath, env);
  const server = createVideoDubberServer({
    api: new VideoDubberApi({ baseUrl }),
    ...(launch ? { launch } : {}),
    version: options.version ?? env.VD_BUILD_VERSION ?? 'dev',
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `[videodubber-mcp] serving over stdio; app API ${baseUrl}${launch ? `; starts ${launch.label} when needed` : ''}`,
  );
}
