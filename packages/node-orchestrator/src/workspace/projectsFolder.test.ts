import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWithin, moveFolder, readProjectsRoot, rebaseJson, rebasePath, rewriteMovedPaths, writeProjectsRoot } from './projectsFolder.js';

describe('rebasePath', () => {
  it('re-roots a path inside the folder, and the folder itself (Windows: any case, either slash)', () => {
    const from = 'C:\\Users\\Me\\VideoDubber\\projects\\proj_1';
    const to = 'D:\\dubs\\projects\\proj_1';
    expect(rebasePath('C:\\Users\\Me\\VideoDubber\\projects\\proj_1\\render\\output.mp4', from, to, true)).toBe(
      'D:\\dubs\\projects\\proj_1\\render\\output.mp4',
    );
    expect(rebasePath('c:/users/me/videodubber/projects/proj_1/input/original.mp4', from, to, true)).toBe(
      'D:\\dubs\\projects\\proj_1/input/original.mp4',
    );
    expect(rebasePath(from, from, to, true)).toBe(to);
  });

  it('leaves anything else alone: another project, a look-alike prefix, a folder the user chose, plain text', () => {
    const from = '/home/me/VideoDubber/projects/proj_1';
    const to = '/data/projects/proj_1';
    expect(rebasePath('/home/me/VideoDubber/projects/proj_10/x.wav', from, to, false)).toBe('/home/me/VideoDubber/projects/proj_10/x.wav');
    expect(rebasePath('/home/me/Movies/Clip.vi.mp4', from, to, false)).toBe('/home/me/Movies/Clip.vi.mp4');
    expect(rebasePath('Xin chào', from, to, false)).toBe('Xin chào');
    // POSIX paths are case-sensitive.
    expect(rebasePath('/home/me/videodubber/projects/proj_1/a', from, to, false)).toBe('/home/me/videodubber/projects/proj_1/a');
  });
});

describe('rebaseJson / isWithin', () => {
  it('re-roots every string, deep, and keeps numbers, booleans and nulls', () => {
    const from = '/p/proj_1';
    const doc = { workspaceDir: '/p/proj_1', segments: [{ audioPath: '/p/proj_1/tts/a.wav', startMs: 10, ok: true, note: null }] };
    expect(rebaseJson(doc, from, '/q/proj_1', false)).toEqual({
      workspaceDir: '/q/proj_1',
      segments: [{ audioPath: '/q/proj_1/tts/a.wav', startMs: 10, ok: true, note: null }],
    });
  });

  it('tells a folder inside another from a sibling with a longer name', () => {
    expect(isWithin('/a/projects/x', '/a/projects', false)).toBe(true);
    expect(isWithin('/a/projects', '/a/projects/', false)).toBe(true);
    expect(isWithin('/a/projects-old', '/a/projects', false)).toBe(false);
    expect(isWithin('D:\\A\\Projects\\X', 'd:\\a\\projects', true)).toBe(true);
  });
});

describe('the projects folder on disk', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-projects-folder-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('remembers the chosen root, and forgets it for the default', async () => {
    expect(await readProjectsRoot(tmp)).toBeUndefined();
    const root = path.join(tmp, 'Dubs');
    await writeProjectsRoot(tmp, root);
    expect(await readProjectsRoot(tmp)).toBe(root);
    await writeProjectsRoot(tmp, undefined);
    expect(await readProjectsRoot(tmp)).toBeUndefined();
  });

  it('moves a project folder whole and rewrites the paths its JSON files hold', async () => {
    const from = path.join(tmp, 'old', 'projects', 'proj_1');
    const to = path.join(tmp, 'new', 'projects', 'proj_1');
    await fsp.mkdir(path.join(from, 'subtitles'), { recursive: true });
    await fsp.writeFile(path.join(from, 'project.json'), JSON.stringify({ workspaceDir: from, inputVideoPath: path.join(from, 'input', 'original.mp4'), outputDir: path.join(tmp, 'Movies') }));
    await fsp.writeFile(path.join(from, 'subtitles', 'translated.aligned.json'), JSON.stringify([{ audioPath: path.join(from, 'audio', 'a.wav') }]));
    await fsp.writeFile(path.join(from, 'notes.txt'), from);

    expect(await moveFolder(from, to)).toBe(true);
    expect(await rewriteMovedPaths(to, from, to)).toBe(2);

    expect(await fsp.stat(from).catch(() => null)).toBeNull();
    const project = JSON.parse(await fsp.readFile(path.join(to, 'project.json'), 'utf8')) as Record<string, string>;
    expect(project).toEqual({
      workspaceDir: to,
      inputVideoPath: path.join(to, 'input', 'original.mp4'),
      outputDir: path.join(tmp, 'Movies'),
    });
    const aligned = JSON.parse(await fsp.readFile(path.join(to, 'subtitles', 'translated.aligned.json'), 'utf8')) as { audioPath: string }[];
    expect(aligned[0]!.audioPath).toBe(path.join(to, 'audio', 'a.wav'));
    // Not JSON: not VideoDubber's to rewrite.
    expect(await fsp.readFile(path.join(to, 'notes.txt'), 'utf8')).toBe(from);
  });
});
