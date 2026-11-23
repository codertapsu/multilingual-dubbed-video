/**
 * Settings → Projects folder: show where the projects live, and move them all
 * to another folder (projectsFolder.ts for the parts; this is the sequence).
 *
 * A move checks everything it can before touching a file (nothing is dubbing
 * or busy, the folder is not inside the current one, VideoDubber can write
 * there, no project folder of the same id is already there), then runs in the
 * background, one project at a time, so Settings can show how far it is. If
 * one project cannot move, the ones already moved go back: the projects are
 * never split between two folders. Only when all have moved does the app
 * switch to the new folder and remember it.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, toAppError, type ProjectsFolderInfo } from '@videodubber/shared';
import { activity, type ActivityHandle } from '../activity/registry.js';
import type { ProjectStore } from './projectStore.js';
import { isWithin, moveFolder, projectsDirOf, rewriteMovedPaths, writeProjectsRoot } from './projectsFolder.js';

export interface ProjectsFolderDeps {
  configDir: string;
  /** Where the projects live by default (VIDEODUBBER_PROJECTS_DIR, else ~/VideoDubber/projects). */
  defaultProjectsDir: string;
  store: ProjectStore;
  /** The projects something works on now (orchestrator.busyProjects). */
  busyProjects: () => string[];
  /**
   * The downloads beside the projects (`<root>\downloads`, the download
   * queue): they move with them, after the projects, once nothing downloads.
   */
  downloads?: { busy(): boolean; relocate(fromDir: string, toDir: string): Promise<void> };
  logger?: { warn(message: string): void };
}

export class ProjectsFolderService {
  private progress: { to: string; done: number; total: number } | null = null;
  private lastError: ProjectsFolderInfo['lastError'];

  constructor(private readonly deps: ProjectsFolderDeps) {}

  /** A move is running: project changes wait (the server refuses them meanwhile). */
  get moving(): boolean {
    return this.progress !== null;
  }

  private get defaultRoot(): string {
    return path.dirname(this.deps.defaultProjectsDir);
  }

  async info(): Promise<ProjectsFolderInfo> {
    const projectsDir = this.deps.store.projectsDir;
    const isDefault = samePlace(projectsDir, this.deps.defaultProjectsDir);
    const available = await fsp.stat(path.dirname(projectsDir)).then(
      (s) => s.isDirectory(),
      () => false,
    );
    const projects = available ? await this.deps.store.listProjects().catch(() => []) : [];
    return {
      root: path.dirname(projectsDir),
      projectsDir,
      defaultRoot: this.defaultRoot,
      isDefault,
      available,
      projectCount: projects.length,
      ...(this.progress ? { moving: { ...this.progress } } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Move every project to `<root>/projects` (null: back to VideoDubber's own
   * data folder). Resolves once the checks pass and the move has started;
   * info() reports its progress and how it ended.
   */
  async move(root: string | null): Promise<ProjectsFolderInfo> {
    if (this.progress) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'The projects are already moving. Wait until that has finished.');
    }
    const target = root?.trim() ? path.resolve(root.trim()) : null;
    if (root?.trim() && !path.isAbsolute(root.trim())) {
      throw new AppErrorException('UNKNOWN', `"${root}" is not a folder path. Choose the folder with Change….`);
    }
    const isDefault = target === null || samePlace(target, this.defaultRoot);
    const toDir = isDefault ? this.deps.defaultProjectsDir : projectsDirOf(target);
    const fromDir = this.deps.store.projectsDir;
    if (samePlace(toDir, fromDir)) {
      await writeProjectsRoot(this.deps.configDir, isDefault ? undefined : target!);
      this.lastError = undefined;
      return this.info();
    }
    if (isWithin(toDir, fromDir) || isWithin(fromDir, toDir)) {
      throw new AppErrorException('UNKNOWN', 'Choose a folder outside the current projects folder (and not one that contains it).', {
        remediation: `The projects are in ${fromDir} now.`,
      });
    }
    const busy = this.deps.busyProjects();
    if (busy.length > 0) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Some projects are dubbing, waiting in the queue, or busy in the editor.', {
        remediation: 'Pause them (or wait for them to finish), then move the projects.',
      });
    }
    if (this.deps.downloads?.busy()) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Videos are downloading into the projects folder\'s downloads.', {
        remediation: 'Wait for the downloads to finish (or cancel them on the Download screen), then move the projects.',
      });
    }
    await assertWritable(toDir);
    const projects = await this.deps.store.listProjects();
    for (const p of projects) {
      if (await exists(path.join(toDir, p.id))) {
        throw new AppErrorException('UNKNOWN', `${toDir} already has a project folder named ${p.id}.`, {
          remediation: 'Choose another folder, or remove that folder first.',
        });
      }
    }

    this.progress = { to: toDir, done: 0, total: projects.length };
    this.lastError = undefined;
    // In the activity list too (activity/registry.ts), with who asked for it.
    const job = activity.start({ kind: 'projects.move', title: `Moving the projects to ${toDir}` });
    void this.run(
      projects.map((p) => p.id),
      fromDir,
      toDir,
      isDefault ? undefined : target!,
      job,
    );
    return this.info();
  }

  private async run(ids: string[], fromDir: string, toDir: string, rootToKeep: string | undefined, job?: ActivityHandle): Promise<void> {
    const moved: { from: string; to: string }[] = [];
    try {
      for (const id of ids) {
        const from = path.join(fromDir, id);
        const to = path.join(toDir, id);
        const whole = await moveFolder(from, to);
        moved.push({ from, to });
        await rewriteMovedPaths(to, from, to);
        if (!whole) this.deps.logger?.warn(`moved ${id}, but some of its old files stay in ${from} (still in use)`);
        this.progress!.done++;
        job?.progress((100 * this.progress!.done) / Math.max(1, ids.length), `${this.progress!.done} of ${ids.length} projects moved`);
      }
      await writeProjectsRoot(this.deps.configDir, rootToKeep);
      this.deps.store.setProjectsDir(toDir);
      // The old projects folder, when nothing else is left in it.
      await fsp.rmdir(fromDir).catch(() => undefined);
      await this.moveDownloads(path.join(path.dirname(fromDir), 'downloads'), path.join(path.dirname(toDir), 'downloads'));
    } catch (err) {
      // Back to where they were: the projects stay together in one folder.
      for (const { from, to } of moved.reverse()) {
        try {
          await moveFolder(to, from);
          await rewriteMovedPaths(from, to, from);
        } catch (back) {
          this.deps.logger?.warn(`could not move ${to} back to ${from}: ${String(back)}`);
        }
      }
      const cause = toAppError(err);
      this.lastError = {
        code: cause.code,
        message: `The projects could not be moved to ${toDir}: ${cause.message}`,
        remediation: 'They are still where they were. Close anything that uses their files (the editor, a video player), then try again.',
      };
      job?.fail(this.lastError);
    } finally {
      this.progress = null;
      job?.done(`The projects are in ${toDir}`);
    }
  }

  /**
   * The downloads folder follows the projects. Best effort: a download still
   * in use where it is (a player has it open) stays there, and the list keeps
   * pointing at it; the projects have moved either way.
   */
  private async moveDownloads(fromDir: string, toDir: string): Promise<void> {
    const downloads = this.deps.downloads;
    if (!downloads || !(await exists(fromDir)) || samePlace(fromDir, toDir)) return;
    try {
      if (await exists(toDir)) {
        // Merge into a folder that is already there, file by file.
        for (const name of await fsp.readdir(fromDir)) {
          const target = path.join(toDir, name);
          if (!(await exists(target))) await moveFolder(path.join(fromDir, name), target);
        }
        await fsp.rmdir(fromDir).catch(() => undefined);
      } else {
        await moveFolder(fromDir, toDir);
      }
      await downloads.relocate(fromDir, toDir);
    } catch (err) {
      this.deps.logger?.warn(`the downloads stay in ${fromDir}: ${String(err)}`);
    }
  }
}

/** Same folder, the way the file system compares (no case on Windows). */
function samePlace(a: string, b: string): boolean {
  return isWithin(a, b) && isWithin(b, a);
}

async function exists(p: string): Promise<boolean> {
  return fsp.stat(p).then(
    () => true,
    () => false,
  );
}

/** Create the folder if needed, and prove VideoDubber can write in it. */
async function assertWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.videodubber-write-test-${process.pid}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw new AppErrorException('OUTPUT_NOT_WRITABLE', `VideoDubber cannot write in ${dir}.`, {
      cause: String(err).slice(0, 300),
      remediation: 'Choose a folder you can write to (not a system folder or a disconnected drive).',
    });
  }
}
