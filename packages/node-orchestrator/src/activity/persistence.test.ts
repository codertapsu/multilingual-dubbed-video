import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry, EditHistoryEntry, TranscriptSegment } from '@videodubber/shared';

import { ActivityLog, foldActivityLines, INTERRUPTED_MESSAGE, rotatedFile, settleInterrupted } from './activityLog.js';
import { FileEditHistoryStore, trimIndex } from './historyStore.js';
import { ActivityRegistry } from './registry.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-activity-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const line = (id: string, text: string): TranscriptSegment => ({ id, index: 0, startMs: 0, endMs: 1000, sourceText: text }) as TranscriptSegment;

let n = 0;
const edit = (projectId: string, over: Partial<EditHistoryEntry> = {}): EditHistoryEntry => ({
  id: `edit_${(++n).toString(16).padStart(16, '0')}`,
  projectId,
  at: new Date(Date.UTC(2026, 10, 23, 10, 0, n)).toISOString(),
  initiator: { kind: 'mcp', client: 'claude-code', session: 's1' },
  summary: `change ${n}`,
  target: 'source',
  before: [line('seg_0001', 'a')],
  after: [line('seg_0001', `b${n}`)],
  ...over,
});

describe('the edit history on disk', () => {
  it('keeps entries across a new store (a restart), newest first, the lines read on demand', async () => {
    const dir = (p: string) => path.join(tmp, p, 'history');
    const first = new FileEditHistoryStore(dir);
    const a = edit('p1');
    const b = edit('p1');
    await first.append(a);
    await first.append(b);
    await first.markUndone('p1', a.id, '2026-11-23T11:00:00.000Z');

    const again = new FileEditHistoryStore(dir);
    const summaries = await again.summaries('p1');
    expect(summaries.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(summaries[1]).toMatchObject({ undoneAt: '2026-11-23T11:00:00.000Z', beforeCount: 1, afterCount: 1, initiator: { client: 'claude-code' } });
    expect(summaries[0]).not.toHaveProperty('before');
    expect((await again.get('p1', a.id))?.after[0]?.sourceText).toBe(a.after[0]!.sourceText);
    expect((await again.get('p1', a.id))?.undoneAt).toBe('2026-11-23T11:00:00.000Z');
    expect((await again.list('p1')).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(await again.summaries('p2')).toEqual([]);
  });

  it('is bounded: the oldest entries and their files go', async () => {
    const dir = path.join(tmp, 'p1', 'history');
    const store = new FileEditHistoryStore(() => dir, { maxEntries: 3 });
    const all: EditHistoryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const e = edit('p1');
      all.push(e);
      await store.append(e);
    }
    expect((await store.summaries('p1')).map((s) => s.id)).toEqual(all.slice(2).reverse().map((e) => e.id));
    const files = (await fsp.readdir(dir)).sort();
    expect(files).toEqual([...all.slice(2).map((e) => `${e.id}.json`), 'index.json'].sort());
    expect(await store.get('p1', all[0]!.id)).toBeUndefined();
  });

  it('drops the oldest past the byte budget, always keeping the newest', () => {
    const items = [1, 2, 3].map((i) => ({ ...summary(i), bytes: 600 }));
    const dropped = trimIndex(items, 200, 1000);
    expect(dropped.map((d) => d.id)).toEqual(['e1', 'e2']);
    expect(items.map((d) => d.id)).toEqual(['e3']);
    const huge = [{ ...summary(9), bytes: 5000 }];
    expect(trimIndex(huge, 200, 1000)).toEqual([]);
  });

  it('rebuilds a lost or broken index from the entry files, and never reads outside the folder', async () => {
    const dir = path.join(tmp, 'p1', 'history');
    const store = new FileEditHistoryStore(() => dir);
    const a = edit('p1');
    const b = edit('p1');
    await store.append(a);
    await store.append(b);
    await fsp.writeFile(path.join(dir, 'index.json'), '{ broken', 'utf8');
    expect((await store.summaries('p1')).map((s) => s.id)).toEqual([b.id, a.id]);
    await fsp.rm(path.join(dir, 'index.json'));
    expect((await store.summaries('p1')).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(await store.get('p1', '../../etc/passwd')).toBeUndefined();
    await expect(store.append({ ...edit('p1'), id: '../x' })).rejects.toThrow();
    // Atomic writes leave no temp file behind.
    expect((await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

function summary(i: number) {
  return { id: `e${i}`, projectId: 'p', at: `2026-11-23T10:00:0${i}.000Z`, initiator: { kind: 'ui' as const }, summary: '', target: 'source' as const, beforeCount: 0, afterCount: 0 };
}

describe('the activity log on disk', () => {
  const projectRoot = (id: string) => path.join(tmp, 'projects', id);
  const logOptions = (extra: Partial<ConstructorParameters<typeof ActivityLog>[0]> = {}) => ({
    logsDir: path.join(tmp, 'config', 'logs'),
    projectFile: async (id: string) => {
      const exists = await fsp.stat(projectRoot(id)).then(() => true, () => false);
      return exists ? path.join(projectRoot(id), 'logs', 'activity.jsonl') : undefined;
    },
    ...extra,
  });

  it('reads back what ran, with who started it, after a restart; what still ran then is stopped', async () => {
    await fsp.mkdir(projectRoot('p1'), { recursive: true });
    const registry = new ActivityRegistry();
    const log = new ActivityLog(logOptions());
    log.attach(registry);
    const done = registry.start({ kind: 'speakers.detect', title: 'Detecting speakers', projectId: 'p1', initiator: { kind: 'mcp', client: 'claude-code' } });
    done.progress(50, 'part 6/12');
    done.done('12 speakers');
    const running = registry.start({ kind: 'download', title: 'Downloading “x”', initiator: { kind: 'ui' } });
    running.progress(10, 'Downloading the video');
    await log.flush();

    const restarted = new ActivityLog(logOptions());
    const back = settleInterrupted(await restarted.readAll());
    const byId = new Map(back.map((e) => [e.id, e]));
    expect(byId.get(done.id)).toMatchObject({ state: 'done', result: '12 speakers', initiator: { kind: 'mcp', client: 'claude-code' } });
    expect(byId.get(running.id)).toMatchObject({ state: 'cancelled', message: INTERRUPTED_MESSAGE, error: { code: 'CANCELLED' } });
    expect(byId.get(running.id)?.endedAt).toBe(byId.get(running.id)?.updatedAt);

    // The project keeps its own entries, and only them.
    const own = await restarted.readProject('p1');
    expect(own.map((e) => e.id)).toEqual([done.id]);

    const fresh = new ActivityRegistry();
    fresh.restore(back);
    expect(fresh.list({ projectId: 'p1' })[0]?.state).toBe('done');
  });

  it('writes a line for each change of state, but a moving percentage at most every 30 s', async () => {
    let now = 1_000_000;
    const registry = new ActivityRegistry();
    const log = new ActivityLog(logOptions({ now: () => now }));
    log.attach(registry);
    const job = registry.start({ kind: 'engine.install', title: 'Installing x' });
    for (let p = 1; p <= 20; p++) job.progress(p, 'downloading');
    now += 31_000;
    job.progress(30, 'downloading');
    job.done('Installed');
    await log.flush();
    const lines = (await fsp.readFile(log.appFile, 'utf8')).trim().split('\n');
    // start, the first "downloading", the one 31 s later, the end.
    expect(lines).toHaveLength(4);
    expect(foldActivityLines([lines.join('\n')])[0]).toMatchObject({ state: 'done', percent: 100 });
  });

  it('is bounded: past its size the file rotates, keeping two', async () => {
    const registry = new ActivityRegistry();
    const log = new ActivityLog(logOptions({ maxBytes: 2000 }));
    log.attach(registry);
    for (let i = 0; i < 40; i++) registry.start({ kind: 'external', title: `job ${i}`, external: true }).done('ok');
    await log.flush();
    const current = (await fsp.stat(log.appFile)).size;
    const rotated = (await fsp.stat(rotatedFile(log.appFile))).size;
    expect(current).toBeLessThanOrEqual(2000);
    expect(rotated).toBeLessThanOrEqual(2000);
    const back = await new ActivityLog(logOptions({ maxBytes: 2000 })).readAll();
    expect(back.length).toBeGreaterThan(0);
    expect(back.length).toBeLessThan(40);
    expect(back[0]?.title).toBe('job 39');
  });

  it('never writes into a project folder that is gone, nor while the projects move', async () => {
    const registry = new ActivityRegistry();
    let moving = false;
    const log = new ActivityLog(
      logOptions({
        projectFile: async (id: string, purpose: 'write' | 'read') => {
          if (purpose === 'write' && moving) return undefined;
          const exists = await fsp.stat(projectRoot(id)).then(() => true, () => false);
          return exists ? path.join(projectRoot(id), 'logs', 'activity.jsonl') : undefined;
        },
      }),
    );
    log.attach(registry);
    registry.start({ kind: 'external', title: 'for a deleted project', projectId: 'gone', external: true }).done();
    await fsp.mkdir(projectRoot('p2'), { recursive: true });
    moving = true;
    registry.start({ kind: 'external', title: 'while moving', projectId: 'p2', external: true }).done();
    await log.flush();
    await expect(fsp.stat(projectRoot('gone'))).rejects.toThrow();
    await expect(fsp.stat(path.join(projectRoot('p2'), 'logs', 'activity.jsonl'))).rejects.toThrow();
    // The app-wide log has both.
    expect((await log.readAll()).map((e) => e.title).sort()).toEqual(['for a deleted project', 'while moving']);
  });

  it('skips a line cut short when the app stopped', () => {
    const entry: ActivityEntry = {
      id: 'act_1',
      kind: 'external',
      title: 't',
      initiator: { kind: 'ui' },
      state: 'running',
      percent: null,
      startedAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:00:00.000Z',
    };
    const text = `${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, state: 'done' }).slice(0, 30)}`;
    expect(foldActivityLines([text])).toEqual([entry]);
  });
});
