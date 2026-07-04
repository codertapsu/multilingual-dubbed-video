/**
 * THE SINGLE SOURCE OF TRUTH for the language pairs whose models are BUNDLED into
 * the installer — staged at build time by scripts/package/fetch-default-models.sh
 * and seed-copied into the writable model dirs on first launch by sidecar.rs, so
 * a first dub for one of these pairs works fully offline, out of the box.
 *
 * To add, remove, or change a bundled default pair, edit {@link DEFAULT_PAIRS}
 * below and rebuild — usually the ONLY change required. (A new TARGET language
 * must already have a curated recommended Piper voice in `PIPER_VOICES` and be
 * Argos-reachable from English in `ARGOS_AVAILABLE`, both in catalog.ts; if not,
 * add those first — the build fails loudly otherwise.) The staging script derives
 * everything else from this list (via the print-default-bundle.ts bridge): the
 * STT model, the English-pivot Argos translation legs, and the recommended Piper
 * voice per target language. The runtime (Rust seed-copy, translation worker,
 * required-resources) is already pair-agnostic, so nothing there needs to change
 * when this list does.
 */
import { argosPivotLegs } from '@videodubber/shared';
import { recommendedPiperVoice } from './catalog.js';

export interface DefaultPair {
  /** Source (spoken) language. The base subtag is enough, e.g. 'en', 'zh'. */
  readonly source: string;
  /** Target (dub) language, e.g. 'vi-VN'. */
  readonly target: string;
}

/**
 * The STT model bundled for every pair. faster-whisper 'small' is multilingual,
 * so the one model serves any source language (en, zh, …). Higher-accuracy models
 * (large-v3-turbo, …) stay an optional Settings download.
 */
export const DEFAULT_WHISPER_MODEL = 'small';

// ─── EDIT HERE: one entry per bundled default language pair ──────────────────
export const DEFAULT_PAIRS: readonly DefaultPair[] = [
  { source: 'en', target: 'vi-VN' },
  { source: 'zh', target: 'vi-VN' },
];
// ─────────────────────────────────────────────────────────────────────────────

/** An Argos single-direction translation package to stage (base subtags). */
export interface ArgosLeg {
  readonly from: string;
  readonly to: string;
}

/** A Piper voice to stage (download URLs come straight from the catalog). */
export interface PiperVoicePlan {
  readonly id: string;
  readonly url: string;
  readonly configUrl: string;
}

/** The complete build-time staging plan derived from {@link DEFAULT_PAIRS}. */
export interface DefaultBundlePlan {
  /** Deduped STT models to stage (today just the shared default). */
  readonly whisperModels: string[];
  /** Deduped Argos packages — the English-pivot legs across all pairs. */
  readonly argosLegs: ArgosLeg[];
  /** Deduped Piper voices — the recommended voice for each target language. */
  readonly piperVoices: PiperVoicePlan[];
}

/**
 * Derive the full staging plan from a list of default pairs:
 *
 *   - whisperModels — the shared STT model, deduped (today `['small']`).
 *   - argosLegs — `argosPivotLegs(source, target)` for each pair, deduped. Argos
 *     publishes only to/from English, so a non-English pair like zh→vi expands to
 *     `[zh→en, en→vi]`; the en→vi leg shared with the en→vi pair is emitted ONCE.
 *     This uses the SAME helper requiredResources.ts uses at runtime, so the
 *     staged legs exactly match what a project's resource check expects.
 *   - piperVoices — the recommended voice for each distinct target language,
 *     deduped (both default pairs target vi → one vi voice).
 *
 * Throws if a declared target has no curated recommended Piper voice, so a
 * misconfigured pair fails the BUILD loudly instead of silently shipping a pair
 * with no TTS voice.
 */
export function computeDefaultBundlePlan(
  pairs: readonly DefaultPair[] = DEFAULT_PAIRS,
): DefaultBundlePlan {
  const whisperModels = new Set<string>();
  const argosLegs = new Map<string, ArgosLeg>();
  const piperVoices = new Map<string, PiperVoicePlan>();

  for (const pair of pairs) {
    whisperModels.add(DEFAULT_WHISPER_MODEL);

    for (const leg of argosPivotLegs(pair.source, pair.target)) {
      argosLegs.set(`${leg.from}_${leg.to}`, { from: leg.from, to: leg.to });
    }

    const voice = recommendedPiperVoice(pair.target);
    if (!voice) {
      throw new Error(
        `No curated recommended Piper voice for default pair target "${pair.target}". ` +
          `Add a recommended voice for it to PIPER_VOICES in catalog.ts, or remove the ` +
          `pair from DEFAULT_PAIRS in defaultBundle.ts.`,
      );
    }
    piperVoices.set(voice.id, { id: voice.id, url: voice.url, configUrl: voice.configUrl });
  }

  return {
    whisperModels: [...whisperModels],
    argosLegs: [...argosLegs.values()],
    piperVoices: [...piperVoices.values()],
  };
}

/**
 * Apply the legacy single-model whisper override (the `DEFAULT_WHISPER_MODEL`
 * build env var) to a plan, returning a NEW plan. An empty/whitespace override is
 * ignored (the plan's own model wins). Lets a build pin a different STT model
 * without editing defaultBundle.ts, preserving the pre-refactor env behavior.
 */
export function withWhisperOverride(
  plan: DefaultBundlePlan,
  override: string | undefined,
): DefaultBundlePlan {
  const model = override?.trim();
  return model ? { ...plan, whisperModels: [model] } : plan;
}

/**
 * Serialize a staging plan for a consumer:
 *   - 'json' — pretty JSON (for inspection / debugging).
 *   - 'sh'   — tab-separated records the POSIX staging scripts read line-by-line:
 *               `whisper <model>` / `argos <from> <to>` / `piper <id> <onnxUrl> <onnxJsonUrl>`.
 *
 * The 'sh' field order IS the contract the shell parsers (`IFS=$'\t' read …`)
 * depend on, so it is covered by unit tests alongside this module.
 */
export function formatBundlePlan(plan: DefaultBundlePlan, format: 'json' | 'sh'): string {
  if (format === 'sh') {
    const lines: string[] = [];
    for (const m of plan.whisperModels) lines.push(`whisper\t${m}`);
    for (const leg of plan.argosLegs) lines.push(`argos\t${leg.from}\t${leg.to}`);
    for (const v of plan.piperVoices) lines.push(`piper\t${v.id}\t${v.url}\t${v.configUrl}`);
    return `${lines.join('\n')}\n`;
  }
  return `${JSON.stringify(plan, null, 2)}\n`;
}
