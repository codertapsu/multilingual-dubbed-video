import { describe, expect, it } from 'vitest';
import type { JoinCheck } from '@videodubber/shared';

import {
  addJoinPaths,
  fileNameOf,
  joinBlocker,
  joinedNameOf,
  joinRetryable,
  joinRunning,
  moveJoinPath,
  removeJoinPath,
  samePaths,
} from './join-form';

const check = (over: Partial<JoinCheck> = {}): JoinCheck => ({
  files: [],
  ok: true,
  mode: 'copy',
  mismatches: [],
  totalDurationMs: 1000,
  mixedSampleRates: false,
  disk: { folder: 'D:/VideoDubber/projects', needBytes: 1, freeBytes: 2, enough: true },
  ...over,
});

describe('the file list', () => {
  it('adds in order, skipping blanks, quotes and files already listed', () => {
    expect(addJoinPaths(['D:\\v\\P1.mp4'], ['', ' "D:\\v\\P2.mp4" ', 'd:/V/p1.MP4', 'D:\\v\\P3.mp4'])).toEqual([
      'D:\\v\\P1.mp4',
      'D:\\v\\P2.mp4',
      'D:\\v\\P3.mp4',
    ]);
  });

  it('stops at the app\'s limit of 100 files', () => {
    const many = Array.from({ length: 120 }, (_, i) => `/v/${i}.mp4`);
    expect(addJoinPaths([], many)).toHaveLength(100);
  });

  it('moves a file up or down, and leaves the edges alone', () => {
    const list = ['a', 'b', 'c'];
    expect(moveJoinPath(list, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveJoinPath(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveJoinPath(list, 0, -1)).toEqual(list);
    expect(moveJoinPath(list, 2, 1)).toEqual(list);
    expect(removeJoinPath(list, 1)).toEqual(['a', 'c']);
  });

  it('knows a check of an older list from one of this list', () => {
    expect(samePaths(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(samePaths(['b', 'a'], ['a', 'b'])).toBe(false);
    expect(samePaths(null, ['a', 'b'])).toBe(false);
  });
});

describe('joinBlocker', () => {
  const base = { paths: ['a', 'b'], checking: false, check: check(), checkedPaths: ['a', 'b'], reencode: false };

  it('waits for two files, then for a check of exactly them', () => {
    expect(joinBlocker({ ...base, paths: ['a'] })).toBe('files');
    expect(joinBlocker({ ...base, checking: true })).toBe('checking');
    expect(joinBlocker({ ...base, check: null })).toBe('checking');
    expect(joinBlocker({ ...base, checkedPaths: ['b', 'a'] })).toBe('checking');
    expect(joinBlocker(base)).toBeNull();
  });

  it('stops on a file that cannot be joined, a full drive, and a re-encode nobody agreed to', () => {
    expect(joinBlocker({ ...base, check: check({ ok: false }) })).toBe('unusable');
    expect(joinBlocker({ ...base, check: check({ disk: { folder: 'D:/', needBytes: 2, freeBytes: 1, enough: false } }) })).toBe('disk');
    expect(joinBlocker({ ...base, check: check({ mode: 'reencode' }) })).toBe('confirm');
    expect(joinBlocker({ ...base, check: check({ mode: 'reencode' }), reencode: true })).toBeNull();
  });
});

describe('names and states', () => {
  it('names the project after what the files share, as the app does', () => {
    expect(joinedNameOf(['D:\\v\\持械入大宋 P1.mp4', 'D:\\v\\持械入大宋 P2.mp4'])).toBe('持械入大宋');
    expect(joinedNameOf(['/v/Show - Tập 01.mkv', '/v/Show - Tập 02.mkv'])).toBe('Show');
    expect(joinedNameOf(['/v/alpha.mp4', '/v/beta.mp4'])).toBe('alpha');
    expect(joinedNameOf([])).toBe('');
    expect(fileNameOf('C:\\a\\b c.mp4')).toBe('b c.mp4');
  });

  it('tells a running join from one that can be started again', () => {
    expect(joinRunning({ state: 'waiting' })).toBe(true);
    expect(joinRunning({ state: 'done' })).toBe(false);
    expect(joinRetryable({ state: 'interrupted' })).toBe(true);
    expect(joinRetryable({ state: 'running' })).toBe(false);
    expect(joinRetryable(null)).toBe(false);
  });
});
