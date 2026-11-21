import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  LEGACY_SETTINGS_ANCHORS,
  SETTINGS_OPTIONS,
  SETTINGS_SECTIONS,
  isSettingsSection,
  sectionForAnchor,
  type SettingsSectionId,
} from './settings-sections';
// Each section's component, as text (raw-source.d.ts).
import advancedTs from './sections/advanced-section.component.ts?raw';
import audioTs from './sections/audio-section.component.ts?raw';
import claudeTs from './sections/claude-section.component.ts?raw';
import cloudHtml from './sections/cloud-section.component.html?raw';
import cloudTs from './sections/cloud-section.component.ts?raw';
import diagnosticsTs from './sections/diagnostics-section.component.ts?raw';
import downloadsTs from './sections/downloads-section.component.ts?raw';
import dubbingTs from './sections/dubbing-section.component.ts?raw';
import enginesTs from './sections/engines-section.component.ts?raw';
import generalHtml from './sections/general-section.component.html?raw';
import generalTs from './sections/general-section.component.ts?raw';
import performanceTs from './sections/performance-section.component.ts?raw';
import storageTs from './sections/storage-section.component.ts?raw';
import sttHtml from './sections/stt-section.component.html?raw';
import sttTs from './sections/stt-section.component.ts?raw';
import translationTs from './sections/translation-section.component.ts?raw';
import ttsTs from './sections/tts-section.component.ts?raw';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

/** The section's component sources (template and class). */
const SOURCES: Record<SettingsSectionId, string> = {
  general: generalTs + generalHtml,
  dubbing: dubbingTs,
  engines: enginesTs,
  stt: sttTs + sttHtml,
  translation: translationTs,
  tts: ttsTs,
  audio: audioTs,
  cloud: cloudTs + cloudHtml,
  claude: claudeTs,
  downloads: downloadsTs,
  performance: performanceTs,
  storage: storageTs,
  diagnostics: diagnosticsTs,
  advanced: advancedTs,
};

function sectionSource(section: SettingsSectionId): string {
  return SOURCES[section];
}

describe('settings sections', () => {
  it('names every title, intro, option and explanation in both languages', () => {
    // These keys live in tables, where check-i18n's scan of `| translate`
    // cannot see them: a missing one would show as a raw key in the nav.
    const keys = [
      ...SETTINGS_SECTIONS.flatMap((s) => [s.titleKey, s.introKey]),
      ...SETTINGS_OPTIONS.flatMap((o) => [o.titleKey, ...(o.hintKey ? [o.hintKey] : [])]),
    ];
    for (const key of keys) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });

  it('puts every searchable option on its own page, once', () => {
    const anchors = SETTINGS_OPTIONS.map((o) => o.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const option of SETTINGS_OPTIONS) {
      // The search result jumps to this id: it must be on the section it names.
      expect(sectionSource(option.section), `${option.anchor} on ${option.section}`).toContain(`id="${option.anchor}"`);
    }
  });

  it('nests the engine pages under Engines & models, and only those', () => {
    const nested = SETTINGS_SECTIONS.filter((s) => s.parent).map((s) => s.id);
    expect(nested).toEqual(['stt', 'translation', 'tts', 'audio']);
    expect(SETTINGS_SECTIONS.every((s) => !s.parent || s.parent === 'engines')).toBe(true);
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    // Each engine page right after its parent, in the order the pipeline runs.
    expect(ids.slice(ids.indexOf('engines'), ids.indexOf('engines') + 5)).toEqual(['engines', 'stt', 'translation', 'tts', 'audio']);
  });

  it('sends the old single-page anchors to the section that holds them now', () => {
    expect(sectionForAnchor('brand-kit')).toBe('dubbing');
    expect(sectionForAnchor('downloads')).toBe('downloads');
    expect(sectionForAnchor('opt-concurrency')).toBe('performance');
    expect(sectionForAnchor('argos-packs')).toBe('translation');
    expect(sectionForAnchor(null)).toBe('general');
    expect(sectionForAnchor('no-such-anchor')).toBe('general');
    for (const [anchor, section] of Object.entries(LEGACY_SETTINGS_ANCHORS)) {
      expect(isSettingsSection(section), anchor).toBe(true);
      expect(sectionSource(section), `${anchor} on ${section}`).toContain(`id="${anchor}"`);
    }
  });

  it('recognises section ids', () => {
    expect(isSettingsSection('stt')).toBe(true);
    expect(isSettingsSection('engines')).toBe(true);
    expect(isSettingsSection('Engines')).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });
});
