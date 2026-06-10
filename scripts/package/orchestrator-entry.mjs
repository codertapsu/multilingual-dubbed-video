// SEA / single-executable entry for the Node orchestrator.
//
// The orchestrator's dist/server.js only auto-starts when its isMain() guard
// (`fileURLToPath(import.meta.url) === process.argv[1]`) is true. Inside a Node
// SEA binary there is no real module path, so that guard never fires. This entry
// imports the exported startServer() and calls it unconditionally, then esbuild
// bundles THIS file (with all deps inlined) for the SEA blob.
import { startServer } from '../../packages/node-orchestrator/dist/server.js';

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[orchestrator] failed to start:', err);
  process.exit(1);
});
