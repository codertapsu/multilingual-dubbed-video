import { describe, expect, it } from 'vitest';
import type { TranslationInput } from '@videodubber/shared';
import { LocalLlmTranslationProvider, type LocalPostJson } from './localLlmTranslationProvider.js';
import { buildRawTranslationPrompt } from './llmTranslationProvider.js';

/** A postJson spy that records the last call and returns a canned reply. */
function spy(reply: unknown): { post: LocalPostJson; calls: { url: string; body: any; headers: Record<string, string> }[] } {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const post: LocalPostJson = async <T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> => {
    calls.push({ url, body, headers });
    return reply as T;
  };
  return { post, calls };
}

const oneSeg: TranslationInput = {
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  segments: [{ id: 'seg_0', sourceText: 'Hello there.' }],
};

describe('LocalLlmTranslationProvider transport', () => {
  /** A server that never answers: the request ends only when its signal aborts. */
  const hung: LocalPostJson = (_url, _headers, _body, signal) =>
    new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const chatModel = (postJson: LocalPostJson) =>
    new LocalLlmTranslationProvider({
      id: 'llama-cpp-chat',
      backend: 'llama-cpp',
      mode: 'chat-json-batch',
      model: 'gemma-it',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 30,
      postJson,
    });

  it('reports a request that ran out of time as a timeout, not a cancel', async () => {
    // As a cancel, it failed a translation step whose lines were all done.
    await expect(chatModel(hung).chatComplete(undefined, 'hi')).rejects.toMatchObject({
      appError: { code: 'WORKER_TIMEOUT' },
    });
  });

  it('still reports the run being cancelled as a cancel', async () => {
    const ac = new AbortController();
    const pending = chatModel(async (_u, _h, _b, signal) => {
      ac.abort();
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return {} as never;
    }).chatComplete(undefined, 'hi', ac.signal);
    await expect(pending).rejects.not.toMatchObject({ appError: { code: 'WORKER_TIMEOUT' } });
  });

  it('reports each translated line as it lands (TranslateGemma, line by line)', async () => {
    const { post } = spy({ content: 'Xin chào.<end_of_turn>' });
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp',
      backend: 'llama-cpp',
      model: 'translategemma',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
    const progress: string[] = [];
    await provider.translateSegments({
      ...oneSeg,
      segments: [0, 1, 2].map((i) => ({ id: `seg_${i}`, sourceText: `Hello ${i}.` })),
      onProgress: (done: number, total: number) => progress.push(`${done}/${total}`),
    } as TranslationInput);
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
  });

  it('samples a retry when asked to (temperature)', async () => {
    const { post, calls } = spy({ content: '{}' });
    await chatModel(post).chatComplete(undefined, 'hi', undefined, { temperature: 0.4 });
    expect(calls[0]!.body.temperature).toBe(0.4);
  });

  it('sends the engine\'s per-launch bearer token with every request', async () => {
    const { post, calls } = spy({ content: 'Xin chào.<end_of_turn>' });
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp',
      backend: 'llama-cpp',
      model: 'translategemma',
      resolveBaseUrl: async () => ({ baseUrl: 'http://127.0.0.1:8080', headers: { Authorization: 'Bearer k123' } }),
      timeoutMs: 1000,
      postJson: post,
    });
    await provider.translateSegments(oneSeg);
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer k123' });
  });

  it('ollama → OpenAI /chat/completions, greedy (temperature 0)', async () => {
    const { post, calls } = spy({ choices: [{ message: { content: 'Xin chào.' } }] });
    const provider = new LocalLlmTranslationProvider({
      id: 'ollama',
      backend: 'ollama',
      model: 'translategemma:4b',
      resolveBaseUrl: async () => 'http://127.0.0.1:11434/v1',
      timeoutMs: 1000,
      postJson: post,
    });
    const out = await provider.translateSegments(oneSeg);
    expect(out.segments[0]!.translatedText).toBe('Xin chào.');
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0]!.body.messages[0].role).toBe('user');
    expect(calls[0]!.body.temperature).toBe(0);
  });

  it('llama-cpp → native /completion with a Gemma-wrapped prompt (dodging the broken chat template)', async () => {
    const { post, calls } = spy({ content: 'Xin chào.<end_of_turn>' });
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp',
      backend: 'llama-cpp',
      model: 'translategemma',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
    const out = await provider.translateSegments(oneSeg);
    // The echoed turn token is stripped.
    expect(out.segments[0]!.translatedText).toBe('Xin chào.');
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/completion');
    expect(calls[0]!.body.prompt).toContain('<start_of_turn>user');
    expect(calls[0]!.body.prompt).toContain('<start_of_turn>model');
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.stop).toContain('<end_of_turn>');
  });

  it('chat mode recovers a broken batch: retry rung, then per-line raw prompts', async () => {
    // Three zh segments; the model's first reply covers seg_0001 only AND as a
    // source echo. The retry resolves seg_0001; raw singles fix the rest.
    const calls: { body: any }[] = [];
    const post: LocalPostJson = async <T>(_url: string, _h: Record<string, string>, body: unknown): Promise<T> => {
      calls.push({ body: body as any });
      const prompt = (body as { prompt: string }).prompt;
      let content: string;
      if (prompt.includes('previous attempt left some of these segments untranslated')) {
        content = '{"segments":[{"id":"seg_0001","text":"Bạch Tử"}]}'; // retry: only one line
      } else if (prompt.includes('Translate the following subtitle segments')) {
        content = '{"segments":[{"id":"seg_0001","text":"白子"}]}'; // first pass: echo + missing
      } else {
        // Raw per-line prompt: reply with the bare translation.
        content = prompt.includes('真经') ? 'Chân Kinh' : 'Tiểu Ưng';
      }
      return { content } as T;
    };
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp-chat',
      backend: 'llama-cpp',
      mode: 'chat-json-batch',
      model: 'gemma-3-it',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
    const out = await provider.translateSegments({
      sourceLanguage: 'zh',
      targetLanguage: 'vi',
      segments: [
        { id: 'seg_0001', sourceText: '白子' },
        { id: 'seg_0002', sourceText: '真经' },
        { id: 'seg_0003', sourceText: '小鹰' },
      ],
    });
    expect(out.segments.map((s) => s.translatedText)).toEqual(['Bạch Tử', 'Chân Kinh', 'Tiểu Ưng']);
    // 1 batch + 1 retry + 2 raw singles.
    expect(calls).toHaveLength(4);
  });

  it('chat mode uses a bigger reply budget than raw mode (JSON batches need it)', async () => {
    const { post, calls } = spy({ content: '{"segments":[{"id":"seg_0","text":"Xin chào."}]}' });
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp-chat',
      backend: 'llama-cpp',
      mode: 'chat-json-batch',
      model: 'gemma-3-it',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
    await provider.translateSegments(oneSeg);
    expect(calls[0]!.body.n_predict).toBeGreaterThanOrEqual(3072);
  });
});

describe('LocalLlmTranslationProvider — constrained JSON and empty replies', () => {
  function chatProvider(post: LocalPostJson): LocalLlmTranslationProvider {
    return new LocalLlmTranslationProvider({
      id: 'llama-cpp-chat',
      backend: 'llama-cpp',
      mode: 'chat-json-batch',
      model: 'gemma-3-it',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
  }

  it('constrains every chat batch to exactly its ids (llama-server json_schema)', async () => {
    const { post, calls } = spy({ content: '{"segments":[{"id":"seg_0","text":"Xin chào."}]}' });
    await chatProvider(post).translateSegments(oneSeg);
    const schema = calls[0]!.body.json_schema;
    expect(schema.properties.segments.minItems).toBe(1);
    expect(schema.properties.segments.items.properties.id.enum).toEqual(['seg_0']);
  });

  it('passes a caller schema and reply budget through chatComplete; plain calls send none', async () => {
    const { post, calls } = spy({ content: '{}' });
    const provider = chatProvider(post);
    await provider.chatComplete('sys', 'user', undefined, { jsonSchema: { type: 'object' }, maxTokens: 777 });
    expect(calls[0]!.body.json_schema).toEqual({ type: 'object' });
    expect(calls[0]!.body.n_predict).toBe(777);
    await provider.chatComplete('sys', 'user');
    expect(calls[1]!.body).not.toHaveProperty('json_schema');
    expect(provider.contextTokens).toBe(8192);
  });

  it('budgets the batch prompt with the pipeline speech rate', async () => {
    const { post, calls } = spy({ content: '{"segments":[{"id":"seg_0","text":"Xin chào."}]}' });
    await chatProvider(post).translateSegments({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      segments: [{ id: 'seg_0', sourceText: 'Hello there.', startMs: 0, endMs: 2000 }],
      speechRate: 3.5,
      skipAnalysis: true,
    } as never);
    expect(calls[0]!.body.prompt).toContain('about 7 syllables (âm tiết), never more than 8');
  });

  it('TranslateGemma: retries an empty reply once with the plain trained prompt, then returns it EMPTY', async () => {
    const calls: any[] = [];
    let n = 0;
    const post: LocalPostJson = async <T>(_url: string, _h: Record<string, string>, body: unknown): Promise<T> => {
      calls.push(body);
      n += 1;
      return { content: n === 2 ? 'Xin chào.' : '' } as T;
    };
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp',
      backend: 'llama-cpp',
      model: 'translategemma',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
      concurrency: 1,
    });
    const seg = { id: 'seg_0', sourceText: '你好', startMs: 0, endMs: 2000 };
    const out = await provider.translateSegments({ sourceLanguage: 'zh', targetLanguage: 'vi', segments: [seg] });
    expect(out.segments[0]!.translatedText).toBe('Xin chào.');
    expect(calls[0].prompt).toContain('Aim for');
    expect(calls[1].prompt).not.toContain('Aim for');
    expect(calls[1].temperature).toBeGreaterThan(0);

    // Both empty: the line comes back EMPTY — never silently the Chinese source.
    n = 10;
    const empty = await provider.translateSegments({ sourceLanguage: 'zh', targetLanguage: 'vi', segments: [seg] });
    expect(empty.segments[0]!.translatedText).toBe('');
  });
});

describe('LocalLlmTranslationProvider — Gemma 4 prompt grammar', () => {
  /** A chat provider whose resolver reports the gemma4 grammar (a Gemma 4 pack loaded). */
  function gemma4Provider(post: LocalPostJson): LocalLlmTranslationProvider {
    return new LocalLlmTranslationProvider({
      id: 'llama-cpp-chat',
      backend: 'llama-cpp',
      mode: 'chat-json-batch',
      model: 'gemma-it',
      resolveBaseUrl: async () => ({ baseUrl: 'http://127.0.0.1:8080', promptFormat: 'gemma4' as const }),
      timeoutMs: 1000,
      postJson: post,
    });
  }

  it('renders the canonical no-thinking turn structure, byte-exact, and stops on <turn|>', async () => {
    const { post, calls } = spy({ content: 'ok' });
    await gemma4Provider(post).chatComplete('Be terse.', 'Say ok.');
    // Byte-identical to google/gemma-4-12B-it's chat_template.jinja rendered
    // with enable_thinking=false (its default): system turn, user turn, then a
    // generation prompt whose thought channel is PRE-CLOSED so the model
    // answers directly instead of reasoning before every deterministic batch.
    // (BOS is added by llama-server's tokenizer, not the prompt string.)
    expect(calls[0]!.body.prompt).toBe(
      '<|turn>system\nBe terse.<turn|>\n<|turn>user\nSay ok.<turn|>\n<|turn>model\n<|channel>thought\n<channel|>',
    );
    expect(calls[0]!.body.stop).toEqual(['<turn|>']);
    expect(calls[0]!.body.prompt).not.toContain('<start_of_turn>');
  });

  it('omits the system turn entirely when there is no system message (template parity)', async () => {
    const { post, calls } = spy({ content: 'ok' });
    await gemma4Provider(post).chatComplete(undefined, 'Say ok.');
    expect(calls[0]!.body.prompt).toBe(
      '<|turn>user\nSay ok.<turn|>\n<|turn>model\n<|channel>thought\n<channel|>',
    );
  });

  it('strips a re-opened thought channel so batch JSON parsing sees only the answer', async () => {
    // Despite the pre-closed channel, a model may still open one. The scrub
    // must run in the shared transport (not just the raw path): otherwise the
    // JSON parser reads the thought text and the whole batch goes to recovery.
    const { post } = spy({
      content:
        '<|channel>thought\nThe user wants a greeting translated.\n<channel|>{"segments":[{"id":"seg_0","text":"Xin chào."}]}<turn|>',
    });
    const out = await gemma4Provider(post).translateSegments(oneSeg);
    expect(out.segments[0]!.translatedText).toBe('Xin chào.');
  });

  it('drops an UNCLOSED thought channel (reply truncated mid-reasoning) instead of leaking it', async () => {
    const { post } = spy({ content: 'Xin chào.<|channel>thought\nNow I should also conside' });
    const reply = await gemma4Provider(post).chatComplete(undefined, 'x');
    expect(reply).toBe('Xin chào.');
  });

  it('a bare-string resolver still means the classic Gemma grammar (TranslateGemma unaffected)', async () => {
    const { post, calls } = spy({ content: 'Xin chào.' });
    const provider = new LocalLlmTranslationProvider({
      id: 'llama-cpp',
      backend: 'llama-cpp',
      model: 'translategemma',
      resolveBaseUrl: async () => 'http://127.0.0.1:8080',
      timeoutMs: 1000,
      postJson: post,
    });
    await provider.translateSegments(oneSeg);
    expect(calls[0]!.body.prompt).toContain('<start_of_turn>user');
    expect(calls[0]!.body.stop).toEqual(['<end_of_turn>']);
    expect(calls[0]!.body.prompt).not.toContain('<|turn>');
  });
});

describe('buildRawTranslationPrompt (TranslateGemma shape)', () => {
  it('names the languages, asks for translation only, and normalizes CRLF', () => {
    const prompt = buildRawTranslationPrompt('en', 'vi', { id: 's', sourceText: 'Line one.\r\nLine two.' });
    expect(prompt).toContain('professional English (en) to Vietnamese (vi) translator');
    expect(prompt).toMatch(/Produce only the Vietnamese translation/);
    expect(prompt).not.toContain('\r');
    // CRLF normalized; the text sits after the template's triple-newline.
    expect(prompt).toContain('Line one.\nLine two.');
    expect(prompt.endsWith(':\n\n\nLine one.\nLine two.')).toBe(true);
  });
});
