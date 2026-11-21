import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { EnginePackInfo } from '../../core/models';
import {
  FAMILY_ORDER,
  SPEECH_MODELS,
  familiesForPage,
  familyOfProvider,
  groupEngineFamilies,
  packsOfFamily,
  variantLabelOf,
} from './engine-families';

type Tree = { [key: string]: string | Tree };
const text = (tree: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);

/** A catalog-shaped pack: only the fields the grouping reads matter. */
function pack(p: Partial<EnginePackInfo> & Pick<EnginePackInfo, 'id' | 'kind' | 'packKind' | 'providerId'>): EnginePackInfo {
  return { displayName: p.id, description: '', accel: 'cpu', artifacts: [], approxSizeMb: 100, ...p };
}

// The catalog's order and fields, abridged (engines/enginePackCatalog.ts).
const CATALOG: EnginePackInfo[] = [
  pack({ id: 'whisper-cpp-cuda', kind: 'stt', packKind: 'binary', providerId: 'whisper-cpp', family: 'whisper', variantLabel: 'whisper.cpp', accel: 'cuda' }),
  pack({ id: 'whisper-model-large-v3', kind: 'stt', packKind: 'model', providerId: 'whisper-cpp-model', family: 'whisper', variantLabel: 'large-v3' }),
  pack({ id: 'whisper-model-large-v3-turbo', kind: 'stt', packKind: 'model', providerId: 'whisper-cpp-model', family: 'whisper', variantLabel: 'large-v3-turbo' }),
  pack({ id: 'llama-cpp-cuda', kind: 'translation', packKind: 'binary', providerId: 'local-llm', family: 'llama-cpp', variantLabel: 'llama.cpp', accel: 'cuda' }),
  pack({ id: 'llama-cpp-vulkan', kind: 'translation', packKind: 'binary', providerId: 'local-llm', family: 'llama-cpp', variantLabel: 'llama.cpp', accel: 'vulkan' }),
  pack({ id: 'translategemma-4b', kind: 'translation', packKind: 'model', providerId: 'local-llm-model', family: 'translategemma', variantLabel: '4B' }),
  pack({ id: 'translategemma-12b', kind: 'translation', packKind: 'model', providerId: 'local-llm-model', family: 'translategemma', variantLabel: '12B' }),
  pack({ id: 'translategemma-27b', kind: 'translation', packKind: 'model', providerId: 'local-llm-model', family: 'translategemma', variantLabel: '27B' }),
  pack({ id: 'chat-gemma4-12b', kind: 'translation', packKind: 'model', providerId: 'local-llm-chat-model', family: 'gemma-chat', variantLabel: 'Gemma 4 12B' }),
  pack({ id: 'tts-neural-cuda', kind: 'tts', packKind: 'python-uv', providerId: 'neural-tts', family: 'vieneu', variantLabel: 'VieNeu Neural TTS v3', accel: 'cuda' }),
  pack({ id: 'tts-neural', kind: 'tts', packKind: 'python-uv', providerId: 'neural-tts', family: 'vieneu', variantLabel: 'VieNeu Neural TTS v3' }),
  pack({ id: 'tts-vieneu-cuda', kind: 'tts', packKind: 'python-uv', providerId: 'vieneu-tts', family: 'vieneu', variantLabel: 'VieNeu-TTS 3.8', accel: 'cuda' }),
  pack({ id: 'tts-vieneu', kind: 'tts', packKind: 'python-uv', providerId: 'vieneu-tts', family: 'vieneu', variantLabel: 'VieNeu-TTS 3.8' }),
  pack({ id: 'tts-zerotts', kind: 'tts', packKind: 'python-uv', providerId: 'zerotts', family: 'zerotts', variantLabel: 'ZeroTTS' }),
  pack({ id: 'diarization-sherpa', kind: 'diarization', packKind: 'python-uv', providerId: 'speaker-diarization', family: 'speaker-detection', variantLabel: 'sherpa-onnx' }),
  pack({ id: 'audiocpp-vulkan', kind: 'separation', packKind: 'binary', providerId: 'audio-cpp', family: 'separation', variantLabel: 'audio.cpp', accel: 'vulkan' }),
  pack({ id: 'separation-htdemucs', kind: 'separation', packKind: 'model', providerId: 'audio-cpp-separation-model', family: 'separation', variantLabel: 'HTDemucs' }),
  pack({ id: 'translation-libretranslate', kind: 'translation', packKind: 'python-uv', providerId: 'libretranslate', family: 'libretranslate', variantLabel: 'LibreTranslate' }),
];

describe('engine families', () => {
  const families = groupEngineFamilies(CATALOG);
  const byId = (id: string) => families.find((f) => f.id === id)!;

  it('puts whisper.cpp and the Whisper models it runs on one card', () => {
    const whisper = byId('whisper');
    expect(whisper.page).toBe('stt');
    expect(whisper.engines.map((e) => [e.label, e.packs.map((p) => p.id)])).toEqual([['whisper.cpp', ['whisper-cpp-cuda']]]);
    expect(whisper.models.map(variantLabelOf)).toEqual(['large-v3', 'large-v3-turbo']);
  });

  it('keeps the TranslateGemma sizes together, apart from the review models and their shared runtime', () => {
    expect(byId('translategemma').models.map(variantLabelOf)).toEqual(['4B', '12B', '27B']);
    expect(byId('translategemma').engines).toEqual([]);
    expect(byId('gemma-chat').models.map((m) => m.id)).toEqual(['chat-gemma4-12b']);
    // The runtime's builds are one engine with two builds.
    expect(byId('llama-cpp').engines.map((e) => e.packs.map((p) => p.accel))).toEqual([['cuda', 'vulkan']]);
  });

  it('lists VieNeu-TTS 3.8 before Neural TTS v3, each with its processor and NVIDIA builds', () => {
    const vieneu = byId('vieneu');
    expect(vieneu.engines.map((e) => e.label)).toEqual(['VieNeu-TTS 3.8', 'VieNeu Neural TTS v3']);
    expect(vieneu.engines.map((e) => e.packs.map((p) => p.id))).toEqual([
      ['tts-vieneu-cuda', 'tts-vieneu'],
      ['tts-neural-cuda', 'tts-neural'],
    ]);
    expect(packsOfFamily(vieneu)).toHaveLength(4);
  });

  it('orders the cards by family, and each page gets its own', () => {
    expect(familiesForPage(families, 'translation').map((f) => f.id)).toEqual([
      'translategemma',
      'gemma-chat',
      'llama-cpp',
      'libretranslate',
    ]);
    expect(familiesForPage(families, 'tts').map((f) => f.id)).toEqual(['vieneu', 'zerotts']);
    // Speaker detection and separation are the helpers page.
    expect(familiesForPage(families, 'audio').map((f) => f.id)).toEqual(['speaker-detection', 'separation']);
    expect(byId('separation').engines.map((e) => e.label)).toEqual(['audio.cpp']);
    expect(byId('separation').models.map(variantLabelOf)).toEqual(['HTDemucs']);
  });

  it('gives a pack without a family (an older or newer backend) a card of its own, after the known ones', () => {
    const odd = pack({ id: 'tts-new', kind: 'tts', packKind: 'python-uv', providerId: 'new-tts', displayName: 'New TTS (12 voices)' });
    const all = groupEngineFamilies([odd, ...CATALOG]);
    const tts = familiesForPage(all, 'tts');
    expect(tts.map((f) => f.id)).toEqual(['vieneu', 'zerotts', 'pack:tts-new']);
    expect(tts[2]!.known).toBe(false);
    expect(tts[2]!.engines[0]!.label).toBe('New TTS (12 voices)');
    // A family Settings has no words for is still a card, not lost.
    const unknown = groupEngineFamilies([{ ...odd, family: 'future' as EnginePackInfo['family'] }]);
    expect(unknown.map((f) => [f.id, f.known])).toEqual([['future', false]]);
  });

  it('has a title and an explanation for every known family, and a name for every build, in both languages', () => {
    // Built from the data at runtime, so check-i18n's scan cannot see them.
    const accels: EnginePackInfo['accel'][] = ['cpu', 'metal', 'coreml', 'cuda', 'vulkan', 'mps'];
    const keys = [
      ...FAMILY_ORDER.flatMap((id) => [`settings.families.${id}.title`, `settings.families.${id}.desc`]),
      ...accels.map((a) => `settings.accel.${a}`),
    ];
    for (const key of keys) {
      expect(typeof text(en, key), `en ${key}`).toBe('string');
      expect(typeof text(vi, key), `vi ${key}`).toBe('string');
    }
  });

  it('names every speech model the way the translator looks keys up (split on dots)', () => {
    // `whisper.distil-large-v3.5` exists in both files and still showed as a raw
    // key: the lookup splits on every dot. `text` resolves the same way.
    for (const model of SPEECH_MODELS) {
      expect(typeof text(en, model.label), `en ${model.label}`).toBe('string');
      expect(typeof text(vi, model.label), `vi ${model.label}`).toBe('string');
    }
    expect(SPEECH_MODELS.filter((m) => m.phoWhisper).map((m) => m.id)).toEqual(['phowhisper-medium', 'phowhisper-large']);
  });

  it('finds the card of each provider that needs a download, and none for built-in or cloud ones', () => {
    expect(familyOfProvider({ id: 'whisper-cpp', requiresEnginePack: 'whisper-cpp' }, families)).toEqual({
      familyId: 'whisper',
      providerId: 'whisper-cpp',
    });
    expect(familyOfProvider({ id: 'vieneu-tts', requiresEnginePack: 'vieneu-tts' }, families)).toEqual({
      familyId: 'vieneu',
      providerId: 'vieneu-tts',
    });
    // TranslateGemma and the Gemma chat modes share the llama.cpp runtime.
    expect(familyOfProvider({ id: 'llama-cpp', requiresEnginePack: 'local-llm' }, families)).toEqual({ familyId: 'translategemma' });
    expect(familyOfProvider({ id: 'argos-llm-repair', requiresEnginePack: 'local-llm' }, families)).toEqual({ familyId: 'gemma-chat' });
    expect(familyOfProvider({ id: 'faster-whisper' }, families)).toBeNull();
    expect(familyOfProvider({ id: 'openai-tts' }, families)).toBeNull();
  });
});
