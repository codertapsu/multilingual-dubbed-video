/**
 * The brand kit (Settings → Logo & lời chào, `<config>/branding/`): logos and
 * spoken greetings, made once and chosen per project.
 *
 * A project keeps its own copy of what it uses (`<project>/branding/`), made
 * when it is chosen: deleting or replacing an item in the kit never changes a
 * finished project, and a project moved to another folder takes its copy along.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppErrorException, type BrandAsset, type BrandingSettings } from '@videodubber/shared';

import type { PipelineMediaService } from '../media.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** The longest greeting: it has to fit in a pause between lines. */
export const MAX_GREETING_MS = 15_000;

export interface BrandKitDeps {
  /** `<config>/branding`. */
  dir: string;
  media: Pick<PipelineMediaService, 'prepareLogo' | 'prepareGreeting'>;
  /** An installed voice saying a sentence (the Voices screen's Listen): a WAV path. */
  speak?: (voiceId: string, text: string, language: string) => Promise<string>;
}

export class BrandKit {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BrandKitDeps) {}

  private get indexFile(): string {
    return path.join(this.deps.dir, 'index.json');
  }

  async list(): Promise<BrandAsset[]> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile, 'utf8')) as { assets?: BrandAsset[] };
      return Array.isArray(raw.assets) ? raw.assets.filter((a) => a && typeof a.id === 'string') : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<BrandAsset> {
    const asset = (await this.list()).find((a) => a.id === id);
    if (!asset) {
      throw new AppErrorException('INVALID_EDIT', `There is no logo or greeting "${id}" in the brand kit.`, {
        remediation: 'Choose one from Settings → Logo & greeting, or add it there first.',
      });
    }
    return asset;
  }

  /** A logo from any picture (PNG, JPG, WebP…), kept as a PNG at most 1024 px wide. */
  async addLogo(name: string, sourcePath: string): Promise<BrandAsset> {
    if (!this.deps.media.prepareLogo) throw unavailable();
    const id = `logo_${randomBytes(5).toString('hex')}`;
    const file = path.join(this.deps.dir, `${id}.png`);
    await fsp.mkdir(this.deps.dir, { recursive: true });
    const size = await this.deps.media.prepareLogo(requireFile(sourcePath), file).catch((err: unknown) => {
      throw new AppErrorException('UNSUPPORTED_MEDIA', 'That file is not a picture VideoDubber can read.', {
        cause: String(err).slice(0, 300),
        remediation: 'Choose a PNG, JPG or WebP image (a PNG with a transparent background looks best).',
      });
    });
    return this.add({ id, kind: 'logo', name: cleanName(name, 'Logo'), path: file, createdAt: new Date().toISOString(), ...size });
  }

  /** A greeting from any audio or video file: silence trimmed, levelled to the dub's voices. */
  async addGreeting(name: string, sourcePath: string, spoken?: { text: string; voiceId: string }): Promise<BrandAsset> {
    if (!this.deps.media.prepareGreeting) throw unavailable();
    const id = `greeting_${randomBytes(5).toString('hex')}`;
    const file = path.join(this.deps.dir, `${id}.wav`);
    await fsp.mkdir(this.deps.dir, { recursive: true });
    const { durationMs } = await this.deps.media.prepareGreeting(requireFile(sourcePath), file).catch((err: unknown) => {
      throw new AppErrorException('UNSUPPORTED_MEDIA', 'That file has no sound VideoDubber can read.', {
        cause: String(err).slice(0, 300),
        remediation: 'Choose an audio file (MP3, WAV, M4A…) or a video with sound.',
      });
    });
    if (durationMs < 300 || durationMs > MAX_GREETING_MS) {
      await fsp.rm(file, { force: true });
      throw new AppErrorException('INVALID_EDIT',
        durationMs < 300
          ? 'The greeting is silent (nothing louder than the background was found).'
          : `The greeting is ${(durationMs / 1000).toFixed(1)} s long; at most ${MAX_GREETING_MS / 1000} s fits between lines.`,
        { remediation: 'Use a short greeting, like "Chào mừng các bạn đến với kênh…" (2–8 seconds is ideal).' });
    }
    return this.add({
      id,
      kind: 'greeting',
      name: cleanName(name, 'Greeting'),
      path: file,
      createdAt: new Date().toISOString(),
      durationMs,
      ...(spoken ? { text: spoken.text, voiceId: spoken.voiceId } : {}),
    });
  }

  /** A greeting said by one of the app's voices. */
  async addSpokenGreeting(name: string, text: string, voiceId: string, language: string): Promise<BrandAsset> {
    const sentence = text.trim();
    if (!sentence || sentence.length > 300) {
      throw new AppErrorException('INVALID_EDIT', 'Write the greeting (at most 300 characters).');
    }
    if (!this.deps.speak) throw unavailable();
    const wav = await this.deps.speak(voiceId, sentence, language);
    return this.addGreeting(name || sentence.slice(0, 40), wav, { text: sentence, voiceId });
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.list();
      const gone = all.find((a) => a.id === id);
      await writeJsonAtomic(this.indexFile, { assets: all.filter((a) => a.id !== id) });
      if (gone) await fsp.rm(gone.path, { force: true }).catch(() => undefined);
    });
  }

  private add(asset: BrandAsset): Promise<BrandAsset> {
    return this.serial(async () => {
      const all = await this.list();
      await writeJsonAtomic(this.indexFile, { assets: [...all, asset] });
      return asset;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

function cleanName(name: string, fallback: string): string {
  return name.trim().slice(0, 60) || fallback;
}

function requireFile(p: string): string {
  if (!p || !path.isAbsolute(p)) {
    throw new AppErrorException('INVALID_EDIT', 'Choose the file with its full path (for example D:\\Brand\\logo.png).');
  }
  return p;
}

function unavailable(): AppErrorException {
  return new AppErrorException('ENGINE_UNAVAILABLE', 'This build cannot prepare brand kit files.', {
    remediation: 'Reinstall VideoDubber.',
  });
}

/** What a project's branding needs on disk: the project's own copies. */
export interface ProjectBrandFiles {
  logoPath?: string;
  greetingPath?: string;
  greetingDurationMs?: number;
}

/**
 * The project's copies of its logo and greeting (`<workspace>/branding/`),
 * made from the kit the first time; afterwards the copy is used even when the
 * kit no longer has the item. Each copy has its asset's details beside it.
 */
export async function projectBrandFiles(
  workspaceDir: string,
  branding: BrandingSettings | undefined,
  kit: Pick<BrandKit, 'get'>,
): Promise<ProjectBrandFiles> {
  const out: ProjectBrandFiles = {};
  const dir = path.join(workspaceDir, 'branding');
  const ensure = async (assetId: string, ext: string): Promise<{ file: string; meta: BrandAsset }> => {
    const file = path.join(dir, `${assetId}.${ext}`);
    const metaFile = path.join(dir, `${assetId}.json`);
    try {
      const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')) as BrandAsset;
      await fsp.access(file);
      return { file, meta };
    } catch {
      /* not copied yet */
    }
    const asset = await kit.get(assetId).catch(() => {
      throw new AppErrorException('INVALID_EDIT', 'The logo or greeting this project uses was deleted from the brand kit.', {
        remediation: 'Choose another one in the project\'s Logo & greeting settings, or turn it off.',
      });
    });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(asset.path, file);
    await writeJsonAtomic(metaFile, { ...asset, path: file });
    return { file, meta: asset };
  };
  if (branding?.logo?.assetId) out.logoPath = (await ensure(branding.logo.assetId, 'png')).file;
  if (branding?.greeting?.assetId) {
    const g = await ensure(branding.greeting.assetId, 'wav');
    out.greetingPath = g.file;
    if (g.meta.durationMs) out.greetingDurationMs = g.meta.durationMs;
  }
  return out;
}
