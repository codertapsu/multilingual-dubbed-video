/**
 * Where the projects live: `<root>/projects`, the root chosen in Settings,
 * VideoDubber's data folder (~/VideoDubber) by default. Each project keeps the
 * same structure wherever it is (`<root>/projects/<id>/render/output.mp4`).
 *
 * The choice is kept in `<configDir>/projects-folder.json`, its own file: the
 * preferences are rebuilt from their known fields on every save, which would
 * drop a field nobody listed. It is read at startup and wins over
 * VIDEODUBBER_PROJECTS_DIR, which the desktop shell always sets to the default.
 *
 * Changing it moves every project (ProjectsFolderService). A project's files
 * name each other by absolute path (project.json's video copy and render
 * folder, the dub clips in translated.aligned.json, the editor caches' source
 * stamps), so a moved project has those paths rewritten: moved but not
 * rewritten, its video and clips would point into the folder it left.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './projectStore.js';

/** The file in the config folder that holds the chosen root. */
export const PROJECTS_FOLDER_FILE = 'projects-folder.json';

/** The projects folder inside a chosen root. */
export function projectsDirOf(root: string): string {
  return path.join(root, 'projects');
}

/** The root chosen in Settings, or undefined for VideoDubber's data folder. */
export async function readProjectsRoot(configDir: string): Promise<string | undefined> {
  try {
    const stored = JSON.parse(await fsp.readFile(path.join(configDir, PROJECTS_FOLDER_FILE), 'utf8')) as { root?: unknown };
    const root = typeof stored.root === 'string' ? stored.root.trim() : '';
    return root && path.isAbsolute(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the chosen root; undefined goes back to VideoDubber's data folder. */
export async function writeProjectsRoot(configDir: string, root: string | undefined): Promise<void> {
  const file = path.join(configDir, PROJECTS_FOLDER_FILE);
  if (!root) {
    await fsp.rm(file, { force: true });
    return;
  }
  await writeJsonAtomic(file, { root });
}

/**
 * `value` re-rooted from `from` to `to` when it is `from` or a path inside it;
 * anything else unchanged. Windows paths compare without case and with either
 * slash, as the file system does; the rest of the path keeps its own spelling.
 */
export function rebasePath(value: string, from: string, to: string, win = process.platform === 'win32'): string {
  const base = from.replace(/[\\/]+$/, '');
  const where = placeIn(value, base, win);
  if (where === 'outside') return value;
  return where === 'same' ? to : to + value.slice(base.length);
}

/** Whether `p` is `base` itself, inside it, or outside it (Windows: any case, either slash). */
function placeIn(p: string, base: string, win: boolean): 'same' | 'inside' | 'outside' {
  const fold = (s: string) => (win ? s.replace(/\//g, '\\').toLowerCase() : s);
  const v = fold(p.replace(/[\\/]+$/, ''));
  const b = fold(base.replace(/[\\/]+$/, ''));
  if (v === b) return 'same';
  return v.startsWith(b + (win ? '\\' : '/')) ? 'inside' : 'outside';
}

/** Every string of a parsed JSON value re-rooted (rebasePath); the rest as it was. */
export function rebaseJson(value: unknown, from: string, to: string, win = process.platform === 'win32'): unknown {
  if (typeof value === 'string') return rebasePath(value, from, to, win);
  if (Array.isArray(value)) return value.map((v) => rebaseJson(v, from, to, win));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebaseJson(v, from, to, win)]));
  }
  return value;
}

/** Every .json file under `dir`. */
async function jsonFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(path.join(entry.parentPath, entry.name));
  }
  return out;
}

/**
 * After a project folder moved from `from` to `to` (both the project's own
 * folder): rewrite every path in its JSON files that named the old place.
 * Returns how many files changed. A file that does not parse is left alone:
 * it is not one VideoDubber reads as JSON.
 */
export async function rewriteMovedPaths(projectDir: string, from: string, to: string): Promise<number> {
  let changed = 0;
  for (const file of await jsonFilesUnder(projectDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const rebased = rebaseJson(parsed, from, to);
    if (JSON.stringify(rebased) === JSON.stringify(parsed)) continue;
    await writeJsonAtomic(file, rebased);
    changed++;
  }
  return changed;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Move a folder: a rename on the same drive (instant, whole), else a copy and
 * then the original removed. A copy that fails is removed again, so the folder
 * is whole in exactly one place. Returns false when the copy worked but the
 * original could not be removed completely (a file still held open): the
 * project is whole at `dest`, and the leftovers only take space.
 */
export async function moveFolder(src: string, dest: string): Promise<boolean> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(src, dest);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') break;
      // Windows refuses to rename a folder while anything holds a file in it
      // (a preview still streaming, Defender scanning a fresh file): it lets
      // go within moments, so wait and try again.
      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < 6) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  try {
    await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  try {
    await fsp.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

/** `inner` is `outer` or inside it. */
export function isWithin(inner: string, outer: string, win = process.platform === 'win32'): boolean {
  return placeIn(inner, outer, win) !== 'outside';
}
