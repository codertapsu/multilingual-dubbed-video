/**
 * The FULL Piper voice catalog (every voice for any language), so users can pick
 * any voice for their target language and have it downloaded on demand — beyond
 * the small curated default set in {@link ./catalog.ts}.
 *
 * It's a bundled snapshot of rhasspy/piper-voices' `voices.json` (the same index
 * the canonical/OHF-Voice "piper1-gpl" tooling uses), trimmed to the fields we
 * need and committed so the picker works instantly + offline. Refresh it by
 * re-running the jq generator over
 * https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json.
 *
 * Per the catalog's own contract, download URLs are DERIVED from each voice's
 * file paths (not assembled from a hardcoded `<family>/<code>/<name>/<quality>`
 * assumption), which is authoritative.
 */
import type { PiperVoiceInfo } from '@videodubber/shared';
import snapshotRaw from './piper-voices-snapshot.json' with { type: 'json' };

/** Base for raw file downloads from the rhasspy/piper-voices repo. */
const PIPER_VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** One trimmed snapshot entry (see the jq generator in the header). */
interface SnapshotEntry {
  name: string;
  code: string;
  family: string;
  region: string;
  nativeName: string;
  englishName: string;
  quality: string;
  speakers: number;
  onnx: string;
  config: string;
  sizeMb: number;
}

const SNAPSHOT = snapshotRaw as unknown as Record<string, SnapshotEntry>;

const QUALITY_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, x_low: 1 };

/** Base subtag of a language tag: "vi-VN" / "vi_VN" / "vi" -> "vi". */
function baseSubtag(language: string): string {
  return (language.split(/[-_]/)[0] ?? '').toLowerCase();
}

function entryToVoiceInfo(id: string, e: SnapshotEntry): PiperVoiceInfo {
  const speakers = e.speakers > 1 ? ` · ${e.speakers} speakers` : '';
  return {
    id,
    language: e.code.replace('_', '-'),
    label: `${e.englishName} — ${e.name} (${e.quality})${speakers}`,
    approxSizeMb: e.sizeMb,
    url: `${PIPER_VOICES_BASE}/${e.onnx}`,
    configUrl: `${PIPER_VOICES_BASE}/${e.config}`,
    quality: e.quality as PiperVoiceInfo['quality'],
    numSpeakers: e.speakers,
    languageCode: e.code,
  };
}

/** Resolve any Piper voice id from the full catalog (used to legitimize lazy ids). */
export function resolvePiperVoice(voiceId: string): PiperVoiceInfo | undefined {
  const e = SNAPSHOT[voiceId];
  return e ? entryToVoiceInfo(voiceId, e) : undefined;
}

/**
 * Every Piper voice for a target language (matched on the base subtag), sorted
 * best-first: higher quality, then single-speaker, then id. Empty if Piper has
 * no voice for the language (the worker then uses system/fallback TTS).
 */
export function listVoicesForLanguage(language: string): PiperVoiceInfo[] {
  const base = baseSubtag(language);
  if (!base) return [];
  return Object.entries(SNAPSHOT)
    .filter(([, e]) => e.family.toLowerCase() === base)
    .map(([id, e]) => entryToVoiceInfo(id, e))
    .sort(
      (a, b) =>
        (QUALITY_RANK[b.quality ?? ''] ?? 0) - (QUALITY_RANK[a.quality ?? ''] ?? 0) ||
        (a.numSpeakers ?? 1) - (b.numSpeakers ?? 1) ||
        a.id.localeCompare(b.id),
    );
}

/** Catalog size (for diagnostics/tests). */
export function voiceCatalogStats(): { voices: number; languages: number } {
  return { voices: Object.keys(SNAPSHOT).length, languages: new Set(Object.values(SNAPSHOT).map((e) => e.family)).size };
}
