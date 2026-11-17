import type { Project } from '../models';

/**
 * The folder the last new project was saved to, offered to the next one: a
 * user who dubs into D:\Dubs should not have to pick it every time. The
 * wizard says so beside the folder, and choosing "Use the default folder"
 * there forgets it. So does a folder that could not be used: offering it to
 * every new project would only repeat the same notice.
 */
const LAST_OUTPUT_DIR_KEY = 'vd.last-output-dir';

export function readLastOutputDir(): string | null {
  try {
    return localStorage.getItem(LAST_OUTPUT_DIR_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function forgetLastOutputDir(): void {
  try {
    localStorage.removeItem(LAST_OUTPUT_DIR_KEY);
  } catch {
    // Storage unavailable: nothing was remembered.
  }
}

/** Remember where `project` saves: its chosen folder, or none for the default. */
export function rememberOutputDir(project: Pick<Project, 'outputDir' | 'outputFileName'>): void {
  try {
    if (project.outputFileName) localStorage.setItem(LAST_OUTPUT_DIR_KEY, project.outputDir);
    else localStorage.removeItem(LAST_OUTPUT_DIR_KEY);
  } catch {
    // Storage unavailable (private mode): nothing to remember with.
  }
}
