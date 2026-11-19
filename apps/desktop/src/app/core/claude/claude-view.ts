/**
 * What the app shows about its Claude connections, as pure functions: the
 * Claude Code badge and buttons for each state, and when Home's one-time tip
 * appears. Kept out of the components so the rules are unit-tested.
 */
import type { ClaudeCodeAction, ClaudeCodeState, ClaudeIntegration } from '../models/setup';

/** How the Claude Code row looks in one state. */
export interface ClaudeCodeView {
  /** i18n key of the status badge. */
  badge: string;
  badgeClass: '' | 'badge-completed' | 'badge-warning';
  /** The buttons, in order. None when there is no CLI to run them with. */
  actions: ClaudeCodeAction[];
  /** Show the copyable command up front (no CLI: it is the only way) rather than folded away. */
  commandOpen: boolean;
}

/** The i18n key of each button. */
export const CLAUDE_CODE_ACTION_LABELS: Record<ClaudeCodeAction, string> = {
  connect: 'settings.claude.connect',
  reconnect: 'settings.claude.code.reconnect',
  disconnect: 'settings.claude.disconnect',
};

/** The Claude Code row for a state; `hasCli` = the `claude` CLI was found. Pure. */
export function claudeCodeView(state: ClaudeCodeState, hasCli: boolean): ClaudeCodeView {
  const only = (action: ClaudeCodeAction): ClaudeCodeAction[] => (hasCli ? [action] : []);
  switch (state) {
    case 'connected':
      return { badge: 'settings.claude.connected', badgeClass: 'badge-completed', actions: only('disconnect'), commandOpen: false };
    case 'other-copy':
      return { badge: 'settings.claude.code.other-copy', badgeClass: 'badge-warning', actions: only('reconnect'), commandOpen: !hasCli };
    case 'unreadable':
      return { badge: 'settings.claude.code.unreadable', badgeClass: 'badge-warning', actions: only('reconnect'), commandOpen: !hasCli };
    case 'cli-missing':
      return { badge: 'settings.claude.code.cli-missing', badgeClass: '', actions: [], commandOpen: true };
    case 'not-connected':
    default:
      return { badge: 'settings.claude.not-connected', badgeClass: '', actions: only('connect'), commandOpen: !hasCli };
  }
}

/** Is VideoDubber connected to Claude Desktop or Claude Code? */
export function claudeConnected(status: ClaudeIntegration | null): boolean {
  return !!status && (status.claudeDesktop.connected || status.claudeCode?.state === 'connected');
}

/** localStorage key: Home's Claude tip was dismissed (or the guide opened). */
export const CLAUDE_TIP_DISMISSED_KEY = 'vd.claude-tip-dismissed';

/** Where Mother Claude is downloaded (the Claude guide, and Claude through Mother Claude in Settings). */
export const MOTHER_CLAUDE_DOWNLOAD_URL = 'https://github.com/codertapsu/mother-claude/releases';

/**
 * Home's one-time tip: shown until dismissed or the guide is opened, and only
 * while this build can serve Claude and nothing is connected yet. Nothing is
 * shown before the status has loaded, so the tip never flashes for a user who
 * is already connected.
 */
export function shouldShowClaudeTip(dismissed: boolean, status: ClaudeIntegration | null): boolean {
  return !dismissed && !!status && !!status.mcp && !claudeConnected(status);
}
