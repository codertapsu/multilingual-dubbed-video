/**
 * Project persistence.
 *
 * Owns `project.json` and `pipeline.json` for every project workspace, plus
 * project listing (by scanning the projects directory) and the copy of the
 * user's input video into `input/original.<ext>`: on create, and again if New
 * project changes the video before the project's first run.
 *
 * All writes are atomic (write to a temp file in the same directory, then
 * rename) so a crash mid-write can never corrupt a project file.
 */
import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sanitizeBranding } from '../branding/sanitize.js';
import { sanitizeSeriesSettings } from '../series/seriesSanitize.js';
import { renameReplacing } from '../fsRename.js';
import {
  AppErrorException,
  createInitialPipelineState,
  isValidLanguageCode,
  normalizeLanguageCode,
  normalizePipelineState,
  type CreateProjectInput,
  type PipelineState,
  type Project,
  type ProjectSettings,
  type ReviseProjectInput,
} from '@videodubber/shared';
import { ensureWorkspaceDirs, fileExists, workspacePaths, type WorkspacePaths } from './paths.js';
import { acceptOutputDir, freeOutputBaseName, samePath } from './outputFolder.js';
import { KeyedMutex } from '../keyedMutex.js';

/** Generate a URL-safe, filesystem-safe project id. */
export function generateProjectId(): string {
  // 16 random bytes -> 32 hex chars; prefixed for readability in directories.
  return `proj_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Write a text file atomically: a sibling temp file, then rename over the target.
 *
 * The workspace's resumability rests on "an artifact that exists is complete";
 * a plain writeFile interrupted mid-write (crash, quit, full disk) leaves a
 * truncated JSON/SRT that the next run happily reads. Rename is atomic on the
 * same filesystem, so readers see either the old file or the new one.
 */
export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  await renameReplacing(tmp, filePath);
}

/** {@link writeTextAtomic} for pretty-printed JSON (temp file + rename). */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read and parse a JSON file, or return undefined if it is missing. */
async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Settings as persisted: language codes normalized and validated BEFORE
 * anything is written (contract: "always normalize with normalizeLanguageCode
 * before persisting"; e.g. vi-VI -> vi-VN). Invalid codes fail fast with a
 * clear error.
 */
function normalizedSettings(input: ProjectSettings): ProjectSettings {
  const sourceLanguage = normalizeLanguageCode(input.sourceLanguage);
  const targetLanguage = normalizeLanguageCode(input.targetLanguage);
  if (!isValidLanguageCode(sourceLanguage)) {
    throw new AppErrorException('INVALID_LANGUAGE', `Invalid source language code: "${input.sourceLanguage}".`);
  }
  if (!isValidLanguageCode(targetLanguage)) {
    throw new AppErrorException('INVALID_LANGUAGE', `Invalid target language code: "${input.targetLanguage}".`);
  }
  // Logo and greeting are checked field by field; a broken choice is dropped.
  const { branding: rawBranding, ...rest } = input;
  const branding = sanitizeBranding(rawBranding);
  return { ...rest, sourceLanguage, targetLanguage, ...(branding ? { branding } : {}) };
}

/**
 * Copy the user's video into the workspace (`input/original.<ext>`), whole or
 * not at all: a temp file, then a rename over the target, so replacing the
 * video of a project (reviseProject) never leaves a half-copied one where the
 * old one was.
 */
async function copyInputVideo(source: string, paths: WorkspacePaths, opts: { link?: boolean } = {}): Promise<string> {
  const ext = path.extname(source).replace(/^\./, '') || 'mp4';
  const dest = paths.inputVideo(ext);
  const tmp = path.join(path.dirname(dest), `.original.${crypto.randomBytes(6).toString('hex')}.partial.${ext}`);
  try {
    // A download VideoDubber made itself is linked, not copied: the project's
    // own name for the same bytes, so a batch of long videos does not take
    // twice the space, and deleting either one leaves the other whole. Across
    // drives (or where links are refused) it is copied as before.
    const linked = opts.link === true && (await fsp.link(source, tmp).then(() => true, () => false));
    if (!linked) await fsp.copyFile(source, tmp);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppErrorException({
        code: 'UNSUPPORTED_MEDIA',
        message: `Input video not found: ${source}`,
        remediation: 'Verify the file path and that the file exists and is readable.',
      });
    }
    throw err;
  }
  await renameReplacing(tmp, dest);
  return dest;
}

/**
 * Persistence layer for projects. Stateless beyond the projects-root path, so
 * it can be freely shared and is trivially mockable in tests via a temp dir.
 */
export class ProjectStore {
  constructor(private dir: string) {}

  /** Where the projects are (`<root>/projects`; the root is chosen in Settings). */
  get projectsDir(): string {
    return this.dir;
  }

  /**
   * The projects now live in `dir` (ProjectsFolderService moved them there).
   * Every path this store hands out is derived from it, so they all follow.
   */
  setProjectsDir(dir: string): void {
    this.dir = dir;
  }

  /**
   * Delete a project: its whole folder, working files and, when it saves to
   * its own render/ folder, the finished video. Files it saved to a folder the
   * user chose are left alone: they are the user's, outside VideoDubber's data.
   * Windows may hold a file a moment longer (a preview that just stopped, a
   * virus scan): rm retries those.
   */
  async deleteProject(projectId: string): Promise<void> {
    await this.getProject(projectId);
    await fsp.rm(this.paths(projectId).root, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }

  /** Serializes choosing a file name in a shared folder with saving it (withOutputName). */
  private readonly outputNames = new KeyedMutex();

  /**
   * Choose a free base name for a project's finished files in `dir`, and run
   * `save` with it, as one step. A name counts as taken when a file there
   * uses it, or another project saving to that folder holds it before it has
   * rendered anything: two projects named "Clip" in one folder both got
   * "Clip.vi", and the second render replaced the first one's video. Locked,
   * so two projects choosing at once cannot take the same free name.
   */
  async withOutputName<T>(
    dir: string,
    projectName: string,
    targetLanguage: string,
    excludeProjectId: string | undefined,
    save: (baseName: string) => Promise<T>,
  ): Promise<T> {
    return this.outputNames.run('output-names', async () => {
      const held = new Set(
        (await this.listProjects())
          .filter((p) => p.id !== excludeProjectId && p.outputFileName && samePath(p.outputDir, dir))
          .map((p) => p.outputFileName!.toLowerCase()),
      );
      return save(freeOutputBaseName(dir, projectName, targetLanguage, held));
    });
  }

  /**
   * A project as it reads: one that saves to its own render/ folder says so.
   * Older ones may name another folder without a file name of their own
   * (the old wizard's ignored text field; a moved projects folder): the
   * render always wrote to render/, so that is where their video is.
   */
  private withOutputFolder(project: Project): Project {
    if (project.outputFileName) return project;
    const renderDir = this.paths(project.id).renderDir;
    return project.outputDir === renderDir ? project : { ...project, outputDir: renderDir };
  }

  /** Resolve the workspace paths for a project id. */
  paths(projectId: string): WorkspacePaths {
    return workspacePaths(this.dir, projectId);
  }

  /**
   * Create a new project: allocate an id, build the workspace, copy the input
   * video into `input/original.<ext>`, and persist `project.json` +
   * `pipeline.json`.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const settings = normalizedSettings(input.settings);
    const { targetLanguage } = settings;

    // A folder the user chose for the finished files: checked BEFORE anything
    // is created, so a folder VideoDubber cannot write to leaves no half-made
    // project behind.
    const chosenDir = input.outputDir?.trim() ? await acceptOutputDir(input.outputDir) : undefined;

    const id = generateProjectId();
    const paths = this.paths(id);
    await ensureWorkspaceDirs(paths);

    // Copy the source video into the workspace so the project is self-contained.
    const internalInput = await copyInputVideo(input.inputVideoPath, paths, { link: input.linkInputVideo === true });

    const now = new Date().toISOString();
    const project: Project = {
      id,
      name: input.name,
      inputVideoPath: internalInput,
      workspaceDir: paths.root,
      outputDir: chosenDir ?? paths.renderDir,
      settings,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      ...(input.source ? { source: input.source } : {}),
      // A long video dubbed as a series: this project analyses, its parts dub (series/).
      ...(input.series
        ? { series: { role: 'parent' as const, settings: sanitizeSeriesSettings(input.series, input.series.aiProviderId ?? ''), state: 'analysing' as const } }
        : {}),
    };

    await this.savePipeline(createInitialPipelineState(id));
    // In a chosen folder the files are named after the project, uniquely there.
    if (!chosenDir) return this.saveProject(project);
    return this.withOutputName(chosenDir, input.name, targetLanguage, id, (outputFileName) =>
      this.saveProject({ ...project, outputFileName }),
    );
  }

  /**
   * Give a project that has never run the name, settings and (when it
   * changed) the video New project now holds (orchestrator.reviseProject
   * checks "never run"). Settings are replaced whole, so a choice turned off
   * is off: a merge of only the given values could not clear one. Where it
   * saves is kept; in a chosen folder its file name follows a new name or
   * language, uniquely there, as it would have at creation.
   */
  async reviseProject(current: Project, input: ReviseProjectInput): Promise<Project> {
    const settings = normalizedSettings(input.settings);
    const { targetLanguage } = settings;
    const paths = this.paths(current.id);

    let next: Project = { ...current, name: input.name, settings };
    let staleCopy: string | undefined;
    if (input.inputVideoPath?.trim()) {
      const copied = await copyInputVideo(input.inputVideoPath, paths);
      // Another extension is another file: the old copy would only take space.
      if (!samePath(copied, current.inputVideoPath)) staleCopy = current.inputVideoPath;
      // Its probe described the old video.
      const { mediaInfo: _stale, ...rest } = next;
      next = { ...rest, inputVideoPath: copied };
    }

    // Never run, so nothing of it to keep: whatever it held starts over.
    await this.savePipeline(createInitialPipelineState(current.id));
    const renamed = input.name !== current.name || targetLanguage !== current.settings.targetLanguage;
    const saved =
      current.outputFileName && renamed
        ? await this.withOutputName(current.outputDir, input.name, targetLanguage, current.id, (outputFileName) =>
            this.saveProject({ ...next, outputFileName }),
          )
        : await this.saveProject(next);
    // Only once project.json names the new copy.
    if (staleCopy) await fsp.rm(staleCopy, { force: true });
    return saved;
  }

  /** Persist `project.json`, bumping `updatedAt`. */
  async saveProject(project: Project): Promise<Project> {
    const next: Project = { ...project, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.paths(project.id).projectJson, next);
    return next;
  }

  /** Load a project, throwing UNKNOWN if it does not exist. */
  async getProject(projectId: string): Promise<Project> {
    const project = await readJson<Project>(this.paths(projectId).projectJson);
    if (!project) {
      throw new AppErrorException({
        code: 'UNKNOWN',
        message: `Project not found: ${projectId}`,
        remediation: 'Confirm the project id; list projects to see valid ids.',
      });
    }
    return this.withOutputFolder(project);
  }

  /** Load a project or undefined if missing (non-throwing variant). */
  async tryGetProject(projectId: string): Promise<Project | undefined> {
    const project = await readJson<Project>(this.paths(projectId).projectJson);
    return project ? this.withOutputFolder(project) : undefined;
  }

  /** Persist the pipeline state for a project. */
  async savePipeline(pipeline: PipelineState): Promise<void> {
    await writeJsonAtomic(this.paths(pipeline.projectId).pipelineJson, pipeline);
  }

  /**
   * Load the pipeline state, falling back to a fresh initial state if the
   * file is missing (e.g. an older project).
   */
  async getPipeline(projectId: string): Promise<PipelineState> {
    const pipeline = await readJson<PipelineState>(this.paths(projectId).pipelineJson);
    // Normalize: a pipeline.json written by an older app version may miss
    // steps added since (e.g. `refine`); insert them as pending so the runner
    // and the UI see the full canonical sequence.
    return pipeline ? normalizePipelineState(pipeline) : createInitialPipelineState(projectId);
  }

  /**
   * List every project by scanning the projects directory for sub-directories
   * containing a readable `project.json`. Unreadable/partial entries are
   * skipped rather than failing the whole listing.
   */
  async listProjects(): Promise<Project[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }

    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = await readJson<Project>(this.paths(entry.name).projectJson).catch(() => undefined);
      if (project) projects.push(this.withOutputFolder(project));
    }

    // Most-recently-updated first.
    projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return projects;
  }

  /** Convenience existence check for a project workspace. */
  async exists(projectId: string): Promise<boolean> {
    return fileExists(this.paths(projectId).projectJson);
  }
}
