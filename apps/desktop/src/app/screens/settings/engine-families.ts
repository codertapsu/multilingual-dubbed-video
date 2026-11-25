/**
 * Engine packs grouped into the families Settings → Engines & models shows:
 * one card per model line, its engines (each with its builds: processor, NVIDIA,
 * Vulkan, Metal) and its models.
 *
 * The grouping comes from the catalog's own `family` and `variantLabel` fields
 * (engines/enginePackCatalog.ts), never from the shape of an id, so a pack the
 * catalog adds later lands on its family's card by itself. What stays here is
 * presentation only: the order of the cards, which engine of a family to list
 * first, and on which page a pack's job belongs.
 *
 * Pure (no Angular), for the specs.
 */
import type { EnginePackInfo } from '../../core/models';

type EngineKind = EnginePackInfo['kind'];

/** The four engine pages of Settings. */
export type EnginePageId = 'stt' | 'translation' | 'tts' | 'audio';

/** The builds of one engine inside a family (VieNeu-TTS 3.8 on the processor, on an NVIDIA card). */
export interface EngineBuildGroup {
  /** The catalog provider id the builds share ("vieneu-tts"). */
  providerId: string;
  /** Its short name, the same in every language ("VieNeu-TTS 3.8"). */
  label: string;
  /** The builds, in catalog order (best accelerator first). */
  packs: EnginePackInfo[];
}

/** One card on an engine page. */
export interface EngineFamilyView {
  /** The catalog family ("whisper"), or `pack:<id>` for a pack that names none. */
  id: string;
  page: EnginePageId;
  /** True when Settings has a title and a description for it (the families listed below). */
  known: boolean;
  /** Runtime packs (binaries, Python environments), grouped by engine. */
  engines: EngineBuildGroup[];
  /** Weights-only packs the engines run (the Whisper sizes, the TranslateGemma sizes…). */
  models: EnginePackInfo[];
}

/**
 * The cards in page order. A family first in this list is the one most people
 * want: Whisper for speech, TranslateGemma before the Gemma review models, the
 * llama.cpp runtime they share after both, VieNeu first among the voices (the
 * app is Vietnamese-first) and OmniVoice last (held back from releases).
 */
export const FAMILY_ORDER: readonly string[] = [
  'whisper',
  'subtitle-reading',
  'translategemma',
  'gemma-chat',
  'llama-cpp',
  'libretranslate',
  'vieneu',
  'zerotts',
  'kokoro',
  'supertonic',
  'omnivoice',
  'speaker-detection',
  'separation',
  'alignment',
];

/**
 * Engines to list first inside a family. VieNeu-TTS 3.8 (25 voices and voice
 * cloning) is the newer engine; the catalog lists the v3 packs first only
 * because projects made before 3.8 use their ten voices.
 */
const ENGINE_ORDER: Readonly<Record<string, readonly string[]>> = {
  vieneu: ['vieneu-tts', 'neural-tts', 'neural-tts-v2'],
};

/**
 * Model families that run on another family's engine: the TranslateGemma and
 * Gemma models are weights for the llama.cpp runtime, which installs with the
 * first of them. Their cards say so and point at the runtime's card.
 */
export const FAMILY_RUNTIME: Readonly<Record<string, string>> = {
  translategemma: 'llama-cpp',
  'gemma-chat': 'llama-cpp',
};

/**
 * Translation providers that share one runtime (llama.cpp, `requiresEnginePack:
 * 'local-llm'`) but are different model lines: which card each one is.
 * Every other pack-backed provider is found by its engine pack.
 */
const PROVIDER_FAMILY: Readonly<Record<string, string>> = {
  'llama-cpp': 'translategemma',
  'llama-cpp-chat': 'gemma-chat',
  'argos-llm-repair': 'gemma-chat',
};

/** The page a pack's job belongs on. */
export function pageForKind(kind: EngineKind): EnginePageId {
  switch (kind) {
    // The video's own subtitles read as its transcript (ocr) go on speech-to-text's page.
    case 'stt':
    case 'ocr':
      return 'stt';
    case 'translation':
      return 'translation';
    case 'tts':
      return 'tts';
    default:
      // Speaker detection, music & voice separation, alignment: the helpers.
      return 'audio';
  }
}

/** A pack's short name on its card; the full name when the catalog gives none (an older backend). */
export function variantLabelOf(pack: EnginePackInfo): string {
  return pack.variantLabel?.trim() || pack.displayName;
}

/**
 * The packs as family cards, in page order: known families in FAMILY_ORDER,
 * then any other, each in the order its first pack appears in the catalog.
 * Inside a card the engines keep catalog order (except ENGINE_ORDER), their
 * builds too, and the models.
 */
export function groupEngineFamilies(packs: readonly EnginePackInfo[]): EngineFamilyView[] {
  const byId = new Map<string, EngineFamilyView>();
  const firstSeen: string[] = [];
  for (const pack of packs) {
    const id = pack.family?.trim() || `pack:${pack.id}`;
    let family = byId.get(id);
    if (!family) {
      family = { id, page: pageForKind(pack.kind), known: FAMILY_ORDER.includes(id), engines: [], models: [] };
      byId.set(id, family);
      firstSeen.push(id);
    }
    if (pack.packKind === 'model') {
      family.models.push(pack);
      continue;
    }
    let engine = family.engines.find((e) => e.providerId === pack.providerId);
    if (!engine) {
      engine = { providerId: pack.providerId, label: variantLabelOf(pack), packs: [] };
      family.engines.push(engine);
    }
    engine.packs.push(pack);
  }
  for (const family of byId.values()) {
    const order = ENGINE_ORDER[family.id];
    if (!order) continue;
    const rank = (providerId: string): number => {
      const i = order.indexOf(providerId);
      return i < 0 ? order.length : i;
    };
    family.engines.sort((a, b) => rank(a.providerId) - rank(b.providerId));
  }
  const rank = (id: string): number => {
    const i = FAMILY_ORDER.indexOf(id);
    return i < 0 ? FAMILY_ORDER.length + firstSeen.indexOf(id) : i;
  };
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

/** The family cards of one page. */
export function familiesForPage(families: readonly EngineFamilyView[], page: EnginePageId): EngineFamilyView[] {
  return families.filter((f) => f.page === page);
}

/** Every pack on a card, engines' builds first, then the models. */
export function packsOfFamily(family: EngineFamilyView): EnginePackInfo[] {
  return [...family.engines.flatMap((e) => e.packs), ...family.models];
}

/**
 * Where a provider (a choice in "Default for new projects") is on the cards:
 * its family, and the engine inside it when the family has several. Null for
 * providers that need no download: the built-in engines (faster-whisper,
 * Argos, Piper), the cloud services and Ollama.
 */
export function familyOfProvider(
  provider: { id: string; requiresEnginePack?: string },
  families: readonly EngineFamilyView[],
): { familyId: string; providerId?: string } | null {
  const named = PROVIDER_FAMILY[provider.id];
  if (named) return { familyId: named };
  const pack = provider.requiresEnginePack;
  if (!pack) return null;
  for (const family of families) {
    if (family.engines.some((e) => e.providerId === pack)) return { familyId: family.id, providerId: pack };
    if (family.models.some((m) => m.providerId === pack)) return { familyId: family.id };
  }
  return null;
}

/**
 * The Whisper models the speech-model picker offers, run by the built-in
 * faster-whisper. `label` is a TRANSLATION KEY. PhoWhisper is Whisper trained
 * further on Vietnamese (VinAI); the Whisper card shows it as its own variant.
 */
export const SPEECH_MODELS: readonly { id: string; label: string; phoWhisper?: boolean }[] = [
  { id: 'tiny', label: 'whisper.tiny' },
  { id: 'base', label: 'whisper.base' },
  { id: 'small', label: 'whisper.small' },
  { id: 'large-v3-turbo', label: 'whisper.large-v3-turbo' },
  // Not 'whisper.distil-large-v3.5': the translator splits keys on dots, so a
  // leaf named with one never resolves (the old picker showed the raw key).
  { id: 'distil-large-v3.5', label: 'settings.builtin.model-distil' },
  { id: 'medium', label: 'whisper.medium' },
  { id: 'large-v3', label: 'whisper.large-v3' },
  { id: 'phowhisper-medium', label: 'whisper.phowhisper-medium', phoWhisper: true },
  { id: 'phowhisper-large', label: 'whisper.phowhisper-large', phoWhisper: true },
];
