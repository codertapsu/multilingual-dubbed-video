/**
 * Project persistence.
 *
 * Owns `project.json` and `pipeline.json` for every project workspace, plus
 * project listing (by scanning the projects directory) and the one-time copy
 * of the user's input video into `input/original.<ext>` on create.
 *
 * All writes are atomic (write to a temp file in the same directory, then
 * rename) so a crash mid-write can never corrupt a project file.
 */
import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  createInitialPipelineState,
  isValidLanguageCode,
  normalizeLanguageCode,
  type CreateProjectInput,
  type PipelineState,
  type Project,
  type ProjectSettings,
} from '@videodubber/shared';
import { ensureWorkspaceDirs, fileExists, workspacePaths, type WorkspacePaths } from './paths.js';

/** Generate a URL-safe, filesystem-safe project id. */
export function generateProjectId(): string {
  // 16 random bytes -> 32 hex chars; prefixed for readability in directories.
  return `proj_${crypto.randomBytes(16).toString('hex')}`;
}

/** Write JSON atomically: temp file + rename within the same directory. */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, filePath);
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
 * Persistence layer for projects. Stateless beyond the projects-root path, so
 * it can be freely shared and is trivially mockable in tests via a temp dir.
 */
export class ProjectStore {
  constructor(private readonly projectsDir: string) {}

  /** Resolve the workspace paths for a project id. */
  paths(projectId: string): WorkspacePaths {
    return workspacePaths(this.projectsDir, projectId);
  }

  /**
   * Create a new project: allocate an id, build the workspace, copy the input
   * video into `input/original.<ext>`, and persist `project.json` +
   * `pipeline.json`.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    // Normalize + validate language codes BEFORE persisting (contract:
    // "always normalize with normalizeLanguageCode before persisting"; e.g.
    // vi-VI -> vi-VN). Invalid codes fail fast with a clear error.
    const sourceLanguage = normalizeLanguageCode(input.settings.sourceLanguage);
    const targetLanguage = normalizeLanguageCode(input.settings.targetLanguage);
    if (!isValidLanguageCode(sourceLanguage)) {
      throw new AppErrorException(
        'INVALID_LANGUAGE',
        `Invalid source language code: "${input.settings.sourceLanguage}".`,
      );
    }
    if (!isValidLanguageCode(targetLanguage)) {
      throw new AppErrorException(
        'INVALID_LANGUAGE',
        `Invalid target language code: "${input.settings.targetLanguage}".`,
      );
    }
    const settings: ProjectSettings = { ...input.settings, sourceLanguage, targetLanguage };

    const id = generateProjectId();
    const paths = this.paths(id);
    await ensureWorkspaceDirs(paths);

    // Copy the source video into the workspace so the project is self-contained.
    const ext = path.extname(input.inputVideoPath).replace(/^\./, '') || 'mp4';
    const internalInput = paths.inputVideo(ext);
    try {
      await fsp.copyFile(input.inputVideoPath, internalInput);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new AppErrorException({
          code: 'UNSUPPORTED_MEDIA',
          message: `Input video not found: ${input.inputVideoPath}`,
          remediation: 'Verify the file path and that the file exists and is readable.',
        });
      }
      throw err;
    }

    const now = new Date().toISOString();
    const outputDir = input.outputDir ?? paths.renderDir;

    const project: Project = {
      id,
      name: input.name,
      inputVideoPath: internalInput,
      workspaceDir: paths.root,
      outputDir,
      settings,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    const pipeline = createInitialPipelineState(id);

    await this.saveProject(project);
    await this.savePipeline(pipeline);

    return project;
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
    return project;
  }

  /** Load a project or undefined if missing (non-throwing variant). */
  async tryGetProject(projectId: string): Promise<Project | undefined> {
    return readJson<Project>(this.paths(projectId).projectJson);
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
    return pipeline ?? createInitialPipelineState(projectId);
  }

  /**
   * List every project by scanning the projects directory for sub-directories
   * containing a readable `project.json`. Unreadable/partial entries are
   * skipped rather than failing the whole listing.
   */
  async listProjects(): Promise<Project[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }

    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = await readJson<Project>(this.paths(entry.name).projectJson).catch(() => undefined);
      if (project) projects.push(project);
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
