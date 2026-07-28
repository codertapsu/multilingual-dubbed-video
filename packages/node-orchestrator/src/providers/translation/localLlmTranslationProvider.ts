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
  recoverBatch,
  sanitizeTranslatedLine,
  type PromptSegment,
} from './llmTranslationProvider.js';
import {
  buildAnalysisPrompt,
  buildAnalysisSample,
  buildContextHeader,
  collectRollingPairs,
  isSceneBreak,
  MIN_SEGMENTS_FOR_ANALYSIS,
  parseAnalysisReply,
  planContextBatches,
  translationContextEnabled,
  type RollingPair,
  type TranslationAnalysis,
} from './translationContext.js';

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
        "Switch this project's Translation provider to Argos (offline, nothing to install), or install " +
        'TranslateGemma (built-in) from Settings → Engines. (Advanced: run your own Ollama with `ollama serve` + `ollama pull <model>`.)',
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

/**
 * Chat-turn grammar the resolved GGUF was trained on. Gemma 1–3 (and
 * TranslateGemma) use `<start_of_turn>`/`<end_of_turn>`; Gemma 4 replaced them
 * with `<|turn>`/`<turn|>` plus thought channels. Which one applies is a
 * property of the MODEL PACK the engine loaded, so llama-cpp resolvers report
 * it per call via {@link LocalLlmEndpoint} (default: 'gemma').
 */
export type LocalLlmPromptFormat = 'gemma' | 'gemma4';

/** A resolved llama-server endpoint plus the prompt grammar its model expects. */
export interface LocalLlmEndpoint {
  baseUrl: string;
  promptFormat?: LocalLlmPromptFormat;
}

/** Gemma chat-turn control tokens (the format TranslateGemma was trained on). */
const GEMMA_END_TURN = '<end_of_turn>';

/** Gemma 4 end-of-turn control token (also the generation stop). */
const GEMMA4_END_TURN = '<turn|>';

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

/**
 * Wrap a system+user exchange in Gemma 4's chat grammar. Verified byte-identical
 * to Google's canonical `chat_template.jinja` (google/gemma-4-12B-it, published
 * 2026-07-09, fetched 2026-07-28) rendered with `enable_thinking=false` — its
 * default, and what we want: the template then PRE-CLOSES the thought channel
 * (`<|channel>thought\n<channel|>`) in the generation prompt, so the model
 * answers directly instead of spending hundreds of tokens reasoning before
 * every deterministic MT/refine batch. Content is trimmed exactly as the
 * template's `| trim` does; with no system message the system turn is omitted
 * entirely (the template only emits one for tools/thinking/system input). BOS
 * is added by llama-server's tokenizer, same as {@link wrapGemmaTurn}.
 */
function wrapGemma4Turn(system: string | undefined, user: string): string {
  const systemTurn = system ? `<|turn>system\n${system.trim()}${GEMMA4_END_TURN}\n` : '';
  return `${systemTurn}<|turn>user\n${user.trim()}${GEMMA4_END_TURN}\n<|turn>model\n<|channel>thought\n<channel|>`;
}

/**
 * Remove Gemma 4 channel/turn markers from a reply. Mirrors the canonical
 * template's `strip_thinking` macro: everything from a `<|channel>` opener up
 * to its closing `<channel|>` (or end of text, if the reply was cut off
 * mid-thought) is dropped, keeping only final-answer content. Applied to every
 * gemma4 completion — including JSON batch replies, which would otherwise
 * reach the parser with a stray thought block if the model re-opens a channel
 * despite the pre-closed one in the prompt.
 */
function stripGemma4Markers(text: string): string {
  let result = '';
  for (const part of text.split('<channel|>')) {
    const opener = part.indexOf('<|channel>');
    result += opener >= 0 ? part.slice(0, opener) : part;
  }
  return result.replace(/<turn\|>/g, '').replace(/<\|turn>(?:system|user|model)?/g, '');
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
  /**
   * Resolve the OpenAI-compatible base URL (may start an engine on demand).
   * llama-cpp resolvers whose model pack can vary (the chat packs span Gemma 3
   * AND Gemma 4) return a {@link LocalLlmEndpoint} so the prompt grammar
   * follows the pack that actually loaded; a bare string means 'gemma'.
   */
  resolveBaseUrl: () => Promise<string | LocalLlmEndpoint>;
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
  /** Chat-batch instances follow instructions + context → can run refine. */
  readonly supportsRefinement: boolean;

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
    // Raw-segment instances (TranslateGemma) can't take instructions/context.
    this.supportsRefinement = this.mode === 'chat-json-batch';
  }

  /**
   * Resolve the endpoint plus the prompt grammar its loaded model expects.
   * Resolved per JOB (and per chatComplete call), not per construction — the
   * chat resolver picks the best INSTALLED pack each time, so the format must
   * ride along with the URL it came from.
   */
  private async resolveEndpoint(): Promise<{ baseUrl: string; format: LocalLlmPromptFormat }> {
    const resolved = await this.opts.resolveBaseUrl();
    const endpoint: LocalLlmEndpoint = typeof resolved === 'string' ? { baseUrl: resolved } : resolved;
    return { baseUrl: endpoint.baseUrl.replace(/\/$/, ''), format: endpoint.promptFormat ?? 'gemma' };
  }

  /**
   * One-shot chat completion against the resolved local server. Public so the
   * context-repair provider can drive the same engine (analysis + repair
   * passes) without duplicating transport/turn-wrapping logic.
   */
  async chatComplete(system: string | undefined, user: string, signal?: AbortSignal): Promise<string> {
    const endpoint = await this.resolveEndpoint();
    return this.complete(system, user, endpoint, signal);
  }

  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    const endpoint = await this.resolveEndpoint();
    const source = normalizeLanguageCode(input.sourceLanguage);
    const target = normalizeLanguageCode(input.targetLanguage);

    // NOTE: timeoutMs is applied PER REQUEST inside complete(), not across the
    // whole job — a long video is many requests (and the recovery ladder adds
    // more), so a job-wide budget would abort exactly the runs that need the
    // extra calls. Cancellation still propagates instantly via `signal`.
    if (this.mode === 'raw-segment') {
      return this.translateRaw(endpoint, source, target, input, signal);
    }
    return this.translateBatch(endpoint, source, target, input, signal);
  }

  /** Chat-JSON-batch mode (general LLMs via Ollama). */
  private async translateBatch(
    endpoint: { baseUrl: string; format: LocalLlmPromptFormat },
    source: string,
    target: string,
    input: TranslationInput,
    signal: AbortSignal | undefined,
  ): Promise<TranslationResult> {
    // Document-level context (same design as the cloud provider): a provided
    // character sheet (persisted / user-edited) is authoritative; otherwise one
    // analysis pass builds it and it is returned for persistence. Scene-aware
    // batches then carry a rolling window of translated pairs. Best-effort — a
    // failed analysis never fails the translation.
    const provided = input.documentContext;
    const useContext =
      translationContextEnabled() && (provided !== undefined || input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS);
    let analysis: TranslationAnalysis | undefined = provided;
    let generated: TranslationAnalysis | undefined;
    if (useContext && analysis === undefined) {
      generated = await this.complete(
        'You prepare structured notes for dubbing translators. Respond with strict JSON only.',
        buildAnalysisPrompt(source, target, buildAnalysisSample(input.segments)),
        endpoint,
        signal,
      )
        .then(parseAnalysisReply)
        .catch(() => undefined);
      analysis = generated;
    }

    const batches = planContextBatches(input.segments, { maxSegments: BATCH_SIZE, maxChars: 6000 });
    const results: TranslationResultSegment[] = [];
    const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];
    const system = 'You are a professional subtitle/dubbing translator.';
    let previousBatch: PromptSegment[] | undefined;
    let rolling: RollingPair[] = [];
    for (const batch of batches) {
      const context = useContext
        ? buildContextHeader({ analysis, previousPairs: rolling, sceneBreak: isSceneBreak(previousBatch, batch) })
        : undefined;
      const prompt = buildTranslationPrompt(source, target, batch, context || undefined);
      const reply = await this.complete(system, prompt, endpoint, signal);

      // Small local models routinely violate the batch contract (truncated /
      // malformed JSON, skipped lines, source echoes) — recover with one
      // emphatic batch retry, then per-line RAW prompts (a bare instruction
      // with a plain-text reply: no JSON left to get wrong).
      const byId = await recoverBatch(batch, parseTranslationReply(reply), {
        sendBatch: (segs, insist) =>
          this.complete(system, buildTranslationPrompt(source, target, segs, context || undefined, { insist }), endpoint, signal),
        // Per-line raw prompts return one bare line — a small reply budget
        // keeps the (up to 20) fallback calls fast.
        sendSingle: async (seg) =>
          stripTurnTokens(
            await this.complete(undefined, buildRawTranslationPrompt(source, target, seg), endpoint, signal, 512),
          ),
      }, detectSourceEcho, signal);
      for (const seg of batch) {
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
      rolling = collectRollingPairs(batch, byId);
      previousBatch = batch;
    }
    return { segments: results, ...(generated ? { analysis: generated } : {}) };
  }

  /** Raw-per-segment mode (translation-specialized models like TranslateGemma). */
  private async translateRaw(
    endpoint: { baseUrl: string; format: LocalLlmPromptFormat },
    source: string,
    target: string,
    input: TranslationInput,
    signal: AbortSignal | undefined,
  ): Promise<TranslationResult> {
    // Bounded concurrency: still one request per segment (preserving the strict
    // 1:1 mapping dubbing needs), but overlapped so a long video isn't
    // translated strictly one segment at a time. Result order is preserved.
    const segments = await mapWithConcurrency(input.segments, this.concurrency, async (seg) => {
      const prompt = buildRawTranslationPrompt(source, target, seg);
      const reply = await this.complete(undefined, prompt, endpoint, signal);
      const text = sanitizeTranslatedLine(stripTurnTokens(reply));
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
   *     the loaded model's turn grammar ({@link wrapGemmaTurn} /
   *     {@link wrapGemma4Turn}), bypassing llama-server's Jinja templating
   *     (`--no-jinja`; its TranslateGemma parse is broken and Gemma 4's
   *     canonical template postdates our pinned server build).
   */
  private async complete(
    system: string | undefined,
    user: string,
    endpoint: { baseUrl: string; format: LocalLlmPromptFormat },
    signal: AbortSignal | undefined,
    nPredictOverride?: number,
  ): Promise<string> {
    // Per-REQUEST timeout: the step's total budget is unbounded (a long video
    // is many requests), but no single request may hang the pipeline.
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const { baseUrl, format } = endpoint;
    if (this.opts.backend === 'llama-cpp') {
      const prompt =
        format === 'gemma4'
          ? wrapGemma4Turn(system, user)
          : wrapGemmaTurn(system ? `${system}\n\n${user}` : user);
      // Reply budget: a raw-segment reply is one line (512 is ample), but a
      // chat-JSON batch reply carries ~20 translated lines plus JSON scaffolding
      // (and the analysis pass a whole character sheet) — give those headroom.
      const nPredict = nPredictOverride ?? (this.mode === 'chat-json-batch' ? 3072 : 512);
      const data = await this.postJson<{ content?: string }>(
        `${baseUrl}/completion`,
        {},
        {
          prompt,
          temperature: 0,
          n_predict: nPredict,
          cache_prompt: true,
          stop: [format === 'gemma4' ? GEMMA4_END_TURN : GEMMA_END_TURN],
        },
        combined,
      );
      const content = data.content ?? '';
      // gemma4 replies are scrubbed HERE (not only in the raw path) so JSON
      // batch parsing never sees a re-opened thought channel.
      return format === 'gemma4' ? stripGemma4Markers(content) : content;
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
      combined,
    );
    return data.choices?.[0]?.message?.content ?? '';
  }
}
