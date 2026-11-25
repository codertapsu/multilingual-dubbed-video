import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LineIssueReader } from './lineIssueReader.js';

let tmp: string;
let files: { translatedJson: string; translatedAlignedJson: string; pipelineJson: string };

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-issues-'));
  files = {
    translatedJson: path.join(tmp, 'translated.json'),
    translatedAlignedJson: path.join(tmp, 'translated.aligned.json'),
    pipelineJson: path.join(tmp, 'pipeline.json'),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Write `value` and move the file's mtime on, as a later save would. */
async function write(file: string, value: unknown, ageSec = 0): Promise<void> {
  await fsp.writeFile(file, JSON.stringify(value));
  const at = new Date(Date.now() + ageSec * 1000);
  await fsp.utimes(file, at, at);
}

describe("a project's lines to look at, read from its files", () => {
  it('finds the flagged lines and the overrunning voices, none for a project not translated yet', async () => {
    const reader = new LineIssueReader(() => files);
    expect(await reader.of('p')).toEqual({ flagged: [], overruns: [] });

    await write(files.translatedJson, {
      segments: [
        { id: 'seg_0001', startMs: 0, endMs: 900, sourceText: 'x', translatedText: 'Kunlun', qualityFlags: ['pinyin'] },
        { id: 'seg_0002', startMs: 1000, endMs: 1900, sourceText: 'y', translatedText: 'Côn Lôn' },
        { id: 'seg_0003', startMs: 2000, endMs: 2900, sourceText: 'z', translatedText: 'ok', qualityFlags: ['no-diacritics'], locked: true },
      ],
    });
    await write(files.translatedAlignedJson, [
      { segmentId: 'seg_0001', status: 'ok', overflowMs: 0 },
      { segmentId: 'seg_0002', status: 'timing-conflict', overflowMs: 640 },
    ]);
    await write(files.pipelineJson, { projectId: 'p', status: 'completed', steps: [], warnings: [{ code: 'lines-flagged' }] });
    expect(await reader.of('p')).toEqual({ flagged: [{ id: 'seg_0001', flags: ['pinyin'] }], overruns: [{ id: 'seg_0002', overflowMs: 640 }] });
  });

  it('reads a file again only once it changed', async () => {
    const reader = new LineIssueReader(() => files);
    await write(files.translatedJson, { segments: [{ id: 'seg_0001', qualityFlags: ['pinyin'] }] });
    const reads = vi.spyOn(fs.promises, 'readFile');
    expect((await reader.of('p')).flagged).toHaveLength(1);
    expect((await reader.of('p')).flagged).toHaveLength(1);
    expect(reads.mock.calls.filter(([f]) => f === files.translatedJson)).toHaveLength(1);

    // The line was fixed (a new file, a new mtime).
    await write(files.translatedJson, { segments: [{ id: 'seg_0001', translatedText: 'Côn Lôn' }] }, 5);
    expect((await reader.of('p')).flagged).toEqual([]);
    expect(reads.mock.calls.filter(([f]) => f === files.translatedJson)).toHaveLength(2);

    // Gone: nothing to look at, and nothing kept.
    await fsp.rm(files.translatedJson);
    expect((await reader.of('p')).flagged).toEqual([]);
  });

  it('treats an unreadable file as none, never as an error', async () => {
    await fsp.writeFile(files.translatedJson, '{ not json');
    expect(await new LineIssueReader(() => files).of('p')).toEqual({ flagged: [], overruns: [] });
  });
});
