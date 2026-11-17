import { describe, expect, it } from 'vitest';
import { AppErrorException, type TranslationInput, type TranslationResult } from '@videodubber/shared';
import { ProviderRegistry } from '../registry.js';
import type { CancellableTranslationProvider } from '../types.js';
import {
  BUILT_IN_CHAT_PROVIDER_ID,
  buildRewritePrompt,
  contextEngineCandidates,
  copiesNeighbour,
  FallbackContextChat,
  judgeRepair,
  judgeShortening,
  requestRewrites,
  type ContextCapableProvider,
} from './contextEngine.js';

/** A registry provider; `chat` makes it context-capable. */
function provider(
  id: string,
  chat?: (user: string) => Promise<string>,
): CancellableTranslationProvider & { calls: number } {
  const p = {
    id,
    displayName: `${id} model`,
    isLocal: true,
    calls: 0,
    async translateSegments(input: TranslationInput): Promise<TranslationResult> {
      return { segments: input.segments.map((s) => ({ id: s.id, translatedText: s.sourceText })) };
    },
    ...(chat
      ? {
          supportsRefinement: true,
          async chatComplete(_system: string | undefined, user: string): Promise<string> {
            p.calls += 1;
            return chat(user);
          },
        }
      : {}),
  };
  return p;
}

const missing = (): Promise<string> =>
  Promise.reject(new AppErrorException('ENGINE_PACK_MISSING', 'The Gemma chat model is not installed.'));

describe('contextEngineCandidates', () => {
  it('orders review model, built-in chat, then an instruction-following translator — never TranslateGemma', () => {
    const registry = new ProviderRegistry();
    registry.registerTranslation(provider('argos'));
    registry.registerTranslation(provider('llama-cpp')); // TranslateGemma: no chat
    registry.registerTranslation(provider(BUILT_IN_CHAT_PROVIDER_ID, async () => '{}'));
    registry.registerTranslation(provider('openai-translate', async () => '{}'));
    registry.registerTranslation(provider('reviewer', async () => '{}'));

    const ids = (refineProviderId: string | undefined, translationProviderId: string) =>
      contextEngineCandidates(registry, { refineProviderId, translationProviderId }).map((p) => p.id);
    expect(ids('reviewer', 'openai-translate')).toEqual(['reviewer', BUILT_IN_CHAT_PROVIDER_ID, 'openai-translate']);
    expect(ids(undefined, 'llama-cpp')).toEqual([BUILT_IN_CHAT_PROVIDER_ID]);
    expect(ids('none', 'argos')).toEqual([BUILT_IN_CHAT_PROVIDER_ID]);
  });

  it('ignores the registry falling back to its default for an unknown id', () => {
    const registry = new ProviderRegistry();
    registry.registerTranslation(provider('argos'));
    // 'llama-cpp-chat' is not registered here: getTranslation would hand back argos.
    expect(contextEngineCandidates(registry, { translationProviderId: 'argos' })).toEqual([]);
  });
});

describe('FallbackContextChat', () => {
  it('skips engines that are not installed, then sticks with the first that answers', async () => {
    const chat = provider(BUILT_IN_CHAT_PROVIDER_ID, missing) as unknown as ContextCapableProvider;
    const cloud = provider('openai-translate', async () => 'ok') as unknown as ContextCapableProvider;
    const skipped: string[] = [];
    const engine = new FallbackContextChat([chat, cloud], (p) => skipped.push(p.id));
    expect(await engine.chatComplete(undefined, 'hi')).toBe('ok');
    expect(await engine.chatComplete(undefined, 'again')).toBe('ok');
    expect(skipped).toEqual([BUILT_IN_CHAT_PROVIDER_ID]);
    expect(engine.engine?.id).toBe('openai-translate');
  });

  it("moves on when the local model's lane belongs to another dub", async () => {
    const busy = (): Promise<string> =>
      Promise.reject(new AppErrorException('ENGINE_BUSY', 'Another dub is using the local model.'));
    const chat = provider(BUILT_IN_CHAT_PROVIDER_ID, busy) as unknown as ContextCapableProvider;
    const cloud = provider('claude-translate', async () => 'ok') as unknown as ContextCapableProvider;
    const engine = new FallbackContextChat([chat, cloud]);
    expect(await engine.chatComplete(undefined, 'hi')).toBe('ok');
    expect(engine.engine?.id).toBe('claude-translate');
  });

  it('fails fast once its model has timed out, instead of waiting out every line', async () => {
    let calls = 0;
    const hung = provider(BUILT_IN_CHAT_PROVIDER_ID, async () => {
      calls += 1;
      throw new AppErrorException('WORKER_TIMEOUT', 'The local model did not answer within 30 min.');
    }) as unknown as ContextCapableProvider;
    const engine = new FallbackContextChat([hung]);
    await expect(engine.chatComplete(undefined, '1')).rejects.toMatchObject({ appError: { code: 'WORKER_TIMEOUT' } });
    await expect(engine.chatComplete(undefined, '2')).rejects.toMatchObject({ appError: { code: 'WORKER_TIMEOUT' } });
    expect(calls).toBe(1);
  });

  it('reports no engine once every candidate is missing', async () => {
    const engine = new FallbackContextChat([provider('x', missing) as unknown as ContextCapableProvider]);
    expect(engine.available).toBe(true);
    await expect(engine.chatComplete(undefined, 'hi')).rejects.toMatchObject({ appError: { code: 'ENGINE_UNAVAILABLE' } });
    expect(engine.available).toBe(false);
  });

  it('does not hide real failures of the chosen engine behind a fallback', async () => {
    let n = 0;
    const flaky = provider('a', async () => {
      n += 1;
      if (n === 1) return 'first';
      throw new Error('engine crashed');
    }) as unknown as ContextCapableProvider;
    const other = provider('b', async () => 'other') as unknown as ContextCapableProvider;
    const engine = new FallbackContextChat([flaky, other]);
    expect(await engine.chatComplete(undefined, '1')).toBe('first');
    await expect(engine.chatComplete(undefined, '2')).rejects.toThrow('engine crashed');
  });
});

describe('buildRewritePrompt', () => {
  const item = {
    id: 'seg_0042',
    sourceText: '我只要掉一根毫毛',
    currentText: 'Ta chỉ cần rụng một sợi lông thôi là các ngươi xong đời',
    speakerId: 'SPEAKER_01',
    target: 9,
    max: 10,
    unit: 'syllables' as const,
    previous: [{ sourceText: '你们敢动我', text: 'Các ngươi dám động vào ta?' }],
    next: [{ sourceText: '师父会来', text: 'Sư phụ sẽ đến.' }],
  };

  it('asks to shorten the CURRENT line with its neighbours, speaker and range', () => {
    const prompt = buildRewritePrompt({
      kind: 'shorten',
      sourceLanguage: 'zh',
      targetLanguage: 'vi',
      items: [item],
      documentContext: { glossary: [{ source: '师父', target: 'Sư phụ' }] },
    });
    expect(prompt).toContain('seg_0042 (SPEAKER_01) — length: about 9 syllables (âm tiết), at most 10');
    expect(prompt).toContain('current: Ta chỉ cần rụng một sợi lông thôi là các ngươi xong đời');
    expect(prompt).toContain('context before (do not copy): 你们敢动我 => Các ngươi dám động vào ta?');
    expect(prompt).toContain('context after (do not copy): 师父会来 => Sư phụ sẽ đến.');
    expect(prompt).toContain('do NOT translate the source again');
    expect(prompt).toContain('"师父" -> "Sư phụ"');
    expect(prompt).toContain('speech recognition');
  });

  it('a strict pass says the limit is hard; a repair names the problem', () => {
    expect(
      buildRewritePrompt({ kind: 'shorten', sourceLanguage: 'zh', targetLanguage: 'vi', items: [item], strict: true }),
    ).toContain('HARD limit');
    const repair = buildRewritePrompt({
      kind: 'repair',
      sourceLanguage: 'zh',
      targetLanguage: 'vi',
      items: [{ ...item, problem: 'it contains a pinyin name' }],
    });
    expect(repair).toContain('problem: it contains a pinyin name');
    expect(repair).toContain('never pinyin');
  });
});

describe('judgeShortening — the auto-fit acceptance rule', () => {
  const langs = { sourceLanguage: 'zh', targetLanguage: 'vi' };
  const item = { sourceText: '此乃上古至高道术', currentText: 'Đây là đạo thuật tối cao thời thượng cổ đấy', target: 6 };

  it('accepts a shorter, clean line', () => {
    expect(judgeShortening(item, 'Đây là đạo thuật tối cao thượng cổ', langs)).toMatchObject({ accepted: true, units: 8 });
  });

  it('refuses a line that is not shorter in budget units', () => {
    expect(judgeShortening(item, 'Đây chính là đạo thuật tối cao thời thượng cổ', langs).accepted).toBe(false);
  });

  it('refuses a line that fails the checks, echoes the source, or is empty', () => {
    expect(judgeShortening(item, 'Đạo thuật 至高', langs).reason).toContain('fails line checks');
    expect(judgeShortening(item, '此乃上古至高道术', langs).reason).toContain('echoes');
    expect(judgeShortening(item, '', langs).accepted).toBe(false);
  });

  it('refuses a cut far below the target — that loses meaning, not filler', () => {
    expect(judgeShortening(item, 'Đạo thuật.', langs)).toMatchObject({ accepted: false });
    expect(judgeShortening(item, 'Đạo thuật.', langs).reason).toContain('cut too far');
  });

  it('holds a line already flagged only to what the shortening breaks', () => {
    // The checks flag "Kunlun" either way; refusing every shortening of the
    // line left it on its heavy stretch forever.
    const named = {
      sourceText: '昆仑墟的弟子今天全都下山去了',
      currentText: 'Hôm nay các đệ tử của Kunlun đều đã xuống núi cả rồi',
      target: 9,
    };
    expect(judgeShortening(named, 'Hôm nay đệ tử Kunlun đã xuống núi cả', langs)).toMatchObject({ accepted: true });
    // A check the current line passes still refuses the proposal.
    expect(judgeShortening(named, 'Hôm nay đệ tử Kunlun 都 xuống núi', langs).reason).toContain('fails line checks');
  });
});

describe('copiesNeighbour', () => {
  const item = {
    currentText: 'Sau đó, ta sẽ hấp thụ bản nguyên của tên vô tri ấy',
    previous: [{ sourceText: '我先', text: 'Ta trước hết' }],
    next: [{ sourceText: '再与你二人细说', text: 'Chúng ta sẽ trao đổi chi tiết hơn nữa.' }],
  };
  it('catches a rewrite that drags the next line in (Gemma 3 4B auto-fit, 2026-11-17)', () => {
    expect(copiesNeighbour(item, 'Ta sẽ hấp thụ bản nguyên. Chúng ta sẽ trao đổi chi tiết hơn nữa.')).toBe(true);
    expect(copiesNeighbour(item, 'Chúng ta sẽ trao đổi chi tiết hơn nữa')).toBe(true);
  });
  it('allows a genuine shortening of the line itself', () => {
    expect(copiesNeighbour(item, 'Ta sẽ hấp thụ bản nguyên của hắn')).toBe(false);
  });
  it('makes both acceptance rules refuse such a proposal', () => {
    const langs = { sourceLanguage: 'zh', targetLanguage: 'vi' };
    const full = { ...item, sourceText: '我先将那无知其的本源吸收', target: 6 };
    expect(judgeShortening(full, 'Chúng ta sẽ trao đổi chi tiết', langs).reason).toBe('copies a neighbouring line');
    expect(judgeRepair({ ...full, currentText: '' }, 'Chúng ta sẽ trao đổi chi tiết hơn nữa.', langs).accepted).toBe(false);
  });
});

describe('judgeRepair', () => {
  const langs = { sourceLanguage: 'zh', targetLanguage: 'vi' };
  it('accepts only what fixes the problem', () => {
    const item = { sourceText: '昆仑墟', currentText: 'Kunlun Xu' };
    expect(judgeRepair(item, 'Côn Lôn Khư', langs).accepted).toBe(true);
    expect(judgeRepair(item, 'Kunlun Hư', langs).accepted).toBe(false);
    // Untranslated → pinyin is still better than nothing.
    expect(judgeRepair({ sourceText: '昆仑墟', currentText: '' }, 'Kunlun', langs).accepted).toBe(true);
  });
});

describe('requestRewrites', () => {
  const args = {
    kind: 'shorten' as const,
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    items: [
      { id: 'seg_0001', sourceText: 'a', currentText: 'một hai ba bốn', max: 3 },
      { id: 'seg_0002', sourceText: 'b', currentText: 'năm sáu bảy tám', max: 3 },
    ],
  };

  it('constrains the reply to the batch ids and retries an unusable reply once', async () => {
    const calls: { schema?: Record<string, unknown> }[] = [];
    const chat = {
      chatComplete: async (_s: string | undefined, _u: string, _sig?: AbortSignal, opts?: { jsonSchema?: Record<string, unknown> }) => {
        calls.push({ schema: opts?.jsonSchema });
        return calls.length === 1 ? 'Sure! Here you go' : '{"segments":[{"id":"seg_0001","text":"một hai ba"}]}';
      },
    };
    const { proposals, errors } = await requestRewrites(chat, args, undefined, { batchSize: 2 });
    expect(calls).toHaveLength(2);
    const items = (calls[0]!.schema as { properties: { segments: { items: { properties: { id: { enum: string[] } } } } } })
      .properties.segments.items.properties.id.enum;
    expect(items).toEqual(['seg_0001', 'seg_0002']);
    expect(proposals.get('seg_0001')).toBe('một hai ba');
    expect(errors).toEqual([]);
  });

  it('collects engine errors instead of throwing, but lets cancellation through', async () => {
    const failing = { chatComplete: async () => Promise.reject(new Error('llama-server died')) };
    expect((await requestRewrites(failing, args, undefined, { batchSize: 2 })).errors).toEqual(['llama-server died']);
    // One line per request by default: each line fails on its own.
    expect((await requestRewrites(failing, args)).errors).toHaveLength(2);
    const cancelled = {
      chatComplete: async () => Promise.reject(new AppErrorException('CANCELLED', 'Pipeline run was cancelled.')),
    };
    await expect(requestRewrites(cancelled, args)).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
  });
});
