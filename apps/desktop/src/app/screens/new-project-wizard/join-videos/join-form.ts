/**
 * "Join several videos" in New project, the decisions that need no Angular:
 * the ordered file list (add, remove, move), why Continue waits, the name the
 * files give the project, and what a check or a join reads as. Pure, so
 * join-form.spec.ts can hold each rule.
 */
import type { JoinCheck, JoinStatus } from '@videodubber/shared';

import type { DraftJoin } from '../../../core/state/new-project-draft.service';

/** "Join several videos" as a new form starts: off, no files. */
export const DEFAULT_JOIN: DraftJoin = { on: false, paths: [], reencode: false };

/** At most this many files (the app's limit). */
export const MAX_JOIN_FILES = 100;

const norm = (p: string): string => p.trim().replace(/\\/g, '/').toLowerCase();

/**
 * `added` after `list`, in order, skipping blanks and files already listed (the
 * same file twice is almost always a double click, not an intent), up to
 * {@link MAX_JOIN_FILES}. Pure.
 */
export function addJoinPaths(list: readonly string[], added: readonly string[]): string[] {
  const out = [...list];
  const seen = new Set(list.map(norm));
  for (const raw of added) {
    const p = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!p || seen.has(norm(p)) || out.length >= MAX_JOIN_FILES) continue;
    seen.add(norm(p));
    out.push(p);
  }
  return out;
}

/** The list with item `index` moved by `delta` (−1 up, +1 down); unchanged at an edge. Pure. */
export function moveJoinPath(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** The list without item `index`. Pure. */
export function removeJoinPath(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

/** Same files in the same order (a check of an older list must not unlock Continue). Pure. */
export function samePaths(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Why Continue waits while joining. */
export type JoinBlocker = 'files' | 'checking' | 'unusable' | 'disk' | 'confirm';

/**
 * Why Continue is not available in join mode yet, or null: two files at
 * least, checked as they are listed now, every one readable, room on the
 * drive, and a re-encode agreed to when one is needed. Pure.
 */
export function joinBlocker(s: {
  paths: readonly string[];
  checking: boolean;
  check: JoinCheck | null;
  checkedPaths: readonly string[] | null;
  reencode: boolean;
}): JoinBlocker | null {
  if (s.paths.length < 2) return 'files';
  if (s.checking || !s.check || !samePaths(s.checkedPaths, s.paths)) return 'checking';
  if (!s.check.ok) return 'unusable';
  if (!s.check.disk.enough) return 'disk';
  if (s.check.mode === 'reencode' && !s.reencode) return 'confirm';
  return null;
}

/** A file's name from its path, either separator. Pure. */
export function fileNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * The project's name from its files: what their names share ("持械入大宋"
 * from "持械入大宋 P1" … "P5"), else the first file's name; the app names a
 * joined project the same way (join/joinService.ts joinedName). Pure.
 */
export function joinedNameOf(paths: readonly string[]): string {
  const names = paths.map((p) => fileNameOf(p).replace(/\.[^.]+$/, ''));
  const first = names[0] ?? '';
  let prefix = first;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const trimmed = prefix.replace(/[\s._\-–—([{#]*(?:p|part|ep|tập|phần|第)?\s*\d*$/iu, '').trim();
  return trimmed.length >= 2 ? trimmed : first;
}

/** Bytes in GB with one decimal, the way the app's messages give sizes. Pure. */
export function gbOf(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** The join is waiting or running (Start waits for it). Pure. */
export function joinRunning(status: Pick<JoinStatus, 'state'> | null | undefined): boolean {
  return status?.state === 'waiting' || status?.state === 'running';
}

/** The join ended without a video (failed, cancelled, interrupted): it can be started again. Pure. */
export function joinRetryable(status: Pick<JoinStatus, 'state'> | null | undefined): boolean {
  return status?.state === 'failed' || status?.state === 'cancelled' || status?.state === 'interrupted';
}
