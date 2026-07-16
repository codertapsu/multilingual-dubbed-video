import { describe, expect, it } from 'vitest';
import type { TranslationInput } from '@videodubber/shared';
import { LocalLlmTranslationProvider, type LocalPostJson } from './localLlmTranslationProvider.js';
import { buildRawTranslationPrompt } from './llmTranslationProvider.js';

/** A postJson spy that records the last call and returns a canned reply. */
function spy(reply: unknown): { post: LocalPostJson; calls: { url: string; body: any }[] } {
  const calls: { url: string; body: any }[] = [];
  const post: LocalPostJson = async <T>(url: string, _h: Record<string, string>, body: unknown): Promise<T> => {
    calls.push({ url, body });
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
