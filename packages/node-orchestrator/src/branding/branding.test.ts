import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGO, type BrandAsset } from '@videodubber/shared';

import { loadConfig } from '../config.js';
import { EventBusRegistry } from '../events.js';
import { LocalJobOrchestrator } from '../orchestrator.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeMediaInfo,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { sanitizeBranding } from './sanitize.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-branding-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('sanitizeBranding', () => {
  it('keeps known choices in range and drops the rest', () => {
    expect(
      sanitizeBranding({
        logo: { assetId: 'logo_abc123', corner: 'middle', widthPct: 90, opacity: 3, show: 'interval', everyMin: 0 },
        greeting: { assetId: 'nope', repeat: 'auto' },
      }),
    ).toEqual({
      logo: { assetId: 'logo_abc123', corner: 'top-right', widthPct: 50, marginPct: 4, opacity: 1, show: 'interval', showSec: 10, everyMin: 1 },
    });
    expect(sanitizeBranding({})).toBeUndefined();
    expect(sanitizeBranding({ greeting: { assetId: 'greeting_abc123', repeat: 0 } })).toEqual({
      greeting: { assetId: 'greeting_abc123', atStart: true, startWindowSec: 60, repeat: 'off', gainDb: 0 },
    });
  });
});

describe('a dub with a logo and a greeting', () => {
  async function setup() {
    const kitDir = path.join(tmp, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    const assets: BrandAsset[] = [
      { id: 'greeting_abc123', kind: 'greeting', name: 'Chào', path: path.join(kitDir, 'greeting_abc123.wav'), createdAt: '', durationMs: 2000 },
      { id: 'logo_abc123', kind: 'logo', name: 'Logo', path: path.join(kitDir, 'logo_abc123.png'), createdAt: '', width: 200, height: 100 },
    ];
    for (const a of assets) await fsp.writeFile(a.path, a.id);
    const get = vi.fn(async (id: string) => {
      const a = assets.find((x) => x.id === id);
      if (!a) throw new Error('gone');
      return a;
    });
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(60_000) });
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      // Quiet from 0 to 5 s (the opening), then talk.
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[5000, 8000, 'xin chào'], [9000, 12_000, 'các bạn']])),
        new FakeTranslationProvider(),
        new FakeTtsProvider(() => 900),
      ),
      bus: new EventBusRegistry(),
      brandKit: { get },
    });
    const video = await writeDummyVideo(tmp);
    const input = createProjectInput(video, { name: 'Brand' });
    const project = await s.createProject({
      ...input,
      settings: {
        ...input.settings,
        branding: {
          logo: { assetId: 'logo_abc123', ...DEFAULT_LOGO },
          greeting: { assetId: 'greeting_abc123', atStart: true, startWindowSec: 60, repeat: 'off', gainDb: -2 },
        },
      },
    });
    return { s, media, get, id: project.id };
  }

  it('lays the greeting into the first quiet moment, draws the logo, and keeps copies in the project', async () => {
    const { s, media, get, id } = await setup();
    await s.runPipeline(id);
    await vi.waitFor(async () => expect((await store.getProject(id)).status).toBe('completed'), { timeout: 15_000 });

    const project = await store.getProject(id);
    const greetingCopy = path.join(project.workspaceDir, 'branding', 'greeting_abc123.wav');
    const clips = media.timelineInputs.at(-1)!.segments;
    expect(clips).toContainEqual(expect.objectContaining({ audioPath: greetingCopy, startMs: 400, durationMs: 2000, gainDb: -2 }));
    expect(media.renderInputs.at(-1)!.logo).toEqual({
      imagePath: path.join(project.workspaceDir, 'branding', 'logo_abc123.png'),
      corner: 'top-right',
      widthPct: 10,
      marginPct: 4,
      opacity: 0.85,
    });
    expect(await s.mixIsCurrent(id)).toBe(true);

    // The kit loses both: the project's copies still work.
    get.mockRejectedValue(new Error('gone'));
    expect((await s.rerender(id, {})).fromStep).toBe('render');
    await vi.waitFor(
      async () => {
        expect(media.renderInputs).toHaveLength(2);
        expect((await store.getProject(id)).status).toBe('completed');
      },
      { timeout: 15_000 },
    );
    expect(media.renderInputs[1]!.logo?.imagePath).toBe(path.join(project.workspaceDir, 'branding', 'logo_abc123.png'));
  });

  it('counts a greeting change as a new mix, and a logo change as a render only', async () => {
    const { s, id } = await setup();
    await s.runPipeline(id);
    await vi.waitFor(async () => expect((await store.getProject(id)).status).toBe('completed'), { timeout: 15_000 });
    const branding = (await store.getProject(id)).settings.branding!;

    await s.updateProjectSettings(id, { branding: { ...branding, logo: { ...branding.logo!, corner: 'bottom-left' } } });
    expect(await s.mixIsCurrent(id)).toBe(true);

    await s.updateProjectSettings(id, { branding: { ...branding, greeting: { ...branding.greeting!, repeat: 'auto' } } });
    expect(await s.mixIsCurrent(id)).toBe(false);
  });
});
