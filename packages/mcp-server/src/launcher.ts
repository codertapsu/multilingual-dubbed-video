/**
 * Start VideoDubber when Claude needs it and it is not running.
 *
 * In the shipped app this server is the `videodubber-orchestrator` sidecar run
 * with `--mcp` (see scripts/package/orchestrator-entry.mjs), which sits next to
 * the desktop app: `…\VideoDubber\videodubber-desktop.exe` on Windows, inside
 * `VideoDubber.app/Contents/MacOS/` on macOS. Starting the APP (not a bare
 * orchestrator) matters: the app owns the backend's lifecycle — workers, engine
 * shutdown, the single-instance guard — and the user sees what Claude is doing.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppNotRunningError, type VideoDubberApi } from './api.js';

export interface LaunchTarget {
  command: string;
  args: string[];
  /** What to call it in messages. */
  label: string;
}

/**
 * The desktop app to start, or undefined when this process cannot know (a dev
 * run under `node`, where `pnpm dev` / `pnpm app` is the way to start it).
 * VIDEODUBBER_APP points at the app explicitly: an executable, or a macOS
 * `.app` bundle.
 */
export function findDesktopApp(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): LaunchTarget | undefined {
  const explicit = env.VIDEODUBBER_APP?.trim();
  if (explicit) {
    if (platform === 'darwin' && explicit.endsWith('.app')) return { command: 'open', args: [explicit], label: explicit };
    return exists(explicit) ? { command: explicit, args: [], label: explicit } : undefined;
  }
  // Only the packaged sidecar knows where the app is; under `node` this is node.exe.
  // Split on both separators: path.basename on macOS keeps a Windows path whole.
  const name = execPath.split(/[\\/]/).pop() ?? execPath;
  if (!name.toLowerCase().startsWith('videodubber-orchestrator')) return undefined;
  if (platform === 'darwin') {
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath)?.[1];
    return bundle && exists(bundle) ? { command: 'open', args: [bundle], label: bundle } : undefined;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const app = pathApi.join(pathApi.dirname(execPath), platform === 'win32' ? 'videodubber-desktop.exe' : 'videodubber-desktop');
  return exists(app) ? { command: app, args: [], label: app } : undefined;
}

export interface EnsureAppOptions {
  target?: LaunchTarget;
  /** How long a cold start may take: the app boots three Python workers. */
  timeoutMs?: number;
  pollMs?: number;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
  signal?: AbortSignal;
}

/**
 * Make sure the app answers. Returns 'running' when it already did, 'started'
 * when this call launched it. Throws AppNotRunningError when it cannot be
 * started (dev run) or does not come up in time.
 */
export async function ensureAppRunning(api: VideoDubberApi, opts: EnsureAppOptions = {}): Promise<'running' | 'started'> {
  if (await api.isUp()) return 'running';
  const target = opts.target;
  if (!target) throw new AppNotRunningError(api.baseUrl);
  // Detached and silent: the app must outlive this MCP server (Claude Desktop
  // stops it on quit), and nothing may reach our stdout, which is the protocol.
  const child = (opts.spawnImpl ?? spawn)(target.command, target.args, { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
    if (await api.isUp()) return 'started';
  }
  throw new AppNotRunningError(api.baseUrl);
}
