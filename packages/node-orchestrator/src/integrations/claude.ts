/**
 * Connect Claude to VideoDubber's MCP server (packages/mcp-server), so the user
 * can ask Claude Desktop or Claude Code to dub, review and re-render videos.
 *
 * The server needs no separate install: the shipped orchestrator binary IS the
 * MCP server when run with `--mcp` (scripts/package/orchestrator-entry.mjs). In
 * a source checkout it is `node packages/mcp-server/dist/cli.js`.
 *
 * Claude Desktop reads `claude_desktop_config.json`. On Windows its location
 * depends on HOW Claude Desktop was installed: the regular installer reads
 * %APPDATA%\Claude, but the Microsoft Store (MSIX) build reads a package-private
 * copy of %APPDATA% under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming —
 * writing the regular path for a Store install is silently ignored, which is
 * exactly the machine this was written on (2026-11-17).
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppErrorException } from '@videodubber/shared';
import { writeTextAtomic } from '../workspace/projectStore.js';

/** The name the server is registered under in every client. */
export const MCP_SERVER_NAME = 'videodubber';

export interface McpLaunch {
  command: string;
  args: string[];
}

/**
 * How a client starts the MCP server on this machine, or undefined when this
 * build cannot (a source checkout whose mcp-server package was never built).
 */
export function mcpLaunchCommand(
  execPath: string = process.execPath,
  moduleUrl: string = import.meta.url,
  exists: (p: string) => boolean = existsSync,
): McpLaunch | undefined {
  // Packaged: this process IS videodubber-orchestrator; the same binary serves MCP.
  if (path.basename(execPath).toLowerCase().startsWith('videodubber-orchestrator')) {
    return { command: execPath, args: ['--mcp'] };
  }
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(moduleUrl));
  } catch {
    return undefined; // a bundle with no module path (should not happen outside the SEA)
  }
  for (let i = 0; i < 6; i++) {
    const cli = path.join(dir, 'mcp-server', 'dist', 'cli.js');
    if (exists(cli)) return { command: execPath, args: [cli] };
    dir = path.dirname(dir);
  }
  return undefined;
}

export interface ClaudeDesktopLocation {
  /** True when a Claude Desktop installation was found. */
  installed: boolean;
  /** The config file Claude Desktop reads on this machine. */
  configPath: string | undefined;
}

export interface LocateDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (p: string) => boolean;
  /** Directory entries, or [] when it does not exist. */
  list: (dir: string) => string[];
}

const systemLocateDeps = (): LocateDeps => ({
  platform: process.platform,
  env: process.env,
  home: os.homedir(),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

/** Where Claude Desktop's config lives here, and whether Claude Desktop is installed. */
export function locateClaudeDesktop(deps: LocateDeps = systemLocateDeps()): ClaudeDesktopLocation {
  const file = 'claude_desktop_config.json';
  if (deps.platform === 'darwin') {
    const dir = path.posix.join(deps.home, 'Library', 'Application Support', 'Claude');
    return {
      installed: deps.exists('/Applications/Claude.app') || deps.exists(dir),
      configPath: path.posix.join(dir, file),
    };
  }
  if (deps.platform === 'win32') {
    const w = path.win32;
    const local = deps.env.LOCALAPPDATA;
    const roaming = deps.env.APPDATA;
    const storeDirs = local
      ? deps
          .list(w.join(local, 'Packages'))
          .filter((n) => /^Claude_/i.test(n))
          .map((n) => w.join(local, 'Packages', n, 'LocalCache', 'Roaming', 'Claude'))
      : [];
    const regularDir = roaming ? w.join(roaming, 'Claude') : undefined;
    const regularInstalled = Boolean(
      (local && deps.exists(w.join(local, 'AnthropicClaude'))) || (regularDir && deps.exists(regularDir)),
    );
    const candidates = [...storeDirs, ...(regularDir ? [regularDir] : [])];
    // An existing config wins; then an existing Claude folder; then the Store
    // package (its app reads only the package-private copy); then %APPDATA%.
    const chosen =
      candidates.find((d) => deps.exists(w.join(d, file))) ??
      candidates.find((d) => deps.exists(d)) ??
      storeDirs[0] ??
      regularDir;
    return {
      installed: storeDirs.length > 0 || regularInstalled,
      configPath: chosen ? w.join(chosen, file) : undefined,
    };
  }
  const dir = path.posix.join(deps.home, '.config', 'Claude');
  return { installed: deps.exists(dir), configPath: path.posix.join(dir, file) };
}

/**
 * The config text with our server added (or replaced), every other setting
 * and server kept as it was. Refuses a file that is not a JSON object rather
 * than overwrite settings it cannot read.
 */
export function withMcpServer(existing: string | undefined, launch: McpLaunch | undefined): string {
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new AppErrorException('UNKNOWN', 'Claude Desktop\'s settings file is not valid JSON, so VideoDubber did not change it.', {
        remediation: 'Fix or remove claude_desktop_config.json (Claude Desktop → Settings → Developer → Edit Config), then connect again.',
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppErrorException('UNKNOWN', 'Claude Desktop\'s settings file has an unexpected shape, so VideoDubber did not change it.');
    }
    config = parsed as Record<string, unknown>;
  }
  const servers =
    typeof config.mcpServers === 'object' && config.mcpServers !== null && !Array.isArray(config.mcpServers)
      ? { ...(config.mcpServers as Record<string, unknown>) }
      : {};
  if (launch) servers[MCP_SERVER_NAME] = { command: launch.command, args: launch.args };
  else delete servers[MCP_SERVER_NAME];
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
}

/** Is our server registered in this config text, with exactly this command? */
export function connectedIn(existing: string | undefined, launch: McpLaunch | undefined): boolean {
  if (!existing || !launch) return false;
  try {
    const entry = (JSON.parse(existing) as { mcpServers?: Record<string, { command?: string; args?: string[] }> })
      .mcpServers?.[MCP_SERVER_NAME];
    return entry?.command === launch.command && JSON.stringify(entry.args ?? []) === JSON.stringify(launch.args);
  } catch {
    return false;
  }
}

/** The one-line Claude Code command (user scope, so every folder sees it). */
export function claudeCodeCommand(launch: McpLaunch): string {
  const q = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${[launch.command, ...launch.args].map(q).join(' ')}`;
}

export interface ClaudeIntegrationStatus {
  mcp: McpLaunch | null;
  claudeCode: { command: string } | null;
  claudeDesktop: { installed: boolean; configPath: string | null; connected: boolean };
}

export async function claudeIntegrationStatus(
  launch: McpLaunch | undefined = mcpLaunchCommand(),
  location: ClaudeDesktopLocation = locateClaudeDesktop(),
): Promise<ClaudeIntegrationStatus> {
  const text = location.configPath ? await readFile(location.configPath, 'utf8').catch(() => undefined) : undefined;
  return {
    mcp: launch ?? null,
    claudeCode: launch ? { command: claudeCodeCommand(launch) } : null,
    claudeDesktop: {
      installed: location.installed,
      configPath: location.configPath ?? null,
      connected: connectedIn(text, launch),
    },
  };
}

/**
 * Add (connect=true) or remove our server in Claude Desktop's config. The file
 * as it was is kept beside it as `.videodubber-backup` before any change.
 */
export async function setClaudeDesktopConnection(
  connect: boolean,
  launch: McpLaunch | undefined = mcpLaunchCommand(),
  location: ClaudeDesktopLocation = locateClaudeDesktop(),
): Promise<ClaudeIntegrationStatus> {
  if (!location.configPath) {
    throw new AppErrorException('UNKNOWN', 'Could not work out where Claude Desktop keeps its settings on this computer.');
  }
  if (connect && !launch) {
    throw new AppErrorException('UNKNOWN', 'This build of VideoDubber cannot start its MCP server.', {
      remediation: 'In a source checkout run `pnpm build` first (it builds packages/mcp-server).',
    });
  }
  const existing = await readFile(location.configPath, 'utf8').catch(() => undefined);
  const next = withMcpServer(existing, connect ? launch : undefined);
  if (existing !== undefined) await copyFile(location.configPath, `${location.configPath}.videodubber-backup`);
  await writeTextAtomic(location.configPath, next);
  return claudeIntegrationStatus(launch, location);
}
