import { describe, expect, it } from 'vitest';
import type { ClaudeCodeState, ClaudeIntegration } from '../models/setup';
import { claudeCodeView, claudeConnected, shouldShowClaudeTip } from './claude-view';

const status = (over: { desktop?: boolean; code?: ClaudeCodeState; mcp?: boolean } = {}): ClaudeIntegration => ({
  mcp: over.mcp === false ? null : { command: 'C:\\vd\\videodubber-orchestrator.exe', args: ['--mcp'] },
  claudeCode: {
    state: over.code ?? 'not-connected',
    command: 'claude mcp add --scope user videodubber -- C:\\vd\\videodubber-orchestrator.exe --mcp',
    cli: 'C:\\Users\\me\\.local\\bin\\claude.exe',
    configPath: 'C:\\Users\\me\\.claude.json',
    registered: null,
  },
  claudeDesktop: { installed: true, configPath: 'C:\\x\\claude_desktop_config.json', connected: over.desktop ?? false },
  motherClaude: { running: false, version: null },
});

describe('claudeCodeView', () => {
  it('offers the one button that fixes each state', () => {
    expect(claudeCodeView('not-connected', true).actions).toEqual(['connect']);
    expect(claudeCodeView('connected', true)).toMatchObject({ badgeClass: 'badge-completed', actions: ['disconnect'] });
    expect(claudeCodeView('other-copy', true)).toMatchObject({ badgeClass: 'badge-warning', actions: ['reconnect'] });
    expect(claudeCodeView('unreadable', true).actions).toEqual(['reconnect']);
  });

  it('without the CLI there are no buttons, and the command to run by hand is shown up front', () => {
    expect(claudeCodeView('cli-missing', false)).toMatchObject({
      badge: 'settings.claude.code.cli-missing',
      actions: [],
      commandOpen: true,
    });
    expect(claudeCodeView('other-copy', false)).toMatchObject({ actions: [], commandOpen: true });
    // Connected stays connected without a CLI; the command is just tucked away.
    expect(claudeCodeView('connected', false)).toMatchObject({ actions: [], commandOpen: false });
  });
});

describe('the Claude tip on Home', () => {
  it('shows once nothing is connected, and never again after it is dismissed', () => {
    expect(shouldShowClaudeTip(false, status())).toBe(true);
    expect(shouldShowClaudeTip(true, status())).toBe(false);
  });

  it('stays away for a connected user, before the status loads, and when this build has no server', () => {
    expect(shouldShowClaudeTip(false, status({ desktop: true }))).toBe(false);
    expect(shouldShowClaudeTip(false, status({ code: 'connected' }))).toBe(false);
    expect(shouldShowClaudeTip(false, null)).toBe(false);
    expect(shouldShowClaudeTip(false, status({ mcp: false }))).toBe(false);
    expect(claudeConnected(status({ code: 'other-copy' }))).toBe(false);
  });
});
