// SEA / single-executable entry for the Node orchestrator — and, run with
// `--mcp`, for the MCP server that Claude Desktop / Claude Code start over
// stdio (packages/mcp-server).
//
// The orchestrator's dist/server.js only auto-starts when its isMain() guard
// (`fileURLToPath(import.meta.url) === process.argv[1]`) is true. Inside a Node
// SEA binary there is no real module path, so that guard never fires: this
// entry starts it explicitly, and esbuild bundles THIS file (all deps inlined).
//
// Both modes are DYNAMIC imports on purpose. esbuild then initializes only the
// branch that runs; in MCP mode stdout is the JSON-RPC stream, and any server
// module that printed while loading would corrupt it.
//
// build-stamp.json is written by build-orchestrator.{ps1,sh} right before the
// bundle (version from tauri.conf.json, git commit, build time). It is set as
// the global buildInfo.ts reads BEFORE either mode loads, because buildInfo
// resolves once, at import. Without it every shipped build reported version
// "unknown" on GET /health — the stamp that exists to prove which build shipped.
import stamp from './build-stamp.json' with { type: 'json' };

globalThis.__VD_BUILD__ = stamp;

if (process.argv.includes('--mcp')) {
  import('../../packages/mcp-server/dist/stdio.js')
    .then(({ runStdio }) => runStdio({ version: stamp.version }))
    .catch((err) => {
      // stderr only: stdout belongs to the protocol.
      console.error('[videodubber-mcp] failed to start:', err);
      process.exit(1);
    });
} else {
  import('../../packages/node-orchestrator/dist/server.js')
    .then(({ startServer }) => startServer())
    .catch((err) => {
      console.error('[orchestrator] failed to start:', err);
      process.exit(1);
    });
}
