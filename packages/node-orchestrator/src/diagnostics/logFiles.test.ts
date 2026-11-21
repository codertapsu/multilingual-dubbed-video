import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RotatingLog, StructuredLog, engineLogFile, stampLines, tailFile } from './logFiles.js';
import { buildZip } from './zip.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'vd-logs-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('log files', () => {
  it('rolls a log over when it grows past its cap, keeping the newest lines', () => {
    const file = path.join(tmp(), 'engines', 'x.log');
    const log = new RotatingLog(file, 100, 2);
    for (let i = 0; i < 12; i++) log.write(`line ${String(i).padStart(2, '0')} xxxxxxxx\n`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('line 11');
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it('reads the tail from a line start, and stamps engine output per line', () => {
    const file = path.join(tmp(), 'a.log');
    writeFileSync(file, 'first line\nsecond line\nthird line\n');
    expect(tailFile(file, 16)).toBe('third line\n');
    expect(tailFile(path.join(tmp(), 'none.log'))).toBe('');
    expect(stampLines('Traceback\r\n  File "x"\n', new Date('2026-11-21T04:51:00Z'))).toBe(
      '2026-11-21T04:51:00.000Z Traceback\n2026-11-21T04:51:00.000Z   File "x"\n',
    );
    expect(engineLogFile('/l', 'diarization-sherpa')).toBe(path.join('/l', 'engines', 'diarization-sherpa.log'));
  });

  it('keeps structured records one per line and reads the recent ones back', () => {
    const log = new StructuredLog(tmp());
    log.write({ level: 'warn', msg: 'GPU busy', projectId: 'p1' }, new Date('2026-11-21T00:00:00Z'));
    log.write({ level: 'info', msg: 'step done', projectId: 'p1', step: 'stt' });
    const recent = log.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ t: '2026-11-21T00:00:00.000Z', level: 'warn', projectId: 'p1' });
  });

  it('writes a zip whose entries read back', () => {
    const zip = buildZip([
      { name: 'logs/a.txt', data: 'hello '.repeat(200) },
      { name: 'info.json', data: Buffer.from('{}') },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    // First entry: deflated, and it inflates to what went in.
    const method = zip.readUInt16LE(8);
    const compressed = zip.readUInt32LE(18);
    const nameLen = zip.readUInt16LE(26);
    const body = zip.subarray(30 + nameLen, 30 + nameLen + compressed);
    expect(method).toBe(8);
    expect(inflateRawSync(body).toString()).toBe('hello '.repeat(200));
  });
});
