/**
 * Translation provider backed by a local LibreTranslate server (an optional
 * engine pack). LibreTranslate's engine IS Argos Translate, so quality matches
 * the built-in {@link ArgosTranslationProvider}; this provider exists for users
 * who prefer running the LibreTranslate server (it reuses the same installed
 * Argos language packs via the shared default data dir).
 *
 * The pack's server is started on demand by the {@link EngineManager}; we then
 * call its REST `/translate` endpoint. LibreTranslate accepts an array for `q`
 * and returns the translations in the same order, so the whole batch goes in
 * one request. Languages are reduced to Argos base subtags (en/vi/zh); non-
 * English pairs pivot through English inside LibreTranslate, exactly like Argos.
 */
import {
  AppErrorException,
  toArgosLanguage,
  type TranslationInput,
  type TranslationResult,
} from '@videodubber/shared';
import { postWorkerJson } from '../workerHttp.js';
import type { CancellableTranslationProvider } from '../types.js';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { requireInstalledPack } from '../../engines/packSelection.js';

/** Raw shape of LibreTranslate's POST /translate ({ q } may be string or array). */
interface LibreTranslateResponse {
  translatedText: string | string[];
}

export class LibreTranslateProvider implements CancellableTranslationProvider {
  readonly id = 'libretranslate';
  readonly displayName = 'LibreTranslate (local server)';
  readonly isLocal = true;
  /** Gated on the optional LibreTranslate engine pack (provider id, not pack id). */
  readonly requiresEnginePack = 'libretranslate';

  constructor(
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  /** Resolve the running server's base URL (starts the pack server on demand). */
  private async baseUrl(): Promise<string> {
    const packId = await requireInstalledPack(this.store, 'libretranslate');
    // exclusive: a translation run doesn't need a heavy STT/TTS engine resident.
    return this.engines.ensureRunning(packId, { exclusive: true });
  }

  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    if (input.segments.length === 0) return { segments: [] };

    const base = (await this.baseUrl()).replace(/\/$/, '');
    const source = toArgosLanguage(input.sourceLanguage);
    const target = toArgosLanguage(input.targetLanguage);

    // One batched request: q as an array -> translatedText as an array (same order).
    let data: LibreTranslateResponse;
    try {
      data = await postWorkerJson<LibreTranslateResponse>(
        `${base}/translate`,
        {
          q: input.segments.map((s) => s.sourceText),
          source,
          target,
          format: 'text',
        },
        { timeoutMs: this.timeoutMs, workerName: 'LibreTranslate engine', signal },
      );
    } catch (err) {
      throw this.remapTranslateError(err, source, target);
    }

    const texts = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
    return {
      // Preserve ids/order; fall back to the source text if a slot is missing
      // (so a short/odd response never drops a segment).
      segments: input.segments.map((s, i) => ({ id: s.id, translatedText: texts[i] ?? s.sourceText })),
    };
  }

  /**
   * Turn LibreTranslate's "language pair not available" failure into an
   * actionable error. LibreTranslate returns HTTP 400 with a PLAIN-STRING body
   * `{ "error": "<msg>" }` (not our `{ error: { code, message } }` envelope), so
   * workerHttp can't decode it and surfaces a generic UNKNOWN / "HTTP 400" with
   * the raw body in `cause`. Re-throw it as TRANSLATION_PACKAGE_MISSING — the
   * same actionable code the Argos worker uses — since LibreTranslate reuses the
   * exact Argos packages, so the remedy (install the pair) is identical. Other
   * failures (timeout / unavailable / cancelled) pass through unchanged.
   */
  private remapTranslateError(err: unknown, source: string, target: string): unknown {
    if (!(err instanceof AppErrorException) || err.code !== 'UNKNOWN' || !/HTTP 400/.test(err.appError.message)) {
      return err;
    }
    const cause = typeof err.appError.cause === 'string' ? err.appError.cause : '';
    let reason = cause;
    try {
      const body = JSON.parse(cause) as { error?: unknown };
      if (typeof body.error === 'string') reason = body.error;
    } catch {
      /* keep the raw cause text */
    }
    return new AppErrorException(
      'TRANSLATION_PACKAGE_MISSING',
      `LibreTranslate can't translate ${source} → ${target}: ${reason || 'that language pair is not installed'}.`,
      {
        cause: cause || undefined,
        remediation:
          'Install the language pair in Settings → Translation packs (LibreTranslate uses the same Argos packs). ' +
          'A non-English pair needs BOTH legs — e.g. for zh → vi install zh → en and en → vi.',
      },
    );
  }
}
