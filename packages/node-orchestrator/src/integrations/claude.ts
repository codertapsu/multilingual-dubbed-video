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
 *
 * Claude Code is connected through its own CLI only (`claude mcp add|remove`):
 * its `.claude.json` holds the user's whole Claude Code state, so VideoDubber
 * reads it for the status and never writes it. Mother Claude starts Claude Code
 * sessions, so a user-scope connection reaches every session it starts.
 */
import { spawn } from 'node:child_process';
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
  // Split on both separators: path.basename on macOS keeps a Windows path whole.
  const name = execPath.split(/[\\/]/).pop() ?? execPath;
  if (name.toLowerCase().startsWith('videodubber-orchestrator')) {
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

// ---- Claude Code ---------------------------------------------------------------

/** Where Claude Code's install guide lives (the "not found" state links to it). */
export const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';

/** A `claude` CLI found on this computer, and how it must be started. */
export interface ClaudeCli {
  path: string;
  /**
   * An npm install's `claude.cmd`. Node refuses to spawn a .cmd/.bat without a
   * shell (CVE-2024-27980), so it runs through cmd.exe with a quoted line.
   */
  viaShell: boolean;
}

/** What a CLI run printed (stdout and stderr together) and how it ended. */
export interface CliResult {
  /** null when it was stopped (the timeout) instead of exiting. */
  code: number | null;
  output: string;
}

export interface ClaudeCodeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (p: string) => boolean;
  /** Read a file as UTF-8; rejects with the fs error (ENOENT for "no file"). */
  readText: (p: string) => Promise<string>;
  run: (cli: ClaudeCli, args: readonly string[]) => Promise<CliResult>;
}

/**
 * The file Claude Code keeps user-scope MCP servers in: `.claude.json` in
 * CLAUDE_CONFIG_DIR when that is set (an account with its own folder), else in
 * the home folder.
 */
export function claudeCodeConfigPath(deps: Pick<ClaudeCodeDeps, 'platform' | 'env' | 'home'>): string {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const dir = deps.env.CLAUDE_CONFIG_DIR?.trim();
  return p.join(dir || deps.home, '.claude.json');
}

/**
 * Find the `claude` CLI: PATH first, then where its installers put it. A GUI
 * app on macOS starts with a minimal PATH (no ~/.local/bin, no Homebrew), so
 * there the fallbacks are what find it. On Windows the native installer puts
 * `claude.exe` in %USERPROFILE%\.local\bin; an npm install has only
 * `claude.cmd`.
 */
export function findClaudeCli(deps: Pick<ClaudeCodeDeps, 'platform' | 'env' | 'home' | 'exists'>): ClaudeCli | undefined {
  const win = deps.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
  const dirs = pathVar
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const full = p.join(dir, name);
      if (deps.exists(full)) return { path: full, viaShell: win && name.endsWith('.cmd') };
    }
  }
  const fallbacks: ClaudeCli[] = win
    ? [
        { path: p.join(deps.home, '.local', 'bin', 'claude.exe'), viaShell: false },
        ...(deps.env.APPDATA ? [{ path: p.join(deps.env.APPDATA, 'npm', 'claude.cmd'), viaShell: true }] : []),
      ]
    : [
        { path: p.join(deps.home, '.local', 'bin', 'claude'), viaShell: false },
        { path: '/opt/homebrew/bin/claude', viaShell: false },
        { path: '/usr/local/bin/claude', viaShell: false },
      ];
  return fallbacks.find((f) => deps.exists(f.path));
}

/**
 * The cmd.exe line for a `.cmd` CLI. Every argument is quoted, so a space or
 * `& | < > ^ ( )` stays literal. A `"` or `%` cannot be made literal for
 * cmd.exe at all, so such an argument is refused rather than run wrong. Pure.
 */
export function cmdLine(cli: string, args: readonly string[]): string {
  for (const a of [cli, ...args]) {
    if (/["%\r\n]/.test(a)) {
      throw new AppErrorException('UNKNOWN', `Cannot pass ${JSON.stringify(a)} to claude.cmd safely through cmd.exe.`, {
        remediation: 'Run the command shown in Settings → Claude yourself, in a terminal.',
      });
    }
  }
  return [cli, ...args].map((a) => `"${a}"`).join(' ');
}

/** `claude mcp add` for this app, at user scope so every folder and session sees it. */
export function claudeCodeAddArgs(launch: McpLaunch): string[] {
  return ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', launch.command, ...launch.args];
}

/** `claude mcp remove` for the user-scope entry. */
export const CLAUDE_CODE_REMOVE_ARGS: readonly string[] = ['mcp', 'remove', MCP_SERVER_NAME, '-s', 'user'];

/** How long one CLI call may take (it starts in about a second). */
const CLI_TIMEOUT_MS = 60_000;

/** Run the CLI hidden, with a timeout; never rejects for a non-zero exit. */
export function runClaudeCli(
  cli: ClaudeCli,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = os.homedir(),
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // The CLI's own folder first: an npm install's `claude` is a node script,
    // and a macOS GUI app's minimal PATH may not reach that node otherwise.
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const childEnv = { ...env, [pathKey]: [path.dirname(cli.path), env[pathKey] ?? ''].filter(Boolean).join(path.delimiter) };
    const options = { cwd, env: childEnv, windowsHide: true, timeout: CLI_TIMEOUT_MS };
    const child = cli.viaShell
      ? spawn(cmdLine(cli.path, args), { ...options, shell: true })
      : spawn(cli.path, [...args], options);
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: output.trim() }));
  });
}

const systemClaudeCodeDeps = (): ClaudeCodeDeps => ({
  platform: process.platform,
  env: process.env,
  home: os.homedir(),
  exists: existsSync,
  readText: (p) => readFile(p, 'utf8'),
  run: (cli, args) => runClaudeCli(cli, args),
});

/**
 * Connected: our name is registered with exactly this app's command.
 * Other copy: our name points elsewhere (a reinstall or move, a dev checkout).
 * Unreadable: `.claude.json` exists but cannot be read or parsed.
 * Claude Code not found: no entry, and no CLI to make one with.
 */
export type ClaudeCodeState = 'connected' | 'not-connected' | 'other-copy' | 'unreadable' | 'cli-missing';

export interface ClaudeCodeStatus {
  state: ClaudeCodeState;
  /** The one-line command, for doing it by hand. */
  command: string;
  /** The CLI the buttons run, or null when Claude Code was not found. */
  cli: string | null;
  /** The file the status was read from. */
  configPath: string;
  /** What our name points to now, when it is not this app. */
  registered: McpLaunch | null;
  /** Why the file could not be read. */
  detail?: string;
}

/** Claude Code's view of VideoDubber, read from `.claude.json` (never written here). */
export async function claudeCodeStatus(
  launch: McpLaunch,
  deps: ClaudeCodeDeps = systemClaudeCodeDeps(),
): Promise<ClaudeCodeStatus> {
  const configPath = claudeCodeConfigPath(deps);
  const cli = findClaudeCli(deps);
  const base = { command: claudeCodeCommand(launch), cli: cli?.path ?? null, configPath, registered: null };
  let text: string | undefined;
  try {
    text = await deps.readText(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { ...base, state: 'unreadable', detail: (err as Error)?.message ?? String(err) };
    }
  }
  let entry: unknown;
  if (text !== undefined && text.trim()) {
    try {
      entry = (JSON.parse(text) as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[MCP_SERVER_NAME];
    } catch {
      return { ...base, state: 'unreadable', detail: `${configPath} is not valid JSON` };
    }
  }
  if (entry && typeof entry === 'object') {
    if (connectedIn(text, launch)) return { ...base, state: 'connected' };
    const e = entry as { command?: unknown; args?: unknown };
    return {
      ...base,
      state: 'other-copy',
      registered: { command: String(e.command ?? ''), args: Array.isArray(e.args) ? e.args.map(String) : [] },
    };
  }
  return { ...base, state: cli ? 'not-connected' : 'cli-missing' };
}

export type ClaudeCodeAction = 'connect' | 'reconnect' | 'disconnect';

/** The CLI's own words, as the error the user sees. */
function cliFailure(step: 'add' | 'remove', result: CliResult): AppErrorException {
  const what = step === 'add' ? 'add VideoDubber' : 'remove VideoDubber';
  const said = result.output || (result.code === null ? 'it did not finish in time' : `exit code ${result.code}`);
  return new AppErrorException('UNKNOWN', `Claude Code could not ${what}: ${said}`, {
    remediation: 'Try again, or run the command shown in Settings → Claude yourself, in a terminal.',
  });
}

/**
 * Connect, reconnect or disconnect Claude Code through its CLI. Reconnect is
 * remove-then-add (`add` refuses a name that exists). Removing an entry that
 * is not there is not an error: that is the state asked for.
 */
export async function setClaudeCodeConnection(
  action: ClaudeCodeAction,
  launch: McpLaunch | undefined = mcpLaunchCommand(),
  deps: ClaudeCodeDeps = systemClaudeCodeDeps(),
): Promise<ClaudeCodeStatus> {
  if (action !== 'connect' && action !== 'reconnect' && action !== 'disconnect') {
    throw new AppErrorException('UNKNOWN', `Unknown Claude Code action "${String(action)}".`);
  }
  if (!launch) {
    throw new AppErrorException('UNKNOWN', 'This build of VideoDubber cannot start its MCP server.', {
      remediation: 'In a source checkout run `pnpm build` first (it builds packages/mcp-server).',
    });
  }
  const cli = findClaudeCli(deps);
  if (!cli) {
    throw new AppErrorException('UNKNOWN', 'Claude Code was not found on this computer.', {
      remediation: `Install Claude Code (${CLAUDE_CODE_INSTALL_URL}), then connect again.`,
    });
  }
  if (action !== 'connect') {
    const removed = await deps.run(cli, CLAUDE_CODE_REMOVE_ARGS);
    if (removed.code !== 0 && !/no mcp server named/i.test(removed.output)) throw cliFailure('remove', removed);
  }
  if (action !== 'disconnect') {
    const added = await deps.run(cli, claudeCodeAddArgs(launch));
    if (added.code !== 0) throw cliFailure('add', added);
  }
  return claudeCodeStatus(launch, deps);
}

// ---- Mother Claude ---------------------------------------------------------------

/** Mother Claude's local health endpoint (no token needed). */
export const MOTHER_CLAUDE_HEALTH_URL = 'http://127.0.0.1:6725/api/health';
export const MOTHER_CLAUDE_DOWNLOAD_URL = 'https://github.com/codertapsu/mother-claude/releases';

export interface MotherClaudeStatus {
  running: boolean;
  version: string | null;
}

/**
 * Is Mother Claude running here? It starts Claude Code sessions, so it uses the
 * Claude Code connection; this only tells the guide what to show. Never throws.
 */
export async function probeMotherClaude(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 800,
): Promise<MotherClaudeStatus> {
  try {
    const res = await fetchImpl(MOTHER_CLAUDE_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: false, version: null };
    const body = (await res.json()) as { app?: unknown; version?: unknown };
    if (body?.app !== 'mother-claude') return { running: false, version: null };
    return { running: true, version: typeof body.version === 'string' ? body.version : null };
  } catch {
    return { running: false, version: null };
  }
}

// ---- Status for Settings → Claude --------------------------------------------------

export interface ClaudeIntegrationStatus {
  mcp: McpLaunch | null;
  claudeCode: ClaudeCodeStatus | null;
  claudeDesktop: { installed: boolean; configPath: string | null; connected: boolean };
  motherClaude: MotherClaudeStatus;
}

/** What the status reads, injectable for tests. */
export interface IntegrationDeps {
  claudeCode: ClaudeCodeDeps;
  motherClaude: () => Promise<MotherClaudeStatus>;
}

export const systemIntegrationDeps = (): IntegrationDeps => ({
  claudeCode: systemClaudeCodeDeps(),
  motherClaude: () => probeMotherClaude(),
});

export async function claudeIntegrationStatus(
  launch: McpLaunch | undefined = mcpLaunchCommand(),
  location: ClaudeDesktopLocation = locateClaudeDesktop(),
  deps: IntegrationDeps = systemIntegrationDeps(),
): Promise<ClaudeIntegrationStatus> {
  const [text, claudeCode, motherClaude] = await Promise.all([
    location.configPath ? readFile(location.configPath, 'utf8').catch(() => undefined) : Promise.resolve(undefined),
    launch ? claudeCodeStatus(launch, deps.claudeCode) : Promise.resolve(null),
    deps.motherClaude(),
  ]);
  return {
    mcp: launch ?? null,
    claudeCode,
    claudeDesktop: {
      installed: location.installed,
      configPath: location.configPath ?? null,
      connected: connectedIn(text, launch),
    },
    motherClaude,
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
  deps: IntegrationDeps = systemIntegrationDeps(),
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
  return claudeIntegrationStatus(launch, location, deps);
}
