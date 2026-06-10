/**
 * Local LLM translation — the offline quality jump over Argos.
 *
 * Speaks the OpenAI chat dialect (which both Ollama and llama.cpp's
 * `llama-server` expose), so it reuses the same request shape as the cloud LLM
 * provider but needs NO API key. Two backends, chosen at construction:
 *   - `ollama`   — a user-run Ollama daemon (default http://127.0.0.1:11434/v1);
 *                  models pulled with `ollama pull translategemma:…`.
 *   - `llama-cpp` — a `llama-server` we start from an engine pack via the
 *                  EngineManager (base URL resolved on demand, model bundled).
 *
 * Two prompting modes:
 *   - `chat-json-batch` — general LLMs (Qwen/Gemma/Llama): a numbered batch
 *     returned as strict JSON (default; reuses the cloud provider's prompt).
 *   - `raw-segment`     — translation-specialized models (TranslateGemma,
 *     Seed-X): one source line per request, plain-text reply.
 */
import {
  AppErrorException,
  normalizeLanguageCode,
  type TranslationInput,
  type TranslationResult,
  type TranslationResultSegment,
} from '@videodubber/shared';
import type { CancellableTranslationProvider } from '../types.js';
import {
  buildRawTranslationPrompt,
  buildTranslationPrompt,
  parseTranslationReply,
} from './llmTranslationProvider.js';

/** Prompting strategy. */
export type LocalLlmMode = 'chat-json-batch' | 'raw-segment';

/** How the base URL is obtained (Ollama daemon vs managed llama-server). */
export type LocalLlmBackend = 'ollama' | 'llama-cpp';

const BATCH_SIZE = 20;

/** Minimal POST-JSON seam (overridable in tests). */
export type LocalPostJson = <T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) => Promise<T>;

async function defaultPostJson<T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new AppErrorException('ENGINE_UNAVAILABLE', `Local LLM returned HTTP ${res.status}.`, {
      cause: (await res.text().catch(() => '')).slice(0, 300),
      remediation: 'Ensure the local LLM (Ollama or the llama.cpp engine pack) is running and the model is pulled.',
    });
  }
  return (await res.json()) as T;
}

export interface LocalLlmOptions {
  /** Provider id in the registry (e.g. "ollama", "llama-cpp"). */
  id?: string;
  backend: LocalLlmBackend;
  /**
   * Prompting strategy. Defaults to `raw-segment`: one source line per request,
   * which guarantees a 1:1 segment mapping (ideal for dubbing) and works with
   * both translation-specialized models (TranslateGemma) and general LLMs,
   * avoiding strict-JSON compliance issues on smaller local models.
   */
  mode?: LocalLlmMode;
  /** Model name to request (e.g. "translategemma:12b", "qwen3:14b"). */
  model: string;
  /** Resolve the OpenAI-compatible base URL (may start an engine on demand). */
  resolveBaseUrl: () => Promise<string>;
  timeoutMs: number;
  postJson?: LocalPostJson;
}

export class LocalLlmTranslationProvider implements CancellableTranslationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal = true;
  /** Engine pack required to run (undefined for the user-run Ollama daemon). */
  readonly requiresEnginePack?: string;

  private readonly mode: LocalLlmMode;
  private readonly postJson: LocalPostJson;

  constructor(private readonly opts: LocalLlmOptions) {
    this.id = opts.id ?? 'local-llm';
    this.mode = opts.mode ?? 'raw-segment';
    this.postJson = opts.postJson ?? defaultPostJson;
    this.displayName = opts.backend === 'ollama' ? 'Ollama (local LLM)' : 'llama.cpp (local LLM)';
    if (opts.backend === 'llama-cpp') this.requiresEnginePack = 'llama-cpp';
  }

  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    const baseUrl = (await this.opts.resolveBaseUrl()).replace(/\/$/, '');
    const source = normalizeLanguageCode(input.sourceLanguage);
    const target = normalizeLanguageCode(input.targetLanguage);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    if (this.mode === 'raw-segment') {
      return this.translateRaw(baseUrl, source, target, input, combined);
    }
    return this.translateBatch(baseUrl, source, target, input, combined);
  }

  /** Chat-JSON-batch mode (general LLMs). */
  private async translateBatch(
    baseUrl: string,
    source: string,
    target: string,
    input: TranslationInput,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    const results: TranslationResultSegment[] = [];
    for (let i = 0; i < input.segments.length; i += BATCH_SIZE) {
      const batch = input.segments.slice(i, i + BATCH_SIZE);
      const prompt = buildTranslationPrompt(source, target, batch);
      const data = await this.postJson<{ choices?: { message?: { content?: string } }[] }>(
        `${baseUrl}/chat/completions`,
        {},
        {
          model: this.opts.model,
          messages: [
            { role: 'system', content: 'You are a professional subtitle/dubbing translator.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          stream: false,
        },
        signal,
      );
      const byId = parseTranslationReply(data.choices?.[0]?.message?.content ?? '');
      for (const seg of batch) {
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
    }
    return { segments: results };
  }

  /** Raw-per-segment mode (translation-specialized models). */
  private async translateRaw(
    baseUrl: string,
    source: string,
    target: string,
    input: TranslationInput,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    const results: TranslationResultSegment[] = [];
    for (const seg of input.segments) {
      const prompt = buildRawTranslationPrompt(source, target, seg);
      const data = await this.postJson<{ choices?: { message?: { content?: string } }[] }>(
        `${baseUrl}/chat/completions`,
        {},
        {
          model: this.opts.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          stream: false,
        },
        signal,
      );
      const text = (data.choices?.[0]?.message?.content ?? '').trim();
      results.push({ id: seg.id, translatedText: text || seg.sourceText });
    }
    return { segments: results };
  }
}
