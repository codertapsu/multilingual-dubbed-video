/**
 * Cross-platform "reveal in file manager / open" helper for the dev/browser
 * fallback path. In the packaged Tauri app the native `open_path` command
 * handles this instead (and SSE is consumed directly), so this is only used
 * when the orchestrator is hit over HTTP.
 *
 * Uses argv arrays only (never a shell string) so untrusted paths cannot be
 * injected into a shell.
 */
import { spawn } from 'node:child_process';
import { AppErrorException } from '@videodubber/shared';

/** Resolve the OS-appropriate opener command + args for a path. */
export function openCommandFor(targetPath: string): { command: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { command: 'open', args: [targetPath] };
    case 'win32':
      // `start` is a cmd builtin; invoke via cmd with an empty title arg.
      return { command: 'cmd', args: ['/c', 'start', '', targetPath] };
    default:
      return { command: 'xdg-open', args: [targetPath] };
  }
}

/** Open a path with the OS file manager / default handler. */
export async function openPath(targetPath: string): Promise<void> {
  const { command, args } = openCommandFor(targetPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (err) => {
      reject(
        new AppErrorException('UNKNOWN', `Failed to open path: ${targetPath}`, {
          cause: err instanceof Error ? err.message : String(err),
          remediation: 'Open the file/folder manually from your file manager.',
        }),
      );
    });
    // We don't wait for the opener to exit; detach and resolve.
    child.unref();
    resolve();
  });
}
