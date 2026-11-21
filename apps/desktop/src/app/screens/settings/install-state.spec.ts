import { describe, expect, it } from 'vitest';

import type { AppError } from '../../core/models';
import { argosItem, downloadState, whisperItem, type TaskSnapshot } from './install-state';

const failure: AppError = { code: 'STT_MODEL_MISSING', message: 'Failed to install whisper model "large-v3".' };

function task(p: Partial<TaskSnapshot> & Pick<TaskSnapshot, 'state'>): TaskSnapshot {
  return { percent: null, message: '', ...p };
}

describe('downloadState', () => {
  it('says "not downloaded" for an item that is not on disk and was never asked for', () => {
    expect(downloadState(undefined, false)).toEqual({ kind: 'missing' });
  });

  it('says "downloaded" for an item on disk', () => {
    expect(downloadState(undefined, true)).toEqual({ kind: 'ready' });
  });

  it('cannot tell when the backend could not be asked', () => {
    expect(downloadState(undefined, null)).toEqual({ kind: 'unknown' });
  });

  it('shows a download in flight with its progress, whatever the disk says', () => {
    expect(downloadState(task({ state: 'running', percent: 34, message: 'Downloading' }), false)).toEqual({
      kind: 'downloading',
      percent: 34,
      message: 'Downloading',
    });
    // Not yet sized ("Starting…"): still a download, not a missing model.
    expect(downloadState(task({ state: 'running' }), null)).toEqual({ kind: 'downloading', percent: null, message: '' });
  });

  it('keeps a failed attempt on the row, with the reason, until it is retried or dismissed', () => {
    expect(downloadState(task({ state: 'failed', error: failure }), false)).toEqual({ kind: 'failed', error: failure });
  });

  it('counts a download that just finished as on disk before the list is read again', () => {
    expect(downloadState(task({ state: 'done', percent: 100 }), false)).toEqual({ kind: 'ready' });
    expect(downloadState(task({ state: 'done', percent: 100 }), null)).toEqual({ kind: 'ready' });
  });

  it('falls back to the disk for a failed task that carries no error', () => {
    expect(downloadState(task({ state: 'failed' }), true)).toEqual({ kind: 'ready' });
    expect(downloadState(task({ state: 'failed' }), false)).toEqual({ kind: 'missing' });
  });
});

describe('setup item names', () => {
  // setup/installer.ts emits these, and ActivityService.setupLabel parses them.
  it('names a speech model the way the installer reports it', () => {
    expect(whisperItem('large-v3-turbo')).toBe('whisper:large-v3-turbo');
  });

  it('names an Argos pair with the arrow the activity label splits on', () => {
    const item = argosItem({ from: 'zh', to: 'en' });
    expect(item).toBe('argos:zh->en');
    const [, rest = ''] = item.split(':');
    expect(rest.split('->')).toEqual(['zh', 'en']);
  });
});
