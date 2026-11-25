import { describe, expect, it } from 'vitest';
import {
  chosenOutputBaseName,
  projectOutputBaseName,
  projectOutputFiles,
  projectOutputThumbnailPath,
  projectOutputVideoPath,
  resolveOutputDir,
  safeFileStem,
} from './output.js';

describe('where a project saves its finished files', () => {
  it('is render/output.* in the default folder', () => {
    const project = { outputDir: '/home/me/VideoDubber/projects/p1/render' };
    expect(projectOutputBaseName(project)).toBe('output');
    expect(projectOutputVideoPath(project)).toBe('/home/me/VideoDubber/projects/p1/render/output.mp4');
  });

  it('is named after the project in a chosen folder, video first then subtitles and the thumbnail', () => {
    const project = { outputDir: '/Users/me/Dubs/', outputFileName: 'My video.vi' };
    expect(projectOutputFiles(project)).toEqual([
      '/Users/me/Dubs/My video.vi.mp4',
      '/Users/me/Dubs/My video.vi.srt',
      '/Users/me/Dubs/My video.vi.vtt',
      '/Users/me/Dubs/My video.vi.jpg',
    ]);
    expect(projectOutputThumbnailPath(project)).toBe('/Users/me/Dubs/My video.vi.jpg');
    expect(projectOutputThumbnailPath({ outputDir: String.raw`D:\P\render` })).toBe(String.raw`D:\P\render\output.jpg`);
  });

  it('keeps a Windows folder path in its own separators (the UI shows it as the user knows it)', () => {
    expect(projectOutputVideoPath({ outputDir: 'D:\\Dubs\\', outputFileName: 'Clip.vi' })).toBe('D:\\Dubs\\Clip.vi.mp4');
  });
});

describe('resolveOutputDir', () => {
  it('fills {series} or {name} with the job name as a folder name, and leaves other folders as they are', () => {
    expect(resolveOutputDir(String.raw`D:\Dubs\{series}`, 'Tiệm phim: Phần 1/2')).toBe(String.raw`D:\Dubs\Tiệm phim Phần 1 2`);
    expect(resolveOutputDir('/Users/me/Dubs/{NAME}/final', 'Clip')).toBe('/Users/me/Dubs/Clip/final');
    expect(resolveOutputDir(String.raw`D:\Dubs`, 'Clip')).toBe(String.raw`D:\Dubs`);
    expect(resolveOutputDir('/Dubs/{series}', '  ')).toBe('/Dubs/video');
  });
});

describe('safeFileStem', () => {
  it('drops what Windows or macOS refuse in a file name', () => {
    expect(safeFileStem('Trip: day 1/2 <final>?')).toBe('Trip day 1 2 final');
    expect(safeFileStem('tab\there\u0007')).toBe('tab here');
  });

  it('never ends in a dot or space, and is never a device name or empty', () => {
    expect(safeFileStem('Episode 3...  ')).toBe('Episode 3');
    expect(safeFileStem('CON')).toBe('CON_');
    expect(safeFileStem('lpt1')).toBe('lpt1_');
    expect(safeFileStem(' ?*: ')).toBe('video');
  });

  it('keeps Vietnamese and other letters, in one Unicode form', () => {
    expect(safeFileStem('Phim hoạt hình')).toBe('Phim hoạt hình');
    // "ạ" typed decomposed (a + combining dot below) is stored composed.
    expect(safeFileStem('ho\u0061\u0323t')).toBe('ho\u1ea1t');
  });

  it('is at most 120 characters', () => {
    expect(safeFileStem('x'.repeat(300))).toHaveLength(120);
  });
});

describe('chosenOutputBaseName', () => {
  it('is "<name>.<language>", with the base language only', () => {
    expect(chosenOutputBaseName('My video', 'vi-VN', () => false)).toBe('My video.vi');
    expect(chosenOutputBaseName('My video', 'EN', () => false)).toBe('My video.en');
  });

  it('numbers the name when another project already saved under it', () => {
    const taken = new Set(['Clip.vi', 'Clip (2).vi']);
    expect(chosenOutputBaseName('Clip', 'vi', (b) => taken.has(b))).toBe('Clip (3).vi');
  });
});
