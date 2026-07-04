import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectInstalledModels } from './detectInstalledModels.js';

describe('detectInstalledModels', () => {
  let modelsDir: string;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'vd-detect-'));
  });
  afterEach(async () => {
    await rm(modelsDir, { recursive: true, force: true });
  });

  const dirs = () => ({ modelsDir, whisperCacheDir: path.join(modelsDir, 'huggingface') });

  it('returns nothing for empty/missing model dirs', async () => {
    const found = await detectInstalledModels(dirs());
    expect(found).toEqual({ whisperModels: [], argosPairs: [], piperVoices: [] });
  });

  it('detects the bundled default set seeded on disk', async () => {
    // whisper 'small' hub-cache layout (a snapshot blob present)
    const whisper = path.join(modelsDir, 'huggingface', 'models--Systran--faster-whisper-small', 'blobs');
    await mkdir(whisper, { recursive: true });
    await writeFile(path.join(whisper, 'abc123'), 'x');
    // argos en->vi installed package (with the model payload)
    const argos = path.join(modelsDir, 'argos', 'translate-en_vi-1_9', 'model');
    await mkdir(argos, { recursive: true });
    await writeFile(path.join(argos, 'model.bin'), 'x');
    // vi Piper voice (.onnx + paired .onnx.json)
    const piper = path.join(modelsDir, 'piper');
    await mkdir(piper, { recursive: true });
    await writeFile(path.join(piper, 'vi_VN-vais1000-medium.onnx'), 'x');
    await writeFile(path.join(piper, 'vi_VN-vais1000-medium.onnx.json'), '{}');

    const found = await detectInstalledModels(dirs());
    expect(found.whisperModels).toEqual(['small']);
    expect(found.argosPairs).toEqual([{ from: 'en', to: 'vi' }]);
    expect(found.piperVoices).toEqual(['vi_VN-vais1000-medium']);
  });

  it('ignores half-written models (no payload)', async () => {
    // whisper dir with no blobs; argos dir with no model; .onnx with no config
    await mkdir(path.join(modelsDir, 'huggingface', 'models--Systran--faster-whisper-small'), { recursive: true });
    await mkdir(path.join(modelsDir, 'argos', 'translate-en_vi-1_9'), { recursive: true });
    const piper = path.join(modelsDir, 'piper');
    await mkdir(piper, { recursive: true });
    await writeFile(path.join(piper, 'orphan.onnx'), 'x'); // no .onnx.json

    const found = await detectInstalledModels(dirs());
    expect(found).toEqual({ whisperModels: [], argosPairs: [], piperVoices: [] });
  });
});
