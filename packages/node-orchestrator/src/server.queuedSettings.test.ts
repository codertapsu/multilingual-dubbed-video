import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import {
  createProjectInput,
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  fakeMediaInfo,
  fakeRegistry,
  writeDummyVideo,
} from './test/fixtures.js';
import { ProjectStore } from './workspace/projectStore.js';

/**
 * PUT /projects/:id/settings on a dub waiting in the queue: its mix and render
 * change where it waits, anything else is refused with what to do. A queued
 * part refused even its subtitle band, while the series' applyToParts changed
 * it there (claude-dubber, 2026-11-27).
 */
describe('settings of a dub waiting in the queue', () => {
  let tmp: string;
  let app: FastifyInstance;
  let orchestrator: LocalJobOrchestrator;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-queued-'));
    const config = loadConfig({ projectsDir: path.join(tmp, 'projects'), configDir: path.join(tmp, 'config'), modelsDir: path.join(tmp, 'models') });
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(60_000) });
    // The queue paused: a dub that is started waits there.
    orchestrator = new LocalJobOrchestrator({
      config,
      store: new ProjectStore(config.projectsDir),
      media,
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      setup: { getPreferences: async () => ({ autoUpdate: true, concurrency: { mode: 'manual' as const, maxProjects: 1, paused: true } }) },
    });
    app = await createServer({ config, media, orchestrator });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('takes a change to the mix or render where it waits, and refuses the rest saying how', async () => {
    const project = (await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(await writeDummyVideo(tmp)) })).json() as Project;
    const started = await app.inject({ method: 'POST', url: `/projects/${project.id}/run` });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ queued: true });

    const band = { coverBand: { y: 0.827, h: 0.13 } };
    const mix = await app.inject({ method: 'PUT', url: `/projects/${project.id}/settings`, payload: { burnSubtitleStyle: band } });
    expect(mix.statusCode).toBe(200);
    expect((mix.json() as { project: Project }).project.settings.burnSubtitleStyle).toMatchObject(band);
    // Still waiting its turn: changed where it waits, not taken out.
    expect(orchestrator.workOn(project.id)).toBe('queued');

    // A change the queue's choice depends on (the voice and its engine): refused, with what to do.
    const voice = await app.inject({ method: 'PUT', url: `/projects/${project.id}/settings`, payload: { ttsVoiceId: 'another-voice' } });
    expect(voice.statusCode).toBeGreaterThanOrEqual(400);
    const { error } = voice.json() as { error: { code: string; message: string; remediation?: string } };
    expect(error.code).toBe('RUN_IN_PROGRESS');
    expect(error.message).toContain('only its mix and render settings can change there');
    expect(error.remediation).toContain('pause it (it keeps its work)');
    await orchestrator.cancelJob(project.id);
  });
});
