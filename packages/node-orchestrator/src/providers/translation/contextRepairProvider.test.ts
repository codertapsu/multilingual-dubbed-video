import { describe, expect, it } from 'vitest';
import type { TranslationInput, TranslationResult } from '@videodubber/shared';
import { buildRepairPrompt, ContextRepairTranslationProvider } from './contextRepairProvider.js';
import type { CancellableTranslationProvider } from '../types.js';

/** Draft provider: uppercases the source (stands in for Argos). */
function fakeDraft(): CancellableTranslationProvider & { calls: number } {
  return {
    id: 'argos',
    displayName: 'fake-argos',
    isLocal: true,
    calls: 0,
    async translateSegments(input: TranslationInput): Promise<TranslationResult> {
      this.calls++;
      return { segments: input.segments.map((s) => ({ id: s.id, translatedText: `draft:${s.sourceText}` })) };
    },
  };
}

/** Chat stub that records prompts and replies per call. */
function fakeChat(replies: (system: string | undefined, user: string) => string) {
  const calls: { system?: string; user: string }[] = [];
  return {
    calls,
    async chatComplete(system: string | undefined, user: string): Promise<string> {
      calls.push({ ...(system !== undefined ? { system } : {}), user });
      return replies(system, user);
    },
  };
}

function seg(id: string, text: string, startMs: number, endMs: number) {
  return { id, sourceText: text, startMs, endMs };
}

describe('buildRepairPrompt', () => {
  it('shows source + draft per segment with a target-language budget', () => {
    const prompt = buildRepairPrompt(
      'en',
      'vi',
      [seg('seg_0001', 'Thank you, teacher.', 0, 2000)],
      new Map([['seg_0001', 'Cảm ơn bạn.']]),
      'Context (do NOT translate this block; use it for consistency):\nPronouns: student -> teacher: thầy/em\n',
    );
    expect(prompt).toContain('source: Thank you, teacher.');
    expect(prompt).toContain('draft: Cảm ơn bạn.');
    expect(prompt).toContain('syllables (âm tiết)');
    expect(prompt).toContain('thầy/em');
    expect(prompt).toContain('xưng hô');
    expect(prompt).toContain('ONLY a JSON object');
  });
});

describe('ContextRepairTranslationProvider', () => {
  const input = (n: number, documentContext?: TranslationInput['documentContext']): TranslationInput => ({
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    segments: Array.from({ length: n }, (_, i) => seg(`seg_${String(i + 1).padStart(4, '0')}`, `line ${i}`, i * 2000, i * 2000 + 1500)),
    ...(documentContext ? { documentContext } : {}),
  });

  it('repairs draft lines and keeps the draft where the reply is missing', async () => {
    const chat = fakeChat((_s, user) =>
      user.includes('reviewing machine-translated')
        ? '{"segments":[{"id":"seg_0001","text":"repaired 0"}]}' // seg_0002 missing on purpose
        : '{}',
    );
    const provider = new ContextRepairTranslationProvider({
      draft: fakeDraft(),
      chat,
    });
    const result = await provider.translateSegments(input(2, { pronounGuide: 'x' }));
    expect(result.segments.find((s) => s.id === 'seg_0001')?.translatedText).toBe('repaired 0');
    expect(result.segments.find((s) => s.id === 'seg_0002')?.translatedText).toBe('draft:line 1');
  });

  it('uses a provided character sheet verbatim (no analysis call)', async () => {
    const chat = fakeChat(() => '{"segments":[]}');
    const provider = new ContextRepairTranslationProvider({ draft: fakeDraft(), chat });
    await provider.translateSegments(input(10, { pronounGuide: 'student -> teacher: thầy/em' }));
    // Every chat call is a REPAIR call (no analysis pass), and the sheet is injected.
    expect(chat.calls.length).toBeGreaterThan(0);
    for (const call of chat.calls) {
      expect(call.user).toContain('reviewing machine-translated');
      expect(call.user).toContain('thầy/em');
    }
  });

  it('generates + returns the analysis when no sheet was provided', async () => {
    const chat = fakeChat((_s, user) =>
      user.includes('preparing notes') || user.includes('Analyze the following transcript')
        ? '{"synopsis":"a lesson","pronounGuide":"thầy/em"}'
        : '{"segments":[]}',
    );
    const provider = new ContextRepairTranslationProvider({ draft: fakeDraft(), chat });
    const result = await provider.translateSegments(input(10));
    expect(result.analysis).toEqual({ synopsis: 'a lesson', pronounGuide: 'thầy/em' });
    // First call = analysis; later calls carry the generated sheet.
    expect(chat.calls[0]!.user).toContain('Analyze the following transcript');
    expect(chat.calls[1]!.user).toContain('a lesson');
  });

  it('drafts pass through untouched for tiny jobs with no sheet (still repaired, no analysis)', async () => {
    const chat = fakeChat(() => '{"segments":[{"id":"seg_0001","text":"fixed"}]}');
    const provider = new ContextRepairTranslationProvider({ draft: fakeDraft(), chat });
    const result = await provider.translateSegments(input(2));
    // Below the analysis threshold: no analysis call, straight to repair.
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]!.user).toContain('reviewing machine-translated');
    expect(result.segments[0]!.translatedText).toBe('fixed');
    expect(result.analysis).toBeUndefined();
  });
});
