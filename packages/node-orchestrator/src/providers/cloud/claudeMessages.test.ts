import { describe, expect, it } from 'vitest';
import { claudeJsonSchema, claudeMessage, type ClaudeMessageLike, type ClaudeSend } from './claudeMessages.js';

function fakeSend(reply: Partial<ClaudeMessageLike>) {
  const calls: { params: Record<string, unknown>; beta: boolean; baseUrl?: string }[] = [];
  const send: ClaudeSend = async (params, ctx) => {
    calls.push({ params, beta: ctx.beta, ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}) });
    return { model: String(params.model), stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], ...reply };
  };
  return { send, calls };
}

const base = { apiKey: 'sk-ant-test', system: 'sys', user: 'hello', timeoutMs: 60_000 };

describe('claudeMessage', () => {
  it('sends the chosen model with room for thinking, and server-side fallbacks on Opus 5.x', async () => {
    const { send, calls } = fakeSend({});
    const reply = await claudeMessage({ ...base, model: 'claude-opus-5-5', maxTokens: 2048 }, send);
    expect(reply).toEqual({ text: '{"ok":true}', model: 'claude-opus-5-5', fellBack: false });
    expect(calls[0]!.beta).toBe(true);
    expect(calls[0]!.params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 2048 + 16_000,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // Nothing the current models reject.
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(calls[0]!.params).not.toHaveProperty(k);
  });

  it('sends no fallbacks for Haiku 5.5 (it has none) or through a custom endpoint', async () => {
    const { send, calls } = fakeSend({});
    await claudeMessage({ ...base, model: 'claude-haiku-5-5' }, send);
    await claudeMessage({ ...base, model: 'claude-opus-5-5', baseUrl: 'https://proxy.example/v1' }, send);
    expect(calls.map((c) => c.beta)).toEqual([false, false]);
    expect(calls[0]!.params).not.toHaveProperty('fallbacks');
  });

  it('turns a JSON schema into structured output Claude accepts', async () => {
    const { send, calls } = fakeSend({});
    const schema = {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            properties: { id: { type: 'string', enum: ['seg_0001', 'seg_0002'] }, text: { type: 'string' } },
            required: ['id', 'text'],
          },
        },
      },
      required: ['segments'],
    };
    await claudeMessage({ ...base, model: 'claude-sonnet-5-5', jsonSchema: schema }, send);
    expect(calls[0]!.params.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string' }, text: { type: 'string' } },
                required: ['id', 'text'],
              },
            },
          },
          required: ['segments'],
        },
      },
    });
  });

  it('a refusal is an error that says so, never an empty translation', async () => {
    const { send } = fakeSend({ stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'x' }, content: [] });
    await expect(claudeMessage({ ...base, model: 'claude-opus-5-5' }, send)).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
      message: expect.stringContaining('declined'),
    });
  });

  it('a reply cut off at max_tokens is an error, not half a batch', async () => {
    const { send } = fakeSend({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"segments":[{"id"' }] });
    await expect(claudeMessage({ ...base, model: 'claude-opus-5-5' }, send)).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_FAILED',
      message: expect.stringContaining('cut off'),
    });
  });

  it('reports a server-side fallback', async () => {
    const { send } = fakeSend({ model: 'claude-opus-4-8', usage: { iterations: [{ type: 'message' }, { type: 'fallback_message' }] } });
    const reply = await claudeMessage({ ...base, model: 'claude-opus-5-5' }, send);
    expect(reply).toMatchObject({ model: 'claude-opus-4-8', fellBack: true });
  });
});

describe('claudeJsonSchema', () => {
  it('keeps property names that look like keywords', () => {
    expect(claudeJsonSchema({ type: 'object', properties: { enum: { type: 'string' }, pattern: { type: 'string' } } })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { enum: { type: 'string' }, pattern: { type: 'string' } },
    });
  });
});

describe('claudeMessage through Mother Claude', () => {
  it('names the client for its HTTP API, and only there', async () => {
    const seen: { via?: string; clientId?: string }[] = [];
    const send: ClaudeSend = async (params, ctx) => {
      seen.push({ ...(ctx.via ? { via: ctx.via } : {}), ...(ctx.clientId ? { clientId: ctx.clientId } : {}) });
      return { model: String(params.model), stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    };
    await claudeMessage({ ...base, model: 'claude-opus-5-5', via: 'mother-claude' }, send);
    await claudeMessage({ ...base, model: 'claude-opus-5-5', via: 'mother-claude', clientId: 'videodubber/proj_1' }, send);
    await claudeMessage({ ...base, model: 'claude-opus-5-5' }, send);
    expect(seen).toEqual([
      { via: 'mother-claude', clientId: 'videodubber' },
      { via: 'mother-claude', clientId: 'videodubber/proj_1' },
      {},
    ]);
  });
});
