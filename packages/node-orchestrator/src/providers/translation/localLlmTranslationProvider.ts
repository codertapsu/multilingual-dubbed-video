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

/** Default raw-segment concurrency (overridable via env or options). */
function localLlmConcurrencyDefault(): number {
  const raw = process.env.LOCAL_LLM_CONCURRENCY?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/** Map over items with bounded concurrency, preserving input order. */
async function mapWithConcurrency<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

/** Minimal POST-JSON seam (overridable in tests). */
export type LocalPostJson = <T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) => Promise<T>;

async function defaultPostJson<T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A THROWN fetch (connection refused / DNS / reset / abort) means the daemon
    // isn't reachable — surface that clearly instead of a raw "fetch failed"
    // (which the runner would otherwise map to UNKNOWN).
    if (signal?.aborted) {
      throw new AppErrorException('CANCELLED', 'Local LLM request was cancelled.');
    }
    throw new AppErrorException('ENGINE_UNAVAILABLE', `Local LLM is not reachable at ${url}.`, {
      cause: err instanceof Error ? err.message : String(err),
      remediation:
        'Start the local LLM — Ollama: run `ollama serve` and `ollama pull <model>` (set OLLAMA_MODEL to match), ' +
        'or enable the llama.cpp engine pack — OR switch the project\'s Translation provider to Argos (offline, no setup).',
    });
  }
  if (!res.ok) {
    throw new AppErrorException('ENGINE_UNAVAILABLE', `Local LLM returned HTTP ${res.status}.`, {
      cause: (await res.text().catch(() => '')).slice(0, 300),
      remediation: 'Ensure the local LLM (Ollama or the llama.cpp engine pack) is running and the model is pulled.',
    });
  }
  return (await res.json()) as T;
}

/** Gemma chat-turn control tokens (the format TranslateGemma was trained on). */
const GEMMA_END_TURN = '<end_of_turn>';

/**
 * Wrap an instruction in Gemma's chat turn so we can drive llama.cpp's
 * `/completion` endpoint directly. We bypass llama-server's OpenAI chat endpoint
 * on purpose: as of mid-2026 its Jinja parse of TranslateGemma's chat template is
 * broken (it echoes the source unchanged or aborts), so we render the turn
 * ourselves rather than trust the server's template.
 *
 * Verified against TranslateGemma's published `chat_template.jinja`: the user
 * content (already trimmed by {@link buildRawTranslationPrompt}) is followed
 * DIRECTLY by `<end_of_turn>` with NO separating newline, then `\n<start_of_turn>
 * model\n`. With the matching prompt body this is byte-identical to the official
 * template output.
 *
 * NOTE: this relies on the GGUF typing `<start_of_turn>`/`<end_of_turn>` as
 * CONTROL tokens so the server tokenizes each as a single id (and stops on the
 * `<end_of_turn>` EOG). Some Gemma-3 requants mis-type them as NORMAL (Unsloth
 * issue #5070), which would BPE-split the literals and degrade output — a
 * property of the downloaded weights, not the launch flags. If a model ever
 * produces garbled/non-stopping output, validate the requant via the server's
 * `/tokenize` endpoint and switch packs (see enginePackCatalog).
 */
function wrapGemmaTurn(content: string): string {
  return `<start_of_turn>user\n${content}${GEMMA_END_TURN}\n<start_of_turn>model\n`;
}

/** Strip any Gemma turn markers the model echoes back (belt-and-suspenders to the stop token). */
function stripTurnTokens(text: string): string {
  return text.replace(/<end_of_turn>/g, '').replace(/<start_of_turn>(?:model|user)?/g, '');
}

export interface LocalLlmOptions {
  /** Provider id in the registry (e.g. "ollama", "llama-cpp"). */
  id?: string;
  /** User-facing name (e.g. "TranslateGemma (built-in)"); defaults by backend. */
  displayName?: string;
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
  /**
   * Max segments translated concurrently in raw-segment mode. Modern local
   * servers (llama-server continuous batching, Ollama parallel slots) genuinely
   * parallelize these; a single-slot server just queues them harmlessly. This
   * keeps long videos from being translated strictly one segment at a time.
   * Default 4 (or the LOCAL_LLM_CONCURRENCY env var).
   */
  concurrency?: number;
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
  private readonly concurrency: number;

  constructor(private readonly opts: LocalLlmOptions) {
    this.id = opts.id ?? 'local-llm';
    this.mode = opts.mode ?? 'raw-segment';
    this.postJson = opts.postJson ?? defaultPostJson;
    this.concurrency = Math.max(1, opts.concurrency ?? localLlmConcurrencyDefault());
    this.displayName =
      opts.displayName ?? (opts.backend === 'ollama' ? 'Ollama (local LLM)' : 'llama.cpp (local LLM)');
    // Matches the runtime packs' providerId ('local-llm'), so the generic
    // pack-resolution/readiness paths find them. (The model GGUF is a second,
    // separate 'local-llm-model' pack, checked alongside in readiness.ts.)
    if (opts.backend === 'llama-cpp') this.requiresEnginePack = 'local-llm';
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

  /** Chat-JSON-batch mode (general LLMs via Ollama). */
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
      const reply = await this.complete('You are a professional subtitle/dubbing translator.', prompt, baseUrl, signal);
      const byId = parseTranslationReply(reply);
      for (const seg of batch) {
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
    }
    return { segments: results };
  }

  /** Raw-per-segment mode (translation-specialized models like TranslateGemma). */
  private async translateRaw(
    baseUrl: string,
    source: string,
    target: string,
    input: TranslationInput,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    // Bounded concurrency: still one request per segment (preserving the strict
    // 1:1 mapping dubbing needs), but overlapped so a long video isn't
    // translated strictly one segment at a time. Result order is preserved.
    const segments = await mapWithConcurrency(input.segments, this.concurrency, async (seg) => {
      const prompt = buildRawTranslationPrompt(source, target, seg);
      const reply = await this.complete(undefined, prompt, baseUrl, signal);
      const text = stripTurnTokens(reply).trim();
      return { id: seg.id, translatedText: text || seg.sourceText } satisfies TranslationResultSegment;
    });
    return { segments };
  }

  /**
   * Send one instruction and return the model's text, choosing the transport by
   * backend (greedy / temperature 0 for deterministic, faithful MT):
   *   - `ollama`    → POST `<baseUrl>/chat/completions` (Ollama applies the
   *     model's own baked-in template, so TranslateGemma's chat format works).
   *   - `llama-cpp` → POST `<baseUrl>/completion` with the prompt pre-wrapped in
   *     Gemma turn tokens, bypassing llama-server's broken TranslateGemma chat
   *     template (see {@link wrapGemmaTurn}).
   */
  private async complete(
    system: string | undefined,
    user: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.opts.backend === 'llama-cpp') {
      const prompt = wrapGemmaTurn(system ? `${system}\n\n${user}` : user);
      const data = await this.postJson<{ content?: string }>(
        `${baseUrl}/completion`,
        {},
        { prompt, temperature: 0, n_predict: 512, cache_prompt: true, stop: [GEMMA_END_TURN] },
        signal,
      );
      return data.content ?? '';
    }
    const messages = system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]
      : [{ role: 'user', content: user }];
    const data = await this.postJson<{ choices?: { message?: { content?: string } }[] }>(
      `${baseUrl}/chat/completions`,
      {},
      { model: this.opts.model, messages, temperature: 0, stream: false },
      signal,
    );
    return data.choices?.[0]?.message?.content ?? '';
  }
}
