/**
 * The voice library's filters and order, as pure functions.
 *
 * The screen loads the whole library once (a few hundred rows) and filters as
 * the user types, so search feels instant. The orchestrator applies the same
 * rules to GET /voices (voices/voiceLibrary.ts) for the MCP tools; MIRRORS it:
 * change one, change both. Vietnamese is the app's first audience, so for a
 * Vietnamese dub the dedicated Vietnamese engines come first.
 */
import type { VoiceEngineId, VoiceLibraryItem, VoiceLicenseCategory } from '../../core/models';

export interface VoiceFilterState {
  /** Base language subtag ("vi"), or '' for every language. */
  language: string;
  engine: VoiceEngineId | '';
  gender: 'female' | 'male' | '';
  accent: 'north' | 'central' | 'south' | '';
  license: VoiceLicenseCategory | '';
  installedOnly: boolean;
  favoritesOnly: boolean;
  query: string;
}

export const EMPTY_FILTER: VoiceFilterState = {
  language: '',
  engine: '',
  gender: '',
  accent: '',
  license: '',
  installedOnly: false,
  favoritesOnly: false,
  query: '',
};

/** "vi-VN" / "vi_VN" / "vi" -> "vi". */
export function baseLanguage(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase();
}

/** Fold case and Vietnamese diacritics, so "hai dang" finds "Hải Đăng". */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

export function speaks(item: Pick<VoiceLibraryItem, 'languages'>, language: string): boolean {
  if (!language) return true;
  const base = baseLanguage(language);
  return item.languages.some((l) => l === '*' || baseLanguage(l) === base);
}

export function matchesFilter(item: VoiceLibraryItem, f: VoiceFilterState): boolean {
  if (!speaks(item, f.language)) return false;
  if (f.engine && item.engine !== f.engine) return false;
  if (f.gender && item.gender !== f.gender) return false;
  if (f.accent && item.accent !== f.accent) return false;
  if (f.license && item.license.category !== f.license) return false;
  if (f.installedOnly && !item.installed) return false;
  if (f.favoritesOnly && !item.favorite) return false;
  const q = foldText(f.query.trim());
  if (q) {
    const hay = foldText(
      [item.name, item.id, ...(item.tags ?? []), item.license.label, ...(item.speakers ?? []).map((s) => s.name)].join(' '),
    );
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

/** Engine order for a dub into `language` (Vietnamese engines first for vi). */
export function engineRank(engine: VoiceEngineId, language: string): number {
  const vi = baseLanguage(language) === 'vi';
  const order: VoiceEngineId[] = vi
    ? ['vieneu', 'vieneu-classic', 'zerotts', 'voxcpm', 'piper', 'supertonic', 'openai', 'kokoro']
    : ['kokoro', 'voxcpm', 'supertonic', 'piper', 'openai', 'vieneu', 'vieneu-classic', 'zerotts'];
  const at = order.indexOf(engine);
  return at < 0 ? order.length : at;
}

const QUALITY: Record<string, number> = { high: 0, medium: 1, low: 2, x_low: 3 };

export function compareVoices(a: VoiceLibraryItem, b: VoiceLibraryItem, language: string): number {
  const flag = (x: boolean | undefined) => (x ? 0 : 1);
  return (
    flag(a.kind === 'profile') - flag(b.kind === 'profile') ||
    flag(a.favorite) - flag(b.favorite) ||
    flag(a.recommended) - flag(b.recommended) ||
    flag(a.installed) - flag(b.installed) ||
    engineRank(a.engine, language) - engineRank(b.engine, language) ||
    (QUALITY[a.quality ?? 'medium'] ?? 1) - (QUALITY[b.quality ?? 'medium'] ?? 1) ||
    a.name.localeCompare(b.name, 'vi') ||
    a.id.localeCompare(b.id)
  );
}

export function filterVoices(items: readonly VoiceLibraryItem[], f: VoiceFilterState): VoiceLibraryItem[] {
  return items.filter((i) => matchesFilter(i, f)).sort((a, b) => compareVoices(a, b, f.language));
}

/** Base languages present in the library, most voices first, the UI language's own first of all. */
export function languageOptions(items: readonly VoiceLibraryItem[], first = 'vi'): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    for (const l of new Set(i.languages.filter((x) => x !== '*').map(baseLanguage))) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (a.code === first ? -1 : b.code === first ? 1 : b.count - a.count || a.code.localeCompare(b.code)));
}

/** The badge colour of a licence category (styles.scss .badge-*). */
export function licenseTone(category: VoiceLicenseCategory): 'completed' | 'info' | 'warning' | 'failed' | 'skipped' {
  switch (category) {
    case 'permissive':
      return 'completed';
    case 'attribution':
    case 'service-terms':
      return 'info';
    case 'use-restricted':
      return 'warning';
    case 'non-commercial':
      return 'failed';
    default:
      return 'skipped';
  }
}

/**
 * A picker label: the name, then what tells voices apart ("Thục Đoan — Nữ ·
 * Miền Nam · Kể chuyện"). A cloned voice says so, and one made from the
 * project's video says that ("Người nói 1 — Từ video này"): next to fifty
 * preset names, a user's own voice is otherwise easy to miss. `t` translates
 * `voices.*` keys.
 */
export function describeVoice(item: VoiceLibraryItem, t: (key: string) => string): string {
  const parts = [
    item.kind === 'profile' ? t(item.scope?.kind === 'project' ? 'voices.label-from-video' : 'voices.label-cloned') : '',
    item.gender ? t(`voices.${item.gender}`) : '',
    item.accent ? t(`voices.accent-${item.accent}`) : '',
    ...(item.tags ?? [])
      .filter((tag) => !tag.startsWith('grade:') && tag !== 'featured')
      .map((tag) => {
        const key = `voices.tag.${tag}`;
        const label = t(key);
        return label === key ? tag : label;
      }),
  ].filter(Boolean);
  return parts.length ? `${item.name} — ${parts.join(' · ')}` : item.name;
}

/** "#3" of a Piper speaker id, as a voice id. */
export function speakerVoiceId(modelId: string, speaker: number): string {
  return `${modelId}#${speaker}`;
}
