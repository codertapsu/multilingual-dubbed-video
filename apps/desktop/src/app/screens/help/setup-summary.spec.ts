import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { PreflightCheck, PreflightResult } from '../../core/models/setup';
import type { WorkersHealth } from '../../core/models/view-models';
import { checkViews, serviceViews, SETUP_SUMMARY_KEYS, setupSummary } from './setup-summary';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

const check = (id: string, status: PreflightCheck['status'], extra: Partial<PreflightCheck> = {}): PreflightCheck => ({
  id,
  label: `${id} label`,
  status,
  ...extra,
});

const preflight = (...checks: PreflightCheck[]): PreflightResult => ({ ok: checks.every((c) => c.status !== 'fail'), checks });

const health = (down: (keyof WorkersHealth)[] = []): WorkersHealth => {
  const row = (id: keyof WorkersHealth) => ({ available: !down.includes(id), ...(down.includes(id) ? { detail: `${id} unreachable` } : {}) });
  return { stt: row('stt'), translation: row('translation'), tts: row('tts'), ffmpeg: row('ffmpeg'), ffprobe: row('ffprobe') };
};

describe('setupSummary', () => {
  it('is all good when every check passes', () => {
    expect(setupSummary(preflight(check('ffmpeg', 'ok'), check('disk', 'ok')), null)).toEqual({ tone: 'ok', problems: 0, warnings: 0 });
  });

  // Offline is a normal state for an offline-first app: something to know, not a problem.
  it('counts a warning as something to look at, not a problem', () => {
    expect(setupSummary(preflight(check('ffmpeg', 'ok'), check('network', 'warn')), null)).toEqual({ tone: 'warn', problems: 0, warnings: 1 });
  });

  it('counts failures as problems, whatever else warns', () => {
    const s = setupSummary(preflight(check('stt-worker', 'fail'), check('tts-worker', 'fail'), check('network', 'warn')), null);
    expect(s).toEqual({ tone: 'fail', problems: 2, warnings: 1 });
  });

  it('falls back on the services when the self-check did not answer', () => {
    expect(setupSummary(null, health(['tts']))).toEqual({ tone: 'fail', problems: 1, warnings: 0 });
    expect(setupSummary(null, health())).toEqual({ tone: 'ok', problems: 0, warnings: 0 });
    expect(setupSummary(null, null)).toBeNull();
  });
});

describe('checkViews', () => {
  it('gives known checks a plain name, and a fix only when they are not ok', () => {
    const [ok, failed, warned] = checkViews(
      preflight(
        check('ffmpeg', 'ok', { detail: 'ffmpeg version 7' }),
        check('stt-worker', 'fail', { remediation: 'Start the STT worker (scripts/start-services.sh)' }),
        check('disk', 'warn'),
      ),
    );
    expect(ok).toMatchObject({ nameKey: 'help.check.ffmpeg', fixKey: null, detail: 'ffmpeg version 7' });
    expect(failed).toMatchObject({ nameKey: 'help.check.stt', fixKey: 'help.fix.service' });
    // The server's words are kept for Technical details.
    expect(failed!.remediation).toContain('start-services');
    expect(warned).toMatchObject({ nameKey: 'help.check.disk', fixKey: 'help.fix.disk' });
  });

  it("keeps the server's label for a check this build does not know", () => {
    const [view] = checkViews(preflight(check('gpu', 'warn', { remediation: 'Update the driver' })));
    expect(view).toMatchObject({ nameKey: null, fixKey: null, label: 'gpu label', remediation: 'Update the driver' });
  });
});

describe('serviceViews', () => {
  it('names the services plainly and tells the tools apart', () => {
    const views = serviceViews(health(['translation']));
    expect(views.map((v) => [v.id, v.kind, v.available])).toEqual([
      ['stt', 'service', true],
      ['translation', 'service', false],
      ['tts', 'service', true],
      ['ffmpeg', 'tool', true],
      ['ffprobe', 'tool', true],
    ]);
    expect(views[1]).toMatchObject({ nameKey: 'help.service.translation', detail: 'translation unreachable' });
  });
});

// The keys come from tables, which the i18n checker cannot follow.
describe('setup-summary keys', () => {
  it('are all in both locales', () => {
    for (const key of SETUP_SUMMARY_KEYS) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });
});
