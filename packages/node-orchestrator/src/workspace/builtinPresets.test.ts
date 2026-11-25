import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProjectSettings } from '@videodubber/shared';

import { baseProjectSettings } from '../projectDefaults.js';
import { BUILTIN_PRESET_KEYS, builtinPresets, localProviderDefaults, type BuiltinPresetFacts } from './builtinPresets.js';

const AT = '2026-11-25T00:00:00.000Z';

/** What New project recommends on a machine with TranslateGemma, the Gemma chat model and VieNeu. */
const recommended = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
  ...baseProjectSettings('zh', 'vi-VN'),
  sttProviderId: 'whisper-cpp',
  sttModel: 'medium',
  translationProviderId: 'llama-cpp',
  refineProviderId: 'llama-cpp-chat',
  ttsProviderId: 'vieneu-tts',
  autoSelectedPhases: ['stt', 'translation', 'tts'],
  ...over,
});

const facts = (over: Partial<BuiltinPresetFacts> = {}): BuiltinPresetFacts => ({
  local: recommended(),
  replacedCloud: [],
  speakerDetection: true,
  ...over,
});

const byKind = (list: ReturnType<typeof builtinPresets>) => Object.fromEntries(list.map((p) => [p.builtin!.kind, p]));

describe('the built-in presets', () => {
  it('are Highest quality, Balanced and Lowest cost, with ids an agent can name', () => {
    const list = builtinPresets(facts(), AT);
    expect(list.map((p) => [p.id, p.name])).toEqual([
      ['builtin:quality', 'Highest quality'],
      ['builtin:balanced', 'Balanced'],
      ['builtin:economy', 'Lowest cost'],
    ]);
    expect(list.every((p) => p.targetLanguage === 'vi-VN' && p.sourceLanguage === 'zh')).toBe(true);
  });

  it('name every engine, on this computer only, and set nothing about subtitles, voices or looks', () => {
    for (const p of builtinPresets(facts(), AT)) {
      expect(p.settings).toMatchObject({ processingMode: 'local', sttProviderId: 'whisper-cpp', translationProviderId: 'llama-cpp', ttsProviderId: 'vieneu-tts' });
      // A refine pass is always named: a cloud review saved elsewhere cannot show through.
      expect(p.settings.refineProviderId).toMatch(/^(llama-cpp-chat|none)$/);
      expect(Object.keys(p.settings).every((k) => (BUILTIN_PRESET_KEYS as readonly string[]).includes(k))).toBe(true);
      expect(p.builtin!.tradeoffs.at(-1)!.text).toBe('Everything runs on this computer: no cloud AI is used, and nothing is sent anywhere.');
    }
  });

  it('Highest quality: the largest speech model, the review, auto-fit, speakers and the best picture', () => {
    const { quality } = byKind(builtinPresets(facts(), AT));
    expect(quality!.settings).toMatchObject({ sttModel: 'large-v3', refineProviderId: 'llama-cpp-chat', autoFitOverflow: true, diarize: true, renderQuality: 'quality' });
    expect(quality!.builtin!.tradeoffs.map((t) => t.key)).toEqual([
      'wizard.builtin.quality-stt',
      'wizard.builtin.quality-review',
      'wizard.builtin.quality-fit',
      'wizard.builtin.quality-speakers',
      'wizard.builtin.quality-render',
      'wizard.builtin.local',
    ]);
    // A language's own model is kept; what is missing here is said, not hidden.
    const plain = byKind(
      builtinPresets(facts({ local: recommended({ sttModel: 'phowhisper-medium', refineProviderId: undefined, translationProviderId: 'argos' }), speakerDetection: false }), AT),
    );
    expect(plain.quality!.settings).toMatchObject({ sttModel: 'phowhisper-medium', refineProviderId: 'none', diarize: true });
    expect(plain.quality!.builtin!.tradeoffs.map((t) => t.key)).toEqual([
      'wizard.builtin.quality-stt-special',
      'wizard.builtin.quality-review-missing',
      'wizard.builtin.quality-speakers-missing',
      'wizard.builtin.quality-render',
      'wizard.builtin.local',
    ]);
  });

  it('Balanced is what New project picks; Lowest cost does the least work', () => {
    const { balanced, economy } = byKind(builtinPresets(facts({ local: recommended({ sttModel: 'large-v3' }) }), AT));
    expect(balanced!.settings).toMatchObject({ sttModel: 'large-v3', refineProviderId: 'llama-cpp-chat', autoFitOverflow: true, renderQuality: 'auto' });
    expect(balanced!.settings).not.toHaveProperty('diarize');
    expect(economy!.settings).toMatchObject({ sttModel: 'large-v3-turbo', refineProviderId: 'none', autoFitOverflow: false, diarize: false, renderQuality: 'fast' });
    expect(economy!.builtin!.tradeoffs.find((t) => t.key === 'wizard.builtin.economy-text')).toMatchObject({ params: { ratio: 1.6 } });
  });

  it('say which saved cloud choice they leave to the user', () => {
    const { balanced } = byKind(builtinPresets(facts({ replacedCloud: [{ phase: 'translation', name: 'Anthropic (Claude) translation (cloud)' }] }), AT));
    expect(balanced!.builtin!.tradeoffs.at(-1)).toEqual({
      key: 'wizard.builtin.kept-local',
      params: { name: 'Anthropic (Claude) translation (cloud)', phaseKey: 'wizard.builtin.phase-translation' },
      text: 'Your Settings choose Anthropic (Claude) translation (cloud) for translation; built-in presets stay on this computer. Choose it in the form to use it.',
    });
  });

  it('are worked out without the cloud engines saved as defaults', () => {
    const isLocal = (_phase: string, id: string) => !id.includes('cloud') && !id.endsWith('-translate');
    expect(localProviderDefaults({ sttProviderId: 'openai-stt-cloud', translationProviderId: 'anthropic-translate', ttsProviderId: 'vieneu-tts', sttModel: 'large-v3' }, isLocal)).toEqual({
      ttsProviderId: 'vieneu-tts',
      sttModel: 'large-v3',
    });
    expect(localProviderDefaults(undefined, isLocal)).toEqual({});
  });
});

describe('their words in the app', () => {
  const i18n = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/desktop/src/i18n');
  const lookup = (tree: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
  const keys = new Set<string>();
  for (const f of [facts(), facts({ local: recommended({ sttModel: 'large-v3', translationProviderId: 'argos', refineProviderId: undefined }), speakerDetection: false })]) {
    for (const p of builtinPresets({ ...f, replacedCloud: [{ phase: 'stt', name: 'X' }] }, AT)) {
      keys.add(`wizard.builtin.name-${p.builtin!.kind}`);
      for (const t of p.builtin!.tradeoffs) {
        keys.add(t.key);
        if (typeof t.params?.['phaseKey'] === 'string') keys.add(t.params['phaseKey']);
      }
    }
  }
  for (const phase of ['stt', 'translation', 'tts']) keys.add(`wizard.builtin.phase-${phase}`);
  keys.add('wizard.builtin.quality-stt-kept');
  keys.add('wizard.builtin.quality-stt-special');

  for (const locale of ['en', 'vi']) {
    it(`are all in ${locale}.json`, () => {
      const bundle = JSON.parse(fs.readFileSync(path.join(i18n, `${locale}.json`), 'utf8')) as unknown;
      expect([...keys].filter((k) => typeof lookup(bundle, k) !== 'string')).toEqual([]);
    });
  }
});
