import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore } from './projectStore.js';
import { createProjectInput, defaultSettings, writeDummyVideo } from '../test/fixtures.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-store-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('ProjectStore round-trip', () => {
  it('creates a project, copies the video, and persists project + pipeline json', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video, { name: 'My Dub' }));

    expect(project.id).toMatch(/^proj_/);
    expect(project.name).toBe('My Dub');
    expect(project.status).toBe('created');

    // The input video was copied into the workspace.
    const internal = await fsp.readFile(project.inputVideoPath, 'utf8');
    expect(internal).toBe('dummy-video-bytes');
    expect(project.inputVideoPath).toContain(path.join('input', 'original.mp4'));

    // project.json + pipeline.json exist and round-trip.
    const loaded = await store.getProject(project.id);
    expect(loaded.id).toBe(project.id);
    expect(loaded.settings.targetLanguage).toBe('vi-VN');

    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.projectId).toBe(project.id);
    expect(pipeline.steps).toHaveLength(9);
    expect(pipeline.status).toBe('idle');
    expect(pipeline.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('round-trips an updated project (status + mediaInfo)', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const updated = await store.saveProject({
      ...project,
      status: 'running',
      settings: defaultSettings({ targetLanguage: 'fr' }),
    });
    expect(updated.status).toBe('running');
    expect(updated.updatedAt >= project.updatedAt).toBe(true);

    const reloaded = await store.getProject(project.id);
    expect(reloaded.status).toBe('running');
    expect(reloaded.settings.targetLanguage).toBe('fr');
  });

  it('lists projects (most recent first) and skips non-project directories', async () => {
    const video = await writeDummyVideo(tmp, 'a.mp4');
    const p1 = await store.createProject(createProjectInput(video, { name: 'A' }));
    const p2 = await store.createProject(createProjectInput(video, { name: 'B' }));

    // Bump p2's updatedAt so it sorts first deterministically.
    await store.saveProject({ ...(await store.getProject(p2.id)), status: 'completed' });

    // A stray directory without project.json must be ignored.
    await fsp.mkdir(path.join(tmp, 'projects', 'not-a-project'), { recursive: true });

    const list = await store.listProjects();
    expect(list.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    // Newest (p2) should be first.
    expect(list[0]?.id).toBe(p2.id);
  });

  it('returns an empty list when the projects dir does not exist', async () => {
    const empty = new ProjectStore(path.join(tmp, 'does-not-exist'));
    await expect(empty.listProjects()).resolves.toEqual([]);
  });

  it('throws a structured error for a missing project', async () => {
    await expect(store.getProject('proj_missing')).rejects.toMatchObject({
      appError: { code: 'UNKNOWN' },
    });
  });

  it('throws UNSUPPORTED_MEDIA when the input video does not exist', async () => {
    await expect(
      store.createProject(createProjectInput(path.join(tmp, 'nope.mp4'))),
    ).rejects.toMatchObject({ appError: { code: 'UNSUPPORTED_MEDIA' } });
  });
});

describe('ProjectStore — the folder chosen for the finished files', () => {
  it('saves to the project render/ folder when none is chosen', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    expect(project.outputDir).toBe(store.paths(project.id).renderDir);
    expect(project.outputFileName).toBeUndefined();
  });

  it('names the files after the project in a chosen folder, never over another project', async () => {
    const video = await writeDummyVideo(tmp);
    const dubs = path.join(tmp, 'My Dubs');
    await fsp.mkdir(dubs);
    await fsp.writeFile(path.join(dubs, 'Clip.vi.mp4'), 'another project');

    const project = await store.createProject(createProjectInput(video, { name: 'Clip', outputDir: dubs }));
    expect(project.outputDir).toBe(dubs);
    expect(project.outputFileName).toBe('Clip (2).vi');
    expect((await store.getProject(project.id)).outputFileName).toBe('Clip (2).vi');
  });

  it('refuses a folder it cannot write in before creating anything', async () => {
    const video = await writeDummyVideo(tmp);
    const file = path.join(tmp, 'a-file');
    await fsp.writeFile(file, 'x');
    await expect(
      store.createProject(createProjectInput(video, { outputDir: path.join(file, 'Dubs') })),
    ).rejects.toMatchObject({ appError: { code: 'OUTPUT_NOT_WRITABLE' } });
    // Not even an empty workspace folder.
    expect(await fsp.readdir(path.join(tmp, 'projects')).catch(() => [])).toEqual([]);
  });
});

describe('ProjectStore — names in a shared folder (review findings)', () => {
  it('two projects with the same name in one folder get different names before either renders', async () => {
    const video = await writeDummyVideo(tmp);
    const dubs = path.join(tmp, 'Dubs');
    const a = await store.createProject(createProjectInput(video, { name: 'Clip', outputDir: dubs }));
    const b = await store.createProject(createProjectInput(video, { name: 'Clip', outputDir: dubs }));
    expect(a.outputFileName).toBe('Clip.vi');
    expect(b.outputFileName).toBe('Clip (2).vi');
  });

  it('two projects created at the same moment cannot take the same free name', async () => {
    const video = await writeDummyVideo(tmp);
    const dubs = path.join(tmp, 'Dubs');
    const made = await Promise.all(
      [1, 2, 3].map(() => store.createProject(createProjectInput(video, { name: 'Clip', outputDir: dubs }))),
    );
    expect(new Set(made.map((p) => p.outputFileName)).size).toBe(3);
  });

  it('reads an old project that names another folder without a file name of its own as saving to its render/ folder', async () => {
    // The old wizard's text field could set outputDir; the render ignored it
    // and always wrote render/output.mp4.
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    await writeJsonFile(store.paths(project.id).projectJson, { ...project, outputDir: path.join(tmp, 'elsewhere') });
    expect((await store.getProject(project.id)).outputDir).toBe(store.paths(project.id).renderDir);
    expect((await store.listProjects())[0]!.outputDir).toBe(store.paths(project.id).renderDir);
  });
});

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fsp.writeFile(file, JSON.stringify(value), 'utf8');
}
