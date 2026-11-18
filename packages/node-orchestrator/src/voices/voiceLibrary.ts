/**
 * The voice library: the catalog merged with this computer's state (what is
 * installed, which engines can run, the user's favourites and voice profiles),
 * then filtered and ordered. Pure: every input is passed in, so the route and
 * the MCP tool share it and tests need no disk.
 */
import type {
  VoiceEngineId,
  VoiceEngineInfo,
  VoiceEntry,
  VoiceLibraryItem,
  VoiceLicenseCategory,
  VoiceProfile,
} from '@videodubber/shared';
import { splitSpeakerVoiceId } from '@videodubber/shared';
import { baseLanguage, voiceSpeaks } from './voiceCatalog.js';

/** This computer's state, as the library needs it. */
export interface VoiceLibraryState {
  /** Piper model ids with their files on disk. */
  installedPiper: ReadonlySet<string>;
  /** Engine packs installed and usable. */
  installedPacks: ReadonlySet<string>;
  /** Engine packs offered on this platform. */
  availablePacks: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  /** Cloud services with a key ("openai"). */
  cloudServices: ReadonlySet<string>;
  profiles?: readonly VoiceProfile[];
}

function engineInstalled(engine: VoiceEngineInfo | undefined, state: VoiceLibraryState): boolean {
  if (!engine) return false;
  if (engine.id === 'piper') return true;
  if (engine.id === 'openai') return state.cloudServices.has('openai');
  return engine.packIds.some((p) => state.installedPacks.has(p));
}

function engineAvailable(engine: VoiceEngineInfo | undefined, state: VoiceLibraryState): boolean {
  if (!engine) return false;
  if (engine.packIds.length === 0) return true;
  return engine.packIds.some((p) => state.availablePacks.has(p) || state.installedPacks.has(p));
}

/** Library rows for every preset and profile. */
export function libraryItems(
  catalog: readonly VoiceEntry[],
  engines: readonly VoiceEngineInfo[],
  state: VoiceLibraryState,
): VoiceLibraryItem[] {
  const engineById = new Map(engines.map((e) => [e.id, e]));
  const items: VoiceLibraryItem[] = catalog.map((v) => {
    const engine = engineById.get(v.engine);
    const engineOk = engineInstalled(engine, state);
    const installed = v.engine === 'piper' ? state.installedPiper.has(v.id) : engineOk;
    return {
      kind: 'preset',
      id: v.id,
      engine: v.engine,
      name: v.name,
      languages: v.languages,
      ...(v.gender ? { gender: v.gender } : {}),
      ...(v.accent ? { accent: v.accent } : {}),
      ...(v.tags?.length ? { tags: v.tags } : {}),
      ...(v.quality ? { quality: v.quality } : {}),
      ...(v.speakers?.length ? { speakers: v.speakers } : {}),
      license: v.license,
      sizeMb: v.sizeMb,
      hasPreview: Boolean(v.preview) || (installed && v.engine !== 'openai'),
      ...(v.preview ? { sample: true } : {}),
      ...(v.recommended ? { recommended: true } : {}),
      ...(v.replacedBy ? { replacedBy: v.replacedBy } : {}),
      installed,
      engineInstalled: engineOk,
      engineAvailable: engineAvailable(engine, state),
      favorite: state.favorites.has(v.id),
    };
  });
  for (const p of state.profiles ?? []) {
    const engine = engineById.get(p.engine);
    const engineOk = engineInstalled(engine, state);
    items.push({
      kind: 'profile',
      id: p.id,
      engine: p.engine,
      name: p.name,
      // A cloned voice speaks whatever its engine speaks.
      languages: engine?.languages ?? [],
      license: { category: 'permissive', label: 'own' },
      sizeMb: 0,
      hasPreview: true,
      installed: engineOk,
      engineInstalled: engineOk,
      engineAvailable: engineAvailable(engine, state),
      favorite: state.favorites.has(p.id),
      scope: p.scope,
    });
  }
  return items;
}

/** Filters of GET /voices (all optional, combined with AND). */
export interface VoiceQuery {
  language?: string;
  engine?: VoiceEngineId | VoiceEngineId[];
  gender?: 'female' | 'male';
  accent?: 'north' | 'central' | 'south';
  license?: VoiceLicenseCategory | VoiceLicenseCategory[];
  installed?: boolean;
  favorite?: boolean;
  kind?: 'preset' | 'profile';
  /** Profiles of other projects are hidden unless this names the project. */
  projectId?: string;
  /** Free text: name, id, tags, licence, speaker names. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** Fold case and Vietnamese diacritics, so "hai dang" finds "Hải Đăng". */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

const asList = <T>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** True when an item passes every filter. */
export function matchesVoiceQuery(item: VoiceLibraryItem, query: VoiceQuery): boolean {
  if (query.language && !voiceSpeaks(item, query.language)) return false;
  const engines = asList(query.engine);
  if (engines?.length && !engines.includes(item.engine)) return false;
  if (query.gender && item.gender !== query.gender) return false;
  if (query.accent && item.accent !== query.accent) return false;
  const licenses = asList(query.license);
  if (licenses?.length && !licenses.includes(item.license.category)) return false;
  if (query.installed !== undefined && item.installed !== query.installed) return false;
  if (query.favorite !== undefined && item.favorite !== query.favorite) return false;
  if (query.kind && item.kind !== query.kind) return false;
  if (item.scope?.kind === 'project' && item.scope.projectId !== query.projectId) return false;
  const q = foldText(query.q?.trim() ?? '');
  if (q) {
    const hay = foldText(
      [item.name, item.id, ...(item.tags ?? []), item.license.label, ...(item.speakers ?? []).map((s) => s.name)].join(' '),
    );
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

/**
 * Engines in the order a dub into `language` should offer them: for
 * Vietnamese the dedicated Vietnamese engines first (the app's priority),
 * elsewhere the multilingual neural engines before Piper.
 */
export function engineRank(engine: VoiceEngineId, language: string | undefined): number {
  const vi = language ? baseLanguage(language) === 'vi' : false;
  const order: VoiceEngineId[] = vi
    ? ['vieneu', 'vieneu-classic', 'zerotts', 'voxcpm', 'piper', 'supertonic', 'openai', 'kokoro']
    : ['kokoro', 'voxcpm', 'supertonic', 'piper', 'openai', 'vieneu', 'vieneu-classic', 'zerotts'];
  const at = order.indexOf(engine);
  return at < 0 ? order.length : at;
}

const QUALITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, x_low: 3 };

/**
 * Library order: the user's own voices and favourites, then recommended
 * voices, installed before not installed, by engine priority for the
 * language, by quality, by name.
 */
export function compareVoices(a: VoiceLibraryItem, b: VoiceLibraryItem, language?: string): number {
  const flag = (x: boolean | undefined) => (x ? 0 : 1);
  return (
    flag(a.kind === 'profile') - flag(b.kind === 'profile') ||
    flag(a.favorite) - flag(b.favorite) ||
    flag(a.recommended) - flag(b.recommended) ||
    flag(a.installed) - flag(b.installed) ||
    engineRank(a.engine, language) - engineRank(b.engine, language) ||
    (QUALITY_RANK[a.quality ?? 'medium'] ?? 1) - (QUALITY_RANK[b.quality ?? 'medium'] ?? 1) ||
    a.name.localeCompare(b.name, 'vi') ||
    a.id.localeCompare(b.id)
  );
}

/** Filter, order and page. */
export function queryVoices(
  items: readonly VoiceLibraryItem[],
  query: VoiceQuery,
): { voices: VoiceLibraryItem[]; total: number } {
  const hits = items.filter((i) => matchesVoiceQuery(i, query)).sort((a, b) => compareVoices(a, b, query.language));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = query.limit === undefined ? hits.length : Math.max(0, Math.floor(query.limit));
  return { voices: hits.slice(offset, offset + limit), total: hits.length };
}

/** The Piper model id of a voice id (strips a "#speaker"). */
export function piperModelOf(voiceId: string): string {
  return splitSpeakerVoiceId(voiceId).modelId;
}
