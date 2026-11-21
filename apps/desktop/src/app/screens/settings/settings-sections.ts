/**
 * The sections of Settings: their order in the navigation, their titles, and
 * the options each one holds for the search box.
 *
 * Settings was one page of thirteen cards in no particular order (the computer,
 * engine defaults, API keys, Claude, a flat list of twenty-odd engine packs,
 * translation packs, language, projects folder, downloads, logo & greeting,
 * storage, updates, about). The field report of 2026-11-21 asked for logical
 * categories, screens where needed and the engines grouped by family; this is
 * the map. Every option the page had is in exactly one section here.
 *
 * Pure (no Angular): the router's redirect and the specs use it too. Titles and
 * explanations are TRANSLATION KEYS.
 */

export type SettingsSectionId =
  | 'general'
  | 'dubbing'
  | 'engines'
  | 'stt'
  | 'translation'
  | 'tts'
  | 'audio'
  | 'cloud'
  | 'claude'
  | 'downloads'
  | 'performance'
  | 'storage'
  | 'diagnostics'
  | 'advanced';

export interface SettingsSectionDef {
  id: SettingsSectionId;
  /** Navigation label and page title (a translation key). */
  titleKey: string;
  /** The one line under the title saying what the page is for (a translation key). */
  introKey: string;
  /** Shown indented under this section in the navigation (the engine pages under Engines & models). */
  parent?: SettingsSectionId;
  /**
   * The page has defaults the app knows, so it offers "Reset to defaults". The
   * pages without one hold things that have no default (API keys, the brand
   * kit, presets, stored files) or only actions.
   */
  resettable?: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'general', titleKey: 'settings.sections.general.title', introKey: 'settings.sections.general.intro', resettable: true },
  { id: 'dubbing', titleKey: 'settings.sections.dubbing.title', introKey: 'settings.sections.dubbing.intro' },
  { id: 'engines', titleKey: 'settings.sections.engines.title', introKey: 'settings.sections.engines.intro' },
  { id: 'stt', titleKey: 'settings.sections.stt.title', introKey: 'settings.sections.stt.intro', parent: 'engines', resettable: true },
  {
    id: 'translation',
    titleKey: 'settings.sections.translation.title',
    introKey: 'settings.sections.translation.intro',
    parent: 'engines',
    resettable: true,
  },
  { id: 'tts', titleKey: 'settings.sections.tts.title', introKey: 'settings.sections.tts.intro', parent: 'engines', resettable: true },
  { id: 'audio', titleKey: 'settings.sections.audio.title', introKey: 'settings.sections.audio.intro', parent: 'engines' },
  { id: 'cloud', titleKey: 'settings.sections.cloud.title', introKey: 'settings.sections.cloud.intro' },
  { id: 'claude', titleKey: 'settings.sections.claude.title', introKey: 'settings.sections.claude.intro' },
  { id: 'downloads', titleKey: 'settings.sections.downloads.title', introKey: 'settings.sections.downloads.intro', resettable: true },
  { id: 'performance', titleKey: 'settings.sections.performance.title', introKey: 'settings.sections.performance.intro', resettable: true },
  { id: 'storage', titleKey: 'settings.sections.storage.title', introKey: 'settings.sections.storage.intro' },
  { id: 'diagnostics', titleKey: 'settings.sections.diagnostics.title', introKey: 'settings.sections.diagnostics.intro' },
  { id: 'advanced', titleKey: 'settings.sections.advanced.title', introKey: 'settings.sections.advanced.intro' },
];

/** Where /settings opens. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));

export function isSettingsSection(id: string | null | undefined): id is SettingsSectionId {
  return typeof id === 'string' && SECTION_IDS.has(id);
}

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  return SETTINGS_SECTIONS.find((s) => s.id === id)!;
}

/**
 * The anchors of the old single page, and the section that holds each now.
 * Links into Settings were written as `/settings#brand-kit` (the branding form)
 * and `/settings#downloads`; the router sends them to their section with the
 * anchor kept, so a link nobody updated still lands on the right option.
 */
export const LEGACY_SETTINGS_ANCHORS: Readonly<Record<string, SettingsSectionId>> = {
  downloads: 'downloads',
  'brand-kit': 'dubbing',
  diagnostics: 'diagnostics',
};

/** The section a bare `/settings#anchor` opens: the one holding the anchor, else General. */
export function sectionForAnchor(anchor: string | null | undefined): SettingsSectionId {
  if (!anchor) return DEFAULT_SETTINGS_SECTION;
  const legacy = LEGACY_SETTINGS_ANCHORS[anchor];
  if (legacy) return legacy;
  return SETTINGS_OPTIONS.find((o) => o.anchor === anchor)?.section ?? DEFAULT_SETTINGS_SECTION;
}

/**
 * One option (or block of options) the search box can find. `anchor` is the
 * DOM id of the option on its page: the search result jumps there, and so can
 * any link (`/settings/<section>#<anchor>`). A spec checks that every anchor is
 * really on its page.
 */
export interface SettingsOptionDef {
  anchor: string;
  section: SettingsSectionId;
  titleKey: string;
  /** The option's one-line explanation, searched too. */
  hintKey?: string;
  /**
   * Words people search with that the title and explanation may lack, in both
   * languages and without accents ("gpu card nvidia vga"). Searched, never shown.
   */
  keywords?: string;
}

export const SETTINGS_OPTIONS: readonly SettingsOptionDef[] = [
  // ---- General
  {
    anchor: 'opt-language',
    section: 'general',
    titleKey: 'settings.language.label',
    hintKey: 'settings.language.hint',
    keywords: 'language ngon ngu tieng viet english vietnamese',
  },
  {
    anchor: 'opt-theme',
    section: 'general',
    titleKey: 'settings.general.theme',
    hintKey: 'settings.general.theme-hint',
    keywords: 'dark light mode toi sang giao dien theme',
  },
  {
    anchor: 'projects-folder',
    section: 'general',
    titleKey: 'settings.projects-folder.heading',
    hintKey: 'settings.projects-folder.intro',
    keywords: 'folder thu muc luu save location drive o dia move chuyen',
  },
  {
    anchor: 'opt-auto-update',
    section: 'general',
    titleKey: 'settings.updates.auto-title',
    hintKey: 'settings.updates.auto-hint',
    keywords: 'update cap nhat version phien ban',
  },
  {
    anchor: 'updates',
    section: 'general',
    titleKey: 'settings.updates.check',
    hintKey: 'settings.general.updates-hint',
    keywords: 'update cap nhat version phien ban release',
  },
  { anchor: 'about', section: 'general', titleKey: 'settings.about.heading', hintKey: 'settings.about.body' },

  // ---- Dubbing defaults
  {
    anchor: 'presets',
    section: 'dubbing',
    titleKey: 'settings.dubbing.presets',
    hintKey: 'settings.dubbing.presets-hint',
    keywords: 'preset template mau subtitle phu de language ngon ngu default mac dinh',
  },
  {
    anchor: 'brand-kit',
    section: 'dubbing',
    titleKey: 'settings.brand-kit-heading',
    hintKey: 'settings.brand-kit-intro',
    keywords: 'logo greeting loi chao brand thuong hieu watermark intro',
  },
  {
    anchor: 'series',
    section: 'dubbing',
    titleKey: 'settings.dubbing.series',
    hintKey: 'settings.dubbing.series-hint',
    keywords: 'series parts phan tap long video ai cut cat',
  },

  // ---- Engines & models
  {
    anchor: 'engine-defaults',
    section: 'engines',
    titleKey: 'settings.overview.defaults',
    hintKey: 'settings.overview.defaults-hint',
    keywords: 'default mac dinh new project du an moi automatic tu dong',
  },
  {
    anchor: 'engine-recommended',
    section: 'engines',
    titleKey: 'engines.rec.heading',
    hintKey: 'engines.rec.intro',
    keywords: 'recommended khuyen nghi gpu nvidia install cai dat',
  },
  {
    anchor: 'opt-stt-default',
    section: 'stt',
    titleKey: 'settings.fn.stt-engine',
    hintKey: 'settings.fn.stt-engine-hint',
    keywords: 'whisper transcribe transcription subtitle phien am default mac dinh',
  },
  {
    anchor: 'opt-stt-model',
    section: 'stt',
    titleKey: 'settings.fn.stt-model',
    hintKey: 'settings.fn.stt-model-hint',
    keywords: 'whisper model large turbo phowhisper accuracy chinh xac',
  },
  {
    anchor: 'opt-translation-default',
    section: 'translation',
    titleKey: 'settings.fn.translation-engine',
    hintKey: 'settings.fn.translation-engine-hint',
    keywords: 'translate dich default mac dinh ai',
  },
  {
    anchor: 'argos-packs',
    section: 'translation',
    titleKey: 'settings.argos.heading',
    hintKey: 'settings.argos.intro',
    keywords: 'argos language pack goi ngon ngu offline',
  },
  {
    anchor: 'opt-tts-default',
    section: 'tts',
    titleKey: 'settings.fn.tts-engine',
    hintKey: 'settings.fn.tts-engine-hint',
    keywords: 'voice giong doc tts speech default mac dinh',
  },

  // ---- Cloud services & keys
  {
    anchor: 'key-openai',
    section: 'cloud',
    titleKey: 'settings.cloud.openai',
    hintKey: 'svc.openai-hint',
    keywords: 'openai chatgpt gpt api key khoa',
  },
  {
    anchor: 'key-anthropic',
    section: 'cloud',
    titleKey: 'settings.cloud.anthropic',
    hintKey: 'svc.anthropic-hint',
    keywords: 'claude anthropic mother claude api key khoa plan goi',
  },
  {
    anchor: 'opt-claude-model',
    section: 'cloud',
    titleKey: 'settings.keys.claude-model',
    hintKey: 'settings.keys.claude-model-hint',
    keywords: 'claude opus sonnet haiku model',
  },
  {
    anchor: 'key-gemini',
    section: 'cloud',
    titleKey: 'settings.cloud.gemini',
    hintKey: 'svc.gemini-hint',
    keywords: 'gemini google api key khoa',
  },

  // ---- Claude
  {
    anchor: 'claude-connections',
    section: 'claude',
    titleKey: 'settings.claude.heading',
    hintKey: 'settings.claude.intro',
    keywords: 'claude desktop claude code mcp assistant tro ly connect ket noi',
  },

  // ---- Downloads
  {
    anchor: 'downloads',
    section: 'downloads',
    titleKey: 'settings.downloads.while-dubbing',
    hintKey: 'settings.downloads.intro',
    keywords: 'download tai video bilibili youtube douyin parallel song song',
  },
  {
    anchor: 'download-logins',
    section: 'downloads',
    titleKey: 'settings.downloads.logins',
    hintKey: 'settings.downloads.login-hint',
    keywords: 'login dang nhap cookie account tai khoan quality chat luong',
  },

  // ---- Performance
  {
    anchor: 'this-computer',
    section: 'performance',
    titleKey: 'settings.computer.heading',
    hintKey: 'settings.performance.computer-hint',
    keywords: 'hardware phan cung cpu ram gpu vram card nvidia',
  },
  {
    anchor: 'opt-concurrency',
    section: 'performance',
    titleKey: 'settings.computer.concurrent',
    hintKey: 'settings.performance.concurrent-hint',
    keywords: 'parallel cung luc simultaneous queue hang doi speed toc do',
  },
  {
    anchor: 'opt-pause-queue',
    section: 'performance',
    titleKey: 'settings.computer.pause-queue',
    hintKey: 'settings.performance.pause-hint',
    keywords: 'queue hang doi pause tam dung stop dung',
  },

  // ---- Storage
  {
    anchor: 'storage',
    section: 'storage',
    titleKey: 'settings.storage.heading',
    hintKey: 'settings.storage.intro',
    keywords: 'disk o dia space dung luong delete xoa free giai phong cache',
  },
  {
    anchor: 'downloaded-videos',
    section: 'storage',
    titleKey: 'settings.storage.downloads',
    hintKey: 'settings.storage.downloads-hint',
    keywords: 'download video da tai delete xoa',
  },

  // ---- Diagnostics
  {
    anchor: 'diagnostics',
    section: 'diagnostics',
    titleKey: 'diagnostics.heading',
    hintKey: 'diagnostics.intro',
    keywords: 'log nhat ky crash loi error bug support bundle health suc khoe',
  },

  // ---- Advanced
  {
    anchor: 'python-engines',
    section: 'advanced',
    titleKey: 'settings.advanced.uv',
    hintKey: 'settings.advanced.uv-hint',
    keywords: 'uv python runtime',
  },
  {
    anchor: 'reset-all',
    section: 'advanced',
    titleKey: 'settings.advanced.reset-all',
    hintKey: 'settings.advanced.reset-all-hint',
    keywords: 'reset default mac dinh khoi phuc',
  },
];
