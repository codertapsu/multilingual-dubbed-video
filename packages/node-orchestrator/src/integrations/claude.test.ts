import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeCodeCommand,
  connectedIn,
  locateClaudeDesktop,
  mcpLaunchCommand,
  setClaudeDesktopConnection,
  withMcpServer,
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
    const status = await setClaudeDesktopConnection(true, launch, { installed: true, configPath });
    expect(status.claudeDesktop.connected).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf8')).mcpServers.videodubber.command).toBe(EXE);

    await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: { videodubber: launch } }));
    const off = await setClaudeDesktopConnection(false, launch, { installed: true, configPath });
    expect(off.claudeDesktop.connected).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ theme: 'dark', mcpServers: {} });
    expect(JSON.parse(await readFile(`${configPath}.videodubber-backup`, 'utf8')).theme).toBe('dark');
  });
});
