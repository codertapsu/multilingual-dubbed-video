import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore, writeJsonAtomic } from './projectStore.js';
import { readProjectsRoot } from './projectsFolder.js';
import { ProjectsFolderService } from './projectsFolderService.js';
import { createProjectInput, writeDummyVideo } from '../test/fixtures.js';

let tmp: string;
let configDir: string;
let defaultDir: string;
let store: ProjectStore;
let busy: string[];
let service: ProjectsFolderService;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-folder-svc-'));
  configDir = path.join(tmp, 'VideoDubber');
  defaultDir = path.join(configDir, 'projects');
  store = new ProjectStore(defaultDir);
  busy = [];
  service = new ProjectsFolderService({ configDir, defaultProjectsDir: defaultDir, store, busyProjects: () => busy });
});

afterEach(async () => {
  // A move still copying would refill the folder being removed (ENOTEMPTY).
  await settled();
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Wait until the background move has ended. Generous: in the full parallel
 * suite on Windows a two-project move took over 2 s, and a test that read the
 * folder mid-move failed on a state that was only late.
 */
async function settled() {
  for (let i = 0; i < 1500 && service.moving; i++) await new Promise((r) => setTimeout(r, 20));
  return service.info();
}

describe('ProjectsFolderService', () => {
  it('starts in VideoDubber’s own data folder', async () => {
    expect(await service.info()).toMatchObject({ root: configDir, projectsDir: defaultDir, defaultRoot: configDir, isDefault: true });
  });

  it('moves every project to <root>/projects, keeps their structure and paths working, and remembers the root', async () => {
    const video = await writeDummyVideo(tmp);
    const chosenOutput = path.join(tmp, 'Movies');
    const a = await store.createProject(createProjectInput(video, { name: 'A' }));
    const b = await store.createProject(createProjectInput(video, { name: 'B', outputDir: chosenOutput }));
    await writeJsonAtomic(store.paths(a.id).translatedAlignedJson, [{ segmentId: 's1', audioPath: path.join(store.paths(a.id).root, 'audio', 'x.wav') }]);

    const root = path.join(tmp, 'claude-dubber');
    const started = await service.move(root);
    expect(started.moving).toMatchObject({ total: 2 });
    const info = await settled();

    expect(info).toMatchObject({ root, projectsDir: path.join(root, 'projects'), isDefault: false, projectCount: 2 });
    expect(info.lastError).toBeUndefined();
    expect(store.projectsDir).toBe(path.join(root, 'projects'));
    expect(await readProjectsRoot(configDir)).toBe(root);

    const movedA = await store.getProject(a.id);
    expect(movedA.workspaceDir).toBe(path.join(root, 'projects', a.id));
    expect(movedA.outputDir).toBe(path.join(root, 'projects', a.id, 'render'));
    expect(await fsp.readFile(movedA.inputVideoPath, 'utf8')).toBe('dummy-video-bytes');
    const aligned = JSON.parse(await fsp.readFile(store.paths(a.id).translatedAlignedJson, 'utf8')) as { audioPath: string }[];
    expect(aligned[0]!.audioPath).toBe(path.join(root, 'projects', a.id, 'audio', 'x.wav'));
    // A folder the user chose for the finished files is theirs: unchanged.
    expect((await store.getProject(b.id)).outputDir).toBe(chosenOutput);
    // Nothing left behind.
    expect(await fsp.stat(defaultDir).catch(() => null)).toBeNull();

    // And back to the default: the setting is forgotten.
    await service.move(null);
    expect(await settled()).toMatchObject({ isDefault: true, projectCount: 2 });
    expect(await readProjectsRoot(configDir)).toBeUndefined();
  });

  it('refuses while a project is busy, and a folder inside the current one, before moving anything', async () => {
    const video = await writeDummyVideo(tmp);
    const a = await store.createProject(createProjectInput(video));
    busy = [a.id];
    await expect(service.move(path.join(tmp, 'elsewhere'))).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    busy = [];
    await expect(service.move(defaultDir)).rejects.toMatchObject({ appError: { message: expect.stringContaining('outside the current projects folder') } });
    expect(store.projectsDir).toBe(defaultDir);
    expect(await store.listProjects()).toHaveLength(1);
  });

  it('refuses a folder that already has a project folder of the same id', async () => {
    const video = await writeDummyVideo(tmp);
    const a = await store.createProject(createProjectInput(video));
    const root = path.join(tmp, 'Other');
    await fsp.mkdir(path.join(root, 'projects', a.id), { recursive: true });
    await expect(service.move(root)).rejects.toMatchObject({ appError: { message: expect.stringContaining(a.id) } });
    expect(store.projectsDir).toBe(defaultDir);
  });
});
