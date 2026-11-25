/**
 * Dub presets ("Mẫu lồng tiếng", `<config>/dub-presets.json`): the choices a
 * user makes for every video of a channel (languages, engines, voice,
 * subtitles, where files go), saved once and used by New project, a batch of
 * downloads and the plugin.
 *
 * A preset holds only what the user chose: a project made from it starts from
 * the settings the app recommends for this machine and lays the preset over
 * them, so a preset saved before an engine was installed still gets that
 * engine's defaults for everything it does not name.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  AppErrorException,
  partNameTemplateProblem,
  resolveOutputDir,
  seriesAiId,
  type DubPreset,
  type PresetSeries,
  type ProjectSettings,
} from '@videodubber/shared';

import { writeJsonAtomic } from './projectStore.js';

export const PRESETS_FILE = 'dub-presets.json';

/** What a client may set (id and times are the store's). */
export type DubPresetInput = Pick<DubPreset, 'name' | 'targetLanguage'> &
  Partial<Pick<DubPreset, 'sourceLanguage' | 'settings' | 'outputDir' | 'start' | 'series'>>;

/**
 * A preset's series block, kept to well-formed values (`ai` is taken for
 * `aiProviderId`, as the MCP tools call it, and a short name is kept as the
 * app's id: "anthropic" is "anthropic-translate"); undefined when it says nothing.
 * Refuses a name template that cannot name the parts. Pure.
 */
export function cleanPresetSeries(raw: unknown): PresetSeries | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const num = (key: string, min: number, max: number): number | undefined => {
    const v = s[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
  };
  const minMinutes = num('minMinutes', 5, 120);
  const maxMinutes = num('maxMinutes', 5, 180);
  const recapSec = num('recapSec', 0, 8);
  const longerThanMinutes = num('longerThanMinutes', 1, 1440);
  const ai = [s['aiProviderId'], s['ai']].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim();
  const nameTemplate = typeof s['nameTemplate'] === 'string' && s['nameTemplate'].trim() ? s['nameTemplate'].trim() : undefined;
  if (nameTemplate) {
    const problem = partNameTemplateProblem(nameTemplate);
    if (problem) {
      throw new AppErrorException('INVALID_EDIT', `The preset's part names "${nameTemplate}" cannot name the parts (${problem.code}).`, {
        remediation: 'Use {series}, {n} or {nn}, {total} and {title}; it needs {n} or {nn}, e.g. "{series} - Phần {n} - {title}".',
      });
    }
  }
  const series: PresetSeries = {
    ...(minMinutes !== undefined ? { minMinutes } : {}),
    ...(maxMinutes !== undefined ? { maxMinutes: Math.max(maxMinutes, minMinutes ?? 0) } : {}),
    ...(ai ? { aiProviderId: seriesAiId(ai) } : {}),
    ...(recapSec !== undefined ? { recapSec } : {}),
    ...(typeof s['autoStart'] === 'boolean' ? { autoStart: s['autoStart'] } : {}),
    ...(nameTemplate ? { nameTemplate } : {}),
    ...(longerThanMinutes !== undefined ? { longerThanMinutes } : {}),
  };
  return Object.keys(series).length > 0 ? series : undefined;
}

/** Keep only well-formed fields; refuse a preset without a name or a target language. Pure. */
export function cleanPresetInput(raw: unknown): DubPresetInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r['name'] === 'string' ? r['name'].trim().slice(0, 80) : '';
  const targetLanguage = typeof r['targetLanguage'] === 'string' ? r['targetLanguage'].trim() : '';
  if (!name || !targetLanguage) {
    throw new AppErrorException('INVALID_EDIT', 'A preset needs a name and a dub language.', {
      remediation: 'Give it a name (for example the channel it is for) and choose the language to dub into.',
    });
  }
  const settings = r['settings'] && typeof r['settings'] === 'object' && !Array.isArray(r['settings'])
    ? (r['settings'] as Partial<ProjectSettings>)
    : {};
  const outputDir = typeof r['outputDir'] === 'string' && r['outputDir'].trim() ? r['outputDir'].trim() : undefined;
  if (outputDir && !path.isAbsolute(resolveOutputDir(outputDir, 'name'))) {
    throw new AppErrorException('INVALID_EDIT', 'The save folder must be a full path, like D:\\Dubs (or D:\\Dubs\\{series}).');
  }
  const series = cleanPresetSeries(r['series']);
  return {
    name,
    targetLanguage,
    ...(typeof r['sourceLanguage'] === 'string' && r['sourceLanguage'].trim() ? { sourceLanguage: r['sourceLanguage'].trim() } : {}),
    // The languages live outside `settings`, so the preset has one place for each.
    settings: Object.fromEntries(
      Object.entries(settings).filter(([k]) => k !== 'sourceLanguage' && k !== 'targetLanguage'),
    ) as Partial<ProjectSettings>,
    ...(outputDir ? { outputDir } : {}),
    ...(r['start'] === true ? { start: true } : {}),
    ...(series ? { series } : {}),
  };
}

export class PresetStore {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(configDir: string) {
    this.file = path.join(configDir, PRESETS_FILE);
  }

  async list(): Promise<DubPreset[]> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as { presets?: DubPreset[] };
      return Array.isArray(raw.presets) ? raw.presets.filter((p) => p && typeof p.id === 'string') : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<DubPreset> {
    const preset = (await this.list()).find((p) => p.id === id);
    if (!preset) {
      throw new AppErrorException('INVALID_EDIT', `There is no preset "${id}".`, {
        remediation: 'GET /presets lists the saved presets (New project → Presets in the app).',
      });
    }
    return preset;
  }

  /** Create (no id) or replace a preset. Writes are serialized: two saves never lose one. */
  save(input: DubPresetInput, id?: string): Promise<DubPreset> {
    return this.serial(async () => {
      const all = await this.list();
      const now = new Date().toISOString();
      const existing = id ? all.find((p) => p.id === id) : undefined;
      if (id && !existing) await this.get(id); // throws the readable error
      const preset: DubPreset = {
        id: existing?.id ?? `preset_${randomBytes(5).toString('hex')}`,
        ...input,
        settings: input.settings ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = existing ? all.map((p) => (p.id === preset.id ? preset : p)) : [...all, preset];
      await writeJsonAtomic(this.file, { presets: next });
      return preset;
    });
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.list();
      await writeJsonAtomic(this.file, { presets: all.filter((p) => p.id !== id) });
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
