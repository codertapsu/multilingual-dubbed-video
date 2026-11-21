import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { RunPreflightProvider } from '../../core/models/setup';
import { START_PROBLEM_KEYS, START_PROBLEM_PHASE_KEYS, describeStartProblem, packSizeLabel } from './start-problems';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

/** A preflight entry; its phase may be one the UI type does not list yet. */
type Problem = Omit<RunPreflightProvider, 'phase'> & { phase: string };

const problem = (over: Omit<Partial<RunPreflightProvider>, 'phase'> & { phase?: string }): Problem => ({
  phase: 'translation',
  providerId: 'llama-cpp',
  status: 'engine-pack-missing',
  ready: false,
  message: 'TranslateGemma needs the llama.cpp runtime engine pack.',
  ...over,
});

const describe1 = (p: Problem) => describeStartProblem(p, 'TranslateGemma', (id) => `pack ${id}`);

describe('describeStartProblem', () => {
  // Start used to show this sentence, in English, as ENGINE_UNAVAILABLE, with
  // no button, although the voice hints promise an install prompt at Start.
  it('offers to install a missing engine pack, by its name', () => {
    const p = describe1(problem({ action: { kind: 'install-pack', ref: 'llama-cpp-cuda' } }));
    expect(p.key).toBe('wizard.fix.install');
    expect(p.params).toEqual({ name: 'TranslateGemma', pack: 'pack llama-cpp-cuda' });
    expect(p.fix).toEqual({ kind: 'install', packId: 'llama-cpp-cuda' });
    expect(p.phaseKey).toBe('wizard.fix.phase.translation');
  });

  it('sends a missing API key to its place in Settings', () => {
    const p = describe1(problem({ status: 'cloud-key-missing', action: { kind: 'open-credentials', ref: 'anthropic' } }));
    expect(p.key).toBe('wizard.fix.cloud-key');
    expect(p.fix).toEqual({ kind: 'add-key', service: 'anthropic' });
  });

  it('offers the Ollama model download, and "Change it" when Ollama is not running', () => {
    expect(describe1(problem({ status: 'model-missing', action: { kind: 'pull-ollama-model', ref: 'qwen2.5:7b' } })).fix).toEqual({
      kind: 'pull-ollama',
      model: 'qwen2.5:7b',
    });
    expect(describe1(problem({ status: 'daemon-unreachable', action: { kind: 'guide', ref: 'ollama' } })).fix).toEqual({
      kind: 'change',
      target: 'provTranslation',
    });
  });

  it('says to try again for what is still starting or downloading', () => {
    const starting = describe1(problem({ phase: 'stt', status: 'worker-loading', action: { kind: 'guide', ref: 'worker-loading' } }));
    expect(starting.key).toBe('wizard.fix.starting');
    expect(starting.fix).toEqual({ kind: 'retry' });
    const downloading = describe1(problem({ status: 'model-missing', action: { kind: 'guide', ref: 'downloading-models' } }));
    expect(downloading.key).toBe('wizard.fix.downloading');
    expect(downloading.fix).toEqual({ kind: 'retry' });
  });

  it('takes the user back to the field for what only the form can change', () => {
    const voice = describe1(problem({ phase: 'tts', status: 'voice-mismatch', action: { kind: 'guide', ref: 'voices' } }));
    expect(voice.fix).toEqual({ kind: 'change', target: 'ttsVoice' });
    const model = describe1(problem({ phase: 'stt', status: 'model-missing', action: { kind: 'guide', ref: 'whisper-cpp-model' } }));
    expect(model.key).toBe('wizard.fix.model-choice');
    expect(model.fix).toEqual({ kind: 'change', target: 'provStt' });
  });

  it('keeps what the orchestrator said, for the details', () => {
    const p = describe1(problem({ remediation: 'Install it in Settings → Engines.' }));
    expect(p.detail).toBe('TranslateGemma needs the llama.cpp runtime engine pack. Install it in Settings → Engines.');
  });

  it('names a phase it does not know generically, with no field to send the user to', () => {
    const p = describe1(problem({ phase: 'separation', status: 'worker-loading' }));
    expect(p.phaseKey).toBe('wizard.fix.phase.other');
    const unknown = describe1(problem({ phase: 'separation', status: 'daemon-unreachable' }));
    expect(unknown.fix).toBeNull();
  });

  it('says every sentence and phase name in both locales', () => {
    for (const key of [...START_PROBLEM_KEYS, ...START_PROBLEM_PHASE_KEYS]) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });
});

describe('packSizeLabel', () => {
  it('says MB under a gigabyte, GB above, nothing when unknown', () => {
    expect(packSizeLabel(135)).toBe('135 MB');
    expect(packSizeLabel(1600)).toBe('1.6 GB');
    expect(packSizeLabel(undefined)).toBe('');
    expect(packSizeLabel(0)).toBe('');
  });
});
