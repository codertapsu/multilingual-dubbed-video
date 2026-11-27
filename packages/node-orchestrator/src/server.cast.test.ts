import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { createProjectInput, FakeMediaService, writeDummyVideo } from './test/fixtures.js';

/** POST /projects/:id/speakers/cast over a project's own files: characters from its sheet (claude-dubber, 2026-11-27). */
describe('casting by character', () => {
  let tmp: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-cast-'));
    const root = path.join(tmp, 'VideoDubber');
    app = await createServer({
      config: loadConfig({ projectsDir: path.join(root, 'projects'), configDir: root, modelsDir: path.join(root, 'models') }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('casts the ids the sheet gives one name as one character, and a system voice as a voice-over', async () => {
    const made = await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(await writeDummyVideo(tmp)) });
    const project = made.json() as Project;
    const dir = project.workspaceDir;
    const line = (i: number, speakerId: string, startMs: number, endMs: number) => ({
      id: `seg_${String(i).padStart(4, '0')}`,
      index: i - 1,
      startMs,
      endMs,
      sourceText: '你好',
      speakerId,
    });
    // Linh Nhi split by speaker detection into two ids; the system voice heard most.
    const lines = [
      line(1, 'SPEAKER_00', 0, 20_000),
      line(2, 'SPEAKER_15', 20_000, 26_000),
      line(3, 'SPEAKER_16', 26_000, 31_000),
      line(4, 'SPEAKER_09', 31_000, 70_000),
    ];
    await fsp.mkdir(path.join(dir, 'subtitles'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'subtitles', 'source.json'), JSON.stringify({ segments: lines }));
    // Speaker detection could not tell any of their genders.
    await fsp.mkdir(path.join(dir, 'audio'), { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'audio', 'diarization.json'),
      JSON.stringify({
        format: 2,
        audio: { sizeBytes: 1, mtimeMs: 1 },
        model: 'test',
        turns: [],
        speakers: ['SPEAKER_00', 'SPEAKER_15', 'SPEAKER_16', 'SPEAKER_09'].map((speakerId, i) => ({
          speakerId,
          speaker: i,
          sec: 0,
          f0Hz: null,
          gender: 'unknown',
          genderConfidence: 0,
          print: [],
        })),
      }),
    );
    await fsp.writeFile(
      path.join(dir, 'subtitles', 'translation_context.json'),
      JSON.stringify({
        cast: [
          { name: 'Lục Trần', role: 'nhân vật chính', speakerId: 'SPEAKER_00' },
          { name: 'Linh Nhi', role: 'Mộc tam tiểu thư', speakerId: 'SPEAKER_15' },
          { name: 'Linh Nhi', speakerId: 'SPEAKER_16' },
          { name: 'Hệ thống', role: 'giọng hệ thống báo thưởng', speakerId: 'SPEAKER_09' },
        ],
      }),
    );
    const res = await app.inject({ method: 'POST', url: `/projects/${project.id}/speakers/cast`, payload: {} });
    expect(res.statusCode).toBe(200);
    const cast = res.json() as { notes: string[]; unassigned: string[] };
    expect(cast.notes).toContain('"Linh Nhi": SPEAKER_15, SPEAKER_16 speak as one character (0.2 min together), with one voice.');
    expect(cast.notes).toContain('"Hệ thống" is a narrator or a system voice: no lead voice or clone, a built-in voice.');
    // No gender known here: every id of a character is left to the project voice together.
    expect(cast.unassigned.sort()).toEqual(['SPEAKER_00', 'SPEAKER_09', 'SPEAKER_15', 'SPEAKER_16']);
    const unknownOf = (body: unknown) => ((body as { unknown?: { speakerId: string }[] }).unknown ?? []).map((u) => u.speakerId).sort();
    expect(unknownOf(cast)).toEqual(['SPEAKER_00', 'SPEAKER_09', 'SPEAKER_15', 'SPEAKER_16']);

    // Genders set in the settings count: they were ignored, and 11 speakers kept the project voice (2026-11-27).
    const set = await app.inject({ method: 'PUT', url: `/projects/${project.id}/settings`, payload: { speakerGenders: { SPEAKER_00: 'male', SPEAKER_15: 'female' } } });
    expect(set.statusCode).toBe(200);
    const again = (await app.inject({ method: 'POST', url: `/projects/${project.id}/speakers/cast`, payload: {} })).json();
    // Linh Nhi's other id follows her gender (the character's), the hero is a man now: only the system voice is unknown.
    expect(unknownOf(again)).toEqual(['SPEAKER_09']);
  });
});
