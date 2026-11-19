/**
 * Claude (Anthropic) Messages calls, through the official SDK.
 *
 * The translation audit of 2026-11-17 found the Claude path a raw `fetch` that
 * pinned Claude Haiku 4.5 (changeable only by hand-editing credentials.json),
 * never read `stop_reason` — a reply cut off at max_tokens or refused fell back,
 * line by line, to the untranslated source text without a word — and asked for
 * JSON in prose only. Here:
 *  - the model is the user's choice in Settings, Claude Opus 5.5 by default;
 *  - every reply is checked: a refusal or a cut-off is an error with a reason,
 *    never a quiet fallback;
 *  - a caller's JSON schema becomes structured output, so the reply parses;
 *  - Claude Opus 5.x requests carry server-side fallbacks: a request its
 *    safety classifiers decline is re-run on Anthropic's recommended model
 *    inside the same call instead of failing the translation;
 *  - Opus/Sonnet/Haiku 5.x always think (adaptively), and thinking shares
 *    max_tokens with the answer, so the budget leaves room for both and the
 *    reply is streamed (long requests must stream).
 *
 * No prompt caching: each request's prefix differs (the batch is in the only
 * user message), so a cache write would cost 25% more and never be read.
 *
 * The SDK is imported on the first Claude call, so a user who never selects
 * Claude never loads it (cloud providers are opt-in).
 */
// Type-only: erased at runtime, so the SDK itself still loads on first use.
import type AnthropicSdk from '@anthropic-ai/sdk';
import { AppErrorException } from '@videodubber/shared';

/** The default Claude model, and the ones offered in Settings. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const CLAUDE_MODEL_CHOICES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

/** Room for adaptive thinking on top of the reply budget a caller asks for. */
const THINKING_HEADROOM_TOKENS = 16_000;
/** Reply budget when the caller names none (a 25-line batch is ~3K tokens). */
const DEFAULT_REPLY_TOKENS = 8_192;
/** The beta that carries server-side fallbacks (`fallbacks: "default"`). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface ClaudeRequest {
  apiKey: string;
  /** A custom endpoint (credentials' baseUrl), with or without the trailing /v1. */
  baseUrl?: string;
  model: string;
  system: string;
  user: string;
  /** The reply budget the caller needs; thinking headroom is added on top. */
  maxTokens?: number;
  /** JSON schema the reply must match (made Claude-compatible by {@link claudeJsonSchema}). */
  jsonSchema?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Claude reached through Mother Claude's HTTP API: errors then say how to fix that. */
  via?: 'mother-claude';
}

export interface ClaudeReply {
  text: string;
  /** The model that answered (differs from the request when a fallback ran). */
  model: string;
  fellBack: boolean;
}

/** The parts of an SDK Message this module reads. */
export interface ClaudeMessageLike {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: { type: string; text?: string }[];
  usage?: { iterations?: { type?: string }[] | null } | null;
}

/** Sends one request; the SDK in production, a fake in tests. */
export type ClaudeSend = (
  params: Record<string, unknown>,
  ctx: { apiKey: string; baseUrl?: string; timeoutMs: number; signal?: AbortSignal; beta: boolean; via?: 'mother-claude' },
) => Promise<ClaudeMessageLike>;

/**
 * Make a JSON schema acceptable to Claude's structured outputs: every object
 * closed (`additionalProperties: false` is required), and no keywords it
 * rejects (numeric, length and item-count bounds). `enum` goes too: the only
 * enums here list a batch's line ids, which would make every request a new
 * schema to compile, and the reply parser checks the ids anyway.
 */
export function claudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, claudeJsonSchema(sub)]));
    } else {
      out[key] = claudeJsonSchema(value);
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}
const UNSUPPORTED_KEYWORDS = new Set([
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'enum',
]);

/** Fallbacks are documented for the Opus 5 line; Haiku 5.5 has none, and proxies may not pass the beta. */
function wantsFallbacks(model: string, baseUrl: string | undefined): boolean {
  const official = !baseUrl || /^https:\/\/api\.anthropic\.com(\/v1)?\/?$/.test(baseUrl);
  return official && /^claude-opus-5/.test(model);
}

/** One Claude request: text out, or an error that says why there is none. */
export async function claudeMessage(req: ClaudeRequest, send: ClaudeSend = sdkSend): Promise<ClaudeReply> {
  const beta = wantsFallbacks(req.model, req.baseUrl);
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: (req.maxTokens ?? DEFAULT_REPLY_TOKENS) + THINKING_HEADROOM_TOKENS,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    ...(req.jsonSchema
      ? { output_config: { format: { type: 'json_schema', schema: claudeJsonSchema(req.jsonSchema) } } }
      : {}),
    ...(beta ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };
  const message = await send(params, {
    apiKey: req.apiKey,
    ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    beta,
    ...(req.via ? { via: req.via } : {}),
  });

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new AppErrorException('CLOUD_REQUEST_FAILED', `Claude declined this request${category ? ` (${category})` : ''}.`, {
      ...(message.stop_details?.explanation ? { cause: message.stop_details.explanation } : {}),
      remediation:
        'Retry the step, or translate these lines with a local engine. If one line keeps triggering it, edit that line in the editor.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AppErrorException('CLOUD_REQUEST_FAILED', `Claude's reply was cut off before it finished (${req.model}).`, {
      remediation: 'Retry the step. If it happens again, choose a different Claude model in Settings → Cloud API keys.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  const text = message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  const fellBack = (message.usage?.iterations ?? []).some((it) => it?.type === 'fallback_message');
  return { text, model: message.model, fellBack };
}

/** The SDK's base URL has no /v1 (it appends /v1/messages itself). */
function sdkBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl ? baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') : undefined;
}

/** The production {@link ClaudeSend} (exported for a wire-level test against a local server). */
export const sdkSend: ClaudeSend = async (params, ctx) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: ctx.apiKey,
    ...(ctx.baseUrl ? { baseURL: sdkBaseUrl(ctx.baseUrl) } : {}),
    timeout: ctx.timeoutMs,
    maxRetries: 2,
  });
  const options = ctx.signal ? { signal: ctx.signal } : {};
  try {
    // Streamed, then collected: a long thinking + answer must not sit on an
    // idle HTTP response until it times out.
    const stream = ctx.beta
      ? client.beta.messages.stream(params as never, options)
      : client.messages.stream(params as never, options);
    return (await stream.finalMessage()) as unknown as ClaudeMessageLike;
  } catch (err) {
    throw toAppError(err, Anthropic, ctx);
  }
};

/** Map an SDK error to the app's cloud error codes (never echoing the key). */
function toAppError(
  err: unknown,
  sdk: typeof AnthropicSdk,
  ctx: { timeoutMs: number; signal?: AbortSignal; baseUrl?: string; via?: 'mother-claude' },
): AppErrorException {
  if (err instanceof AppErrorException) return err;
  if (ctx.signal?.aborted || err instanceof sdk.APIUserAbortError) {
    return new AppErrorException('CANCELLED', 'The cloud request was cancelled.');
  }
  // Through Mother Claude the two usual failures are on this computer, so say
  // what to do there, not "check your internet" or "verify the API key".
  if (ctx.via === 'mother-claude') {
    if (err instanceof sdk.APIConnectionError && !(err instanceof sdk.APIConnectionTimeoutError)) {
      return new AppErrorException('CLOUD_REQUEST_FAILED', `Could not reach Mother Claude at ${ctx.baseUrl ?? 'its HTTP API'}.`, {
        cause: err.message,
        remediation:
          'Open Mother Claude, go to HTTP API, set Reachable from to This computer and press Start the API, then retry the step. If its Base URL differs, copy it into Settings → Cloud API keys → Anthropic (Claude).',
        docsRef: 'docs/PROVIDERS.md#claude-through-mother-claude',
      });
    }
    if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) {
      return new AppErrorException('CLOUD_REQUEST_FAILED', `Mother Claude refused the request (HTTP ${err.status}): its HTTP API has a key.`, {
        remediation: 'Paste the key you set on its HTTP API into Settings → Cloud API keys → Anthropic (Claude) → Mother Claude key.',
        docsRef: 'docs/PROVIDERS.md#claude-through-mother-claude',
      });
    }
  }
  if (err instanceof sdk.APIConnectionTimeoutError) {
    return new AppErrorException('WORKER_TIMEOUT', `Claude did not respond within ${Math.round(ctx.timeoutMs / 1000)}s.`, {
      remediation: 'Retry the step; if it keeps timing out, check your network or switch the phase to a local provider.',
    });
  }
  if (err instanceof sdk.APIConnectionError) {
    return new AppErrorException('CLOUD_REQUEST_FAILED', 'Could not reach Claude.', {
      cause: err.message,
      remediation: 'Check your internet connection (cloud providers need network access), then retry.',
    });
  }
  if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) {
    return new AppErrorException('CLOUD_REQUEST_FAILED', `Anthropic (Claude) rejected the API key (HTTP ${err.status}).`, {
      remediation: 'Verify the Anthropic API key in Settings → Cloud API keys.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  if (err instanceof sdk.NotFoundError) {
    return new AppErrorException('CLOUD_REQUEST_FAILED', 'This Claude model is not available to your API key.', {
      cause: err.message.slice(0, 300),
      remediation: 'Choose another Claude model in Settings → Cloud API keys.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  if (err instanceof sdk.RateLimitError) {
    return new AppErrorException('CLOUD_REQUEST_FAILED', 'Claude is rate-limiting this API key (HTTP 429).', {
      remediation: 'Wait a minute and retry the step, or check your Anthropic plan limits.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  if (err instanceof sdk.APIError) {
    return new AppErrorException('CLOUD_REQUEST_FAILED', `Claude request failed (HTTP ${err.status ?? '?'}).`, {
      cause: err.message.slice(0, 500),
      remediation: 'Retry the step; if it persists, check your Anthropic plan/quota.',
      docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
    });
  }
  return new AppErrorException('CLOUD_REQUEST_FAILED', 'Claude request failed.', { cause: String(err).slice(0, 300) });
}
