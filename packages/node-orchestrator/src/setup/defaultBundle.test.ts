import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAIRS,
  DEFAULT_WHISPER_MODEL,
  computeDefaultBundlePlan,
  formatBundlePlan,
  withWhisperOverride,
} from './defaultBundle.js';

describe('computeDefaultBundlePlan', () => {
  it('plans the en->vi + zh->vi defaults with the shared en->vi leg deduped', () => {
    const plan = computeDefaultBundlePlan([
      { source: 'en', target: 'vi-VN' },
      { source: 'zh', target: 'vi-VN' },
    ]);

    // whisper: one shared multilingual model.
    expect(plan.whisperModels).toEqual([DEFAULT_WHISPER_MODEL]);

    // Argos: en->vi is BOTH the en->vi pair and zh->vi's 2nd pivot leg, so it
    // appears exactly ONCE; zh->vi contributes zh->en.
    expect(new Set(plan.argosLegs.map((l) => `${l.from}_${l.to}`))).toEqual(
      new Set(['en_vi', 'zh_en']),
    );
    expect(plan.argosLegs).toHaveLength(2);

    // Piper: both pairs target vi -> a single recommended vi voice.
    expect(plan.piperVoices).toHaveLength(1);
    expect(plan.piperVoices[0]?.id).toBe('vi_VN-vais1000-medium');
    expect(plan.piperVoices[0]?.url).toMatch(/vi_VN-vais1000-medium\.onnx$/);
    expect(plan.piperVoices[0]?.configUrl).toMatch(/vi_VN-vais1000-medium\.onnx\.json$/);
  });

  it('expands a non-English pair through the English pivot (both legs)', () => {
    const plan = computeDefaultBundlePlan([{ source: 'zh', target: 'vi-VN' }]);
    expect(plan.argosLegs).toEqual([
      { from: 'zh', to: 'en' },
      { from: 'en', to: 'vi' },
    ]);
  });

  it('emits a single direct leg for an English-source pair', () => {
    const plan = computeDefaultBundlePlan([{ source: 'en', target: 'vi-VN' }]);
    expect(plan.argosLegs).toEqual([{ from: 'en', to: 'vi' }]);
  });

  it('throws for a target language with no curated recommended Piper voice', () => {
    // 'xx' has no PIPER_VOICES entry, so the build must fail loud rather than
    // silently bundle a pair with no TTS voice.
    expect(() => computeDefaultBundlePlan([{ source: 'en', target: 'xx-XX' }])).toThrow(
      /no curated recommended piper voice/i,
    );
  });

  it('ships en->vi and zh->vi as the shipped defaults', () => {
    // Guards the actual bundled set so a regression in DEFAULT_PAIRS is caught.
    expect(DEFAULT_PAIRS.map((p) => `${p.source}->${p.target}`)).toEqual([
      'en->vi-VN',
      'zh->vi-VN',
    ]);
  });

  it('defaults to DEFAULT_PAIRS when called with no argument', () => {
    const plan = computeDefaultBundlePlan();
    // en->vi + zh->vi => {en_vi, zh_en}; one vi voice; one whisper model.
    expect(new Set(plan.argosLegs.map((l) => `${l.from}_${l.to}`))).toEqual(
      new Set(['en_vi', 'zh_en']),
    );
    expect(plan.piperVoices).toHaveLength(1);
    expect(plan.whisperModels).toEqual([DEFAULT_WHISPER_MODEL]);
  });
});

describe('withWhisperOverride', () => {
  const base = computeDefaultBundlePlan();

  it('replaces whisperModels with a non-empty override (trimmed)', () => {
    expect(withWhisperOverride(base, '  large-v3-turbo  ').whisperModels).toEqual([
      'large-v3-turbo',
    ]);
  });

  it('ignores an empty/whitespace/undefined override', () => {
    expect(withWhisperOverride(base, undefined).whisperModels).toEqual(base.whisperModels);
    expect(withWhisperOverride(base, '').whisperModels).toEqual(base.whisperModels);
    expect(withWhisperOverride(base, '   ').whisperModels).toEqual(base.whisperModels);
  });

  it('does not touch argosLegs or piperVoices', () => {
    const out = withWhisperOverride(base, 'medium');
    expect(out.argosLegs).toEqual(base.argosLegs);
    expect(out.piperVoices).toEqual(base.piperVoices);
  });
});

describe('formatBundlePlan', () => {
  const plan = computeDefaultBundlePlan();

  it('emits the exact tab-separated --sh record contract the shell parses', () => {
    const lines = formatBundlePlan(plan, 'sh').trimEnd().split('\n');
    expect(lines).toEqual([
      'whisper\tsmall',
      'argos\ten\tvi',
      'argos\tzh\ten',
      `piper\t${plan.piperVoices[0]?.id}\t${plan.piperVoices[0]?.url}\t${plan.piperVoices[0]?.configUrl}`,
    ]);
    // Every record uses tabs (not spaces) as the field separator.
    for (const line of lines) expect(line).toContain('\t');
  });

  it('round-trips a JSON plan', () => {
    expect(JSON.parse(formatBundlePlan(plan, 'json'))).toEqual(plan);
  });

  it('serializes the whisper override consistently in both formats', () => {
    const overridden = withWhisperOverride(plan, 'large-v3-turbo');
    expect(formatBundlePlan(overridden, 'sh')).toContain('whisper\tlarge-v3-turbo');
    expect(JSON.parse(formatBundlePlan(overridden, 'json')).whisperModels).toEqual([
      'large-v3-turbo',
    ]);
  });
});
