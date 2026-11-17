import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_REMOVE_ARGS,
  claudeCodeAddArgs,
  claudeCodeCommand,
  claudeCodeConfigPath,
  claudeCodeStatus,
  cmdLine,
  connectedIn,
  findClaudeCli,
  locateClaudeDesktop,
  mcpLaunchCommand,
  probeMotherClaude,
  runClaudeCli,
  setClaudeCodeConnection,
  setClaudeDesktopConnection,
  withMcpServer,
  type ClaudeCli,
  type ClaudeCodeDeps,
  type CliResult,
  type IntegrationDeps,
  type LocateDeps,
} from './claude.js';

const EXE = 'C:\\Users\\me\\AppData\\Local\\VideoDubber\\videodubber-orchestrator.exe';

describe('mcpLaunchCommand', () => {
  it('the shipped orchestrator binary is the MCP server itself', () => {
    expect(mcpLaunchCommand(EXE)).toEqual({ command: EXE, args: ['--mcp'] });
  });

  it('a source checkout runs the built mcp-server CLI under node', () => {
    // path.resolve, not a bare '/repo': on Windows that is drive-relative, and
    // the file-URL round trip inside mcpLaunchCommand turns it into D:\repo.
    const root = path.resolve('/repo');
    const here = path.join(root, 'packages', 'node-orchestrator', 'src', 'integrations', 'claude.ts');
    const cli = path.join(root, 'packages', 'mcp-server', 'dist', 'cli.js');
    const got = mcpLaunchCommand('/usr/bin/node', pathToFileURL(here).href, (p) => p === cli);
    expect(got).toEqual({ command: '/usr/bin/node', args: [cli] });
    expect(mcpLaunchCommand('/usr/bin/node', pathToFileURL(here).href, () => false)).toBeUndefined();
  });
});

describe('locateClaudeDesktop', () => {
  const win = (existing: string[], packages: string[] = []): LocateDeps => ({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    home: 'C:\\Users\\me',
    exists: (p) => existing.includes(p),
    list: (dir) => (dir === 'C:\\Users\\me\\AppData\\Local\\Packages' ? packages : []),
  });

  it('a Microsoft Store install reads its package-private copy (this machine, before any config exists)', () => {
    const loc = locateClaudeDesktop(win([], ['Claude_pzs8sxrjxfjjc', 'Microsoft.Windows.Photos_8wekyb3d8bbwe']));
    expect(loc).toEqual({
      installed: true,
      configPath:
        'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    });
  });

  it('the regular installer reads %APPDATA%\\Claude', () => {
    const loc = locateClaudeDesktop(win(['C:\\Users\\me\\AppData\\Local\\AnthropicClaude']));
    expect(loc).toEqual({ installed: true, configPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json' });
  });

  it('an existing config wins when both kinds are present', () => {
    const regular = 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json';
    const loc = locateClaudeDesktop(win([regular], ['Claude_pzs8sxrjxfjjc']));
    expect(loc.configPath).toBe(regular);
  });

  it('macOS uses Application Support; nothing installed says so', () => {
    const mac = locateClaudeDesktop({ platform: 'darwin', env: {}, home: '/Users/me', exists: () => false, list: () => [] });
    expect(mac).toEqual({ installed: false, configPath: '/Users/me/Library/Application Support/Claude/claude_desktop_config.json' });
  });
});

describe('withMcpServer', () => {
  const launch = { command: EXE, args: ['--mcp'] };

  it('adds our server and keeps every other setting and server', () => {
    const before = JSON.stringify({ globalShortcut: 'Ctrl+Space', mcpServers: { filesystem: { command: 'npx', args: ['x'] } } });
    const after = JSON.parse(withMcpServer(before, launch));
    expect(after).toEqual({
      globalShortcut: 'Ctrl+Space',
      mcpServers: { filesystem: { command: 'npx', args: ['x'] }, videodubber: { command: EXE, args: ['--mcp'] } },
    });
    expect(connectedIn(withMcpServer(before, launch), launch)).toBe(true);
    expect(connectedIn(before, launch)).toBe(false);
  });

  it('creates the file from nothing, replaces a stale entry, and removes ours on disconnect', () => {
    expect(JSON.parse(withMcpServer(undefined, launch))).toEqual({ mcpServers: { videodubber: { command: EXE, args: ['--mcp'] } } });
    const stale = JSON.stringify({ mcpServers: { videodubber: { command: 'old.exe', args: [] } } });
    expect(connectedIn(withMcpServer(stale, launch), launch)).toBe(true);
    expect(JSON.parse(withMcpServer(withMcpServer(stale, launch), undefined))).toEqual({ mcpServers: {} });
  });

  it('refuses to touch a settings file it cannot read', () => {
    expect(() => withMcpServer('{ "mcpServers": ', launch)).toThrow(/not valid JSON/);
    expect(() => withMcpServer('[1,2]', launch)).toThrow(/unexpected shape/);
  });
});

describe('claudeCodeCommand', () => {
  it('quotes paths with spaces', () => {
    expect(claudeCodeCommand({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['D:\\vd\\cli.js'] })).toBe(
      'claude mcp add --scope user videodubber -- "C:\\Program Files\\nodejs\\node.exe" D:\\vd\\cli.js',
    );
  });
});

describe('setClaudeDesktopConnection', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-claude-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the config (creating its folder), keeps a backup of the previous one, and disconnects', async () => {
    const configPath = path.join(dir, 'Roaming', 'Claude', 'claude_desktop_config.json');
    const launch = { command: EXE, args: ['--mcp'] };
    // Nothing here may read the real ~/.claude.json or probe the real Mother Claude.
    const deps: IntegrationDeps = {
      claudeCode: codeDeps({}).deps,
      motherClaude: async () => ({ running: false, version: null }),
    };
    const status = await setClaudeDesktopConnection(true, launch, { installed: true, configPath }, deps);
    expect(status.claudeDesktop.connected).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf8')).mcpServers.videodubber.command).toBe(EXE);

    await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: { videodubber: launch } }));
    const off = await setClaudeDesktopConnection(false, launch, { installed: true, configPath }, deps);
    expect(off.claudeDesktop.connected).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ theme: 'dark', mcpServers: {} });
    expect(JSON.parse(await readFile(`${configPath}.videodubber-backup`, 'utf8')).theme).toBe('dark');
  });
});

// ---- Claude Code -------------------------------------------------------------------

const HOME = 'C:\\Users\\me';
const CLAUDE_JSON = 'C:\\Users\\me\\.claude.json';
const LOCAL_BIN_CLAUDE = 'C:\\Users\\me\\.local\\bin\\claude.exe';

/** A Windows machine with these files; `.claude.json` content, or an fs error code for it. */
function codeDeps(opts: {
  files?: string[];
  claudeJson?: string | { error: string };
  env?: NodeJS.ProcessEnv;
  runs?: CliResult[];
}): { deps: ClaudeCodeDeps; calls: { cli: ClaudeCli; args: readonly string[] }[] } {
  const calls: { cli: ClaudeCli; args: readonly string[] }[] = [];
  const results = [...(opts.runs ?? [])];
  const deps: ClaudeCodeDeps = {
    platform: 'win32',
    env: opts.env ?? { PATH: 'C:\\Windows\\system32' },
    home: HOME,
    exists: (p) => (opts.files ?? []).includes(p),
    readText: async (p) => {
      const content = opts.claudeJson;
      if (content === undefined) throw Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
      if (typeof content !== 'string') throw Object.assign(new Error(`${content.error}: ${p}`), { code: content.error });
      return content;
    },
    run: async (cli, args) => {
      calls.push({ cli, args });
      return results.shift() ?? { code: 0, output: '' };
    },
  };
  return { deps, calls };
}

const LAUNCH = { command: EXE, args: ['--mcp'] };
const entryJson = (command: string, args: string[] = ['--mcp']) =>
  JSON.stringify({ oauthAccount: { private: true }, mcpServers: { videodubber: { type: 'stdio', command, args, env: {} } } });

describe('claudeCodeConfigPath', () => {
  it('is .claude.json in the home folder, or in CLAUDE_CONFIG_DIR when that is set', () => {
    expect(claudeCodeConfigPath({ platform: 'win32', env: {}, home: HOME })).toBe(CLAUDE_JSON);
    expect(claudeCodeConfigPath({ platform: 'win32', env: { CLAUDE_CONFIG_DIR: 'D:\\work-claude' }, home: HOME })).toBe(
      'D:\\work-claude\\.claude.json',
    );
    expect(claudeCodeConfigPath({ platform: 'darwin', env: {}, home: '/Users/me' })).toBe('/Users/me/.claude.json');
  });
});

describe('findClaudeCli', () => {
  it('takes the first claude on PATH, the .exe before an npm .cmd in the same folder', () => {
    const env = { PATH: 'C:\\tools;"C:\\Program Files\\nodejs";C:\\npm' };
    const exe = findClaudeCli({ platform: 'win32', env, home: HOME, exists: (p) => p === 'C:\\npm\\claude.exe' || p === 'C:\\npm\\claude.cmd' });
    expect(exe).toEqual({ path: 'C:\\npm\\claude.exe', viaShell: false });
    // An npm install alone: only claude.cmd, which needs cmd.exe.
    const cmd = findClaudeCli({ platform: 'win32', env, home: HOME, exists: (p) => p === 'C:\\Program Files\\nodejs\\claude.cmd' });
    expect(cmd).toEqual({ path: 'C:\\Program Files\\nodejs\\claude.cmd', viaShell: true });
  });

  it('falls back to where the installers put it when PATH does not have it', () => {
    expect(findClaudeCli({ platform: 'win32', env: { Path: 'C:\\x' }, home: HOME, exists: (p) => p === LOCAL_BIN_CLAUDE })).toEqual({
      path: LOCAL_BIN_CLAUDE,
      viaShell: false,
    });
    // A macOS GUI app starts with a minimal PATH: Homebrew is found anyway.
    expect(
      findClaudeCli({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me', exists: (p) => p === '/opt/homebrew/bin/claude' }),
    ).toEqual({ path: '/opt/homebrew/bin/claude', viaShell: false });
    expect(findClaudeCli({ platform: 'darwin', env: {}, home: '/Users/me', exists: () => false })).toBeUndefined();
  });
});

describe('claudeCodeStatus', () => {
  it('connected: our name, with exactly this app\'s command', async () => {
    const { deps } = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: entryJson(EXE) });
    const status = await claudeCodeStatus(LAUNCH, deps);
    expect(status).toMatchObject({ state: 'connected', cli: LOCAL_BIN_CLAUDE, configPath: CLAUDE_JSON, registered: null });
    expect(status.command).toBe(`claude mcp add --scope user videodubber -- ${EXE} --mcp`);
  });

  it('other copy: our name points elsewhere, and says where', async () => {
    const { deps } = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: entryJson('C:\\nowhere\\x.exe') });
    expect(await claudeCodeStatus(LAUNCH, deps)).toMatchObject({
      state: 'other-copy',
      registered: { command: 'C:\\nowhere\\x.exe', args: ['--mcp'] },
    });
  });

  it('not connected: no entry (or no file yet); without a CLI that is "Claude Code not found"', async () => {
    const noEntry = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: JSON.stringify({ mcpServers: { other: {} } }) });
    expect((await claudeCodeStatus(LAUNCH, noEntry.deps)).state).toBe('not-connected');
    const noFile = codeDeps({ files: [LOCAL_BIN_CLAUDE] });
    expect((await claudeCodeStatus(LAUNCH, noFile.deps)).state).toBe('not-connected');
    const noCli = codeDeps({ claudeJson: '{}' });
    expect(await claudeCodeStatus(LAUNCH, noCli.deps)).toMatchObject({ state: 'cli-missing', cli: null });
  });

  it('reads the account folder in CLAUDE_CONFIG_DIR when it is set', async () => {
    const read: string[] = [];
    const { deps } = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: entryJson(EXE), env: { CLAUDE_CONFIG_DIR: 'D:\\acct2' } });
    const status = await claudeCodeStatus(LAUNCH, { ...deps, readText: (p) => (read.push(p), deps.readText(p)) });
    expect(read).toEqual(['D:\\acct2\\.claude.json']);
    expect(status).toMatchObject({ state: 'connected', configPath: 'D:\\acct2\\.claude.json' });
  });

  it('unreadable: a file it cannot read or parse is reported, not taken for "not connected"', async () => {
    const locked = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: { error: 'EBUSY' } });
    expect(await claudeCodeStatus(LAUNCH, locked.deps)).toMatchObject({ state: 'unreadable', detail: expect.stringContaining('EBUSY') });
    const torn = codeDeps({ files: [LOCAL_BIN_CLAUDE], claudeJson: '{"mcpServers": {"videodub' });
    expect(await claudeCodeStatus(LAUNCH, torn.deps)).toMatchObject({ state: 'unreadable', detail: expect.stringContaining('not valid JSON') });
  });
});

describe('setClaudeCodeConnection', () => {
  it('runs the CLI with exactly the documented arguments', () => {
    expect(claudeCodeAddArgs(LAUNCH)).toEqual(['mcp', 'add', '--scope', 'user', 'videodubber', '--', EXE, '--mcp']);
    expect(CLAUDE_CODE_REMOVE_ARGS).toEqual(['mcp', 'remove', 'videodubber', '-s', 'user']);
  });

  it('connect adds; reconnect removes then adds; disconnect removes', async () => {
    const connect = codeDeps({ files: [LOCAL_BIN_CLAUDE] });
    await setClaudeCodeConnection('connect', LAUNCH, connect.deps);
    expect(connect.calls.map((c) => c.args)).toEqual([claudeCodeAddArgs(LAUNCH)]);
    expect(connect.calls[0]!.cli).toEqual({ path: LOCAL_BIN_CLAUDE, viaShell: false });

    const reconnect = codeDeps({ files: [LOCAL_BIN_CLAUDE] });
    await setClaudeCodeConnection('reconnect', LAUNCH, reconnect.deps);
    expect(reconnect.calls.map((c) => c.args)).toEqual([CLAUDE_CODE_REMOVE_ARGS, claudeCodeAddArgs(LAUNCH)]);

    const disconnect = codeDeps({ files: [LOCAL_BIN_CLAUDE] });
    await setClaudeCodeConnection('disconnect', LAUNCH, disconnect.deps);
    expect(disconnect.calls.map((c) => c.args)).toEqual([CLAUDE_CODE_REMOVE_ARGS]);
  });

  it('an entry that is already gone is the state asked for, not an error', async () => {
    const { deps, calls } = codeDeps({
      files: [LOCAL_BIN_CLAUDE],
      runs: [{ code: 1, output: 'No MCP server named "videodubber" in user scope' }, { code: 0, output: 'Added' }],
    });
    await expect(setClaudeCodeConnection('reconnect', LAUNCH, deps)).resolves.toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it('shows the CLI\'s own words when it fails, and needs a CLI at all', async () => {
    const failing = codeDeps({ files: [LOCAL_BIN_CLAUDE], runs: [{ code: 1, output: 'MCP server videodubber already exists in user config' }] });
    await expect(setClaudeCodeConnection('connect', LAUNCH, failing.deps)).rejects.toMatchObject({
      appError: { message: expect.stringContaining('already exists in user config') },
    });
    const missing = codeDeps({});
    await expect(setClaudeCodeConnection('connect', LAUNCH, missing.deps)).rejects.toMatchObject({
      appError: { message: expect.stringContaining('not found') },
    });
    expect(missing.calls).toHaveLength(0);
  });
});

describe('cmdLine (an npm install\'s claude.cmd, run through cmd.exe)', () => {
  it('quotes every argument, so spaces and & | < > stay literal', () => {
    expect(cmdLine('C:\\Program Files\\nodejs\\claude.cmd', ['mcp', 'add', '--', 'C:\\A & B\\vd.exe', '--mcp'])).toBe(
      '"C:\\Program Files\\nodejs\\claude.cmd" "mcp" "add" "--" "C:\\A & B\\vd.exe" "--mcp"',
    );
  });

  it('refuses what cmd.exe cannot take literally', () => {
    expect(() => cmdLine('C:\\npm\\claude.cmd', ['C:\\100%\\vd.exe'])).toThrow(/safely/);
    expect(() => cmdLine('C:\\npm\\claude.cmd', ['a"b'])).toThrow(/safely/);
  });
});

describe('runClaudeCli', () => {
  it('captures what it printed and how it exited, without a console window', async () => {
    const node: ClaudeCli = { path: process.execPath, viaShell: false };
    const ok = await runClaudeCli(node, ['-e', 'console.log("added"); console.error("to user config")']);
    expect(ok.code).toBe(0);
    expect(ok.output).toContain('added');
    expect(ok.output).toContain('to user config');
    const failed = await runClaudeCli(node, ['-e', 'console.error("already exists"); process.exit(1)']);
    expect(failed).toEqual({ code: 1, output: 'already exists' });
  });
});

describe('probeMotherClaude', () => {
  const answering = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reports Mother Claude and its version, and nothing else that answers on its port', async () => {
    expect(await probeMotherClaude(answering(200, { app: 'mother-claude', status: 'ok', version: '0.16.1' }))).toEqual({
      running: true,
      version: '0.16.1',
    });
    expect(await probeMotherClaude(answering(200, { app: 'something-else' }))).toEqual({ running: false, version: null });
    expect(await probeMotherClaude(answering(500, {}))).toEqual({ running: false, version: null });
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await probeMotherClaude(refused)).toEqual({ running: false, version: null });
  });
});
