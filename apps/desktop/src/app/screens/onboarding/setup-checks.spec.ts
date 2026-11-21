import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { PreflightCheck } from '../../core/models/setup';
import { SETUP_CHECK_KEYS, setupCheckView } from './setup-checks';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

describe('setupCheckView', () => {
  // The first screen a Vietnamese user meets printed "Free disk space … warn".
  it('names a known check in the user language and says what to do about it', () => {
    const view = setupCheckView({
      id: 'disk',
      label: 'Free disk space',
      status: 'warn',
      detail: '3.1 GB free (recommend 5 GB+).',
      remediation: 'Free up disk space before downloading larger models.',
    });
    expect(view.labelKey).toBe('onboarding.check.disk');
    expect(view.fixKey).toBe('onboarding.check.disk-fix');
    expect(view.remediation).toBeUndefined();
    // The server's own words stay, as the detail line.
    expect(view.detail).toBe('3.1 GB free (recommend 5 GB+).');
  });

  it('gives a passing check no advice', () => {
    const view = setupCheckView({ id: 'ffmpeg', label: 'FFmpeg', status: 'ok', detail: 'ffmpeg version 7.1' });
    expect(view.labelKey).toBe('onboarding.check.ffmpeg');
    expect(view.fixKey).toBeNull();
    expect(view.remediation).toBeUndefined();
  });

  it('shows a check it does not know (a newer orchestrator) as the server sent it', () => {
    const check: PreflightCheck = { id: 'gpu', label: 'Graphics card', status: 'fail', remediation: 'Update the driver.' };
    const view = setupCheckView(check);
    expect(view.labelKey).toBeNull();
    expect(view.label).toBe('Graphics card');
    expect(view.fixKey).toBeNull();
    expect(view.remediation).toBe('Update the driver.');
  });

  it('says every name and advice in both locales', () => {
    expect(SETUP_CHECK_KEYS.length).toBeGreaterThan(7);
    for (const key of SETUP_CHECK_KEYS) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });
});
