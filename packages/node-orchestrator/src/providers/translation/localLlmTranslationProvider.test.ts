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
