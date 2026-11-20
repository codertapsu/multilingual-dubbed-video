/**
 * Where a project's finished files go, and what they are called.
 *
 * Each project saves its finished video and subtitle files in its own output
 * folder: the app's project folder by default (`…/<project>/render/output.mp4`),
 * or a folder the user chose for it. A chosen folder may be shared with other
 * projects (D:\Dubs), so there the files are named after the project and its
 * language ("My video.vi.mp4"), and the name is fixed when the folder is
 * chosen so two projects never overwrite each other's video. The orchestrator,
 * the MCP server and the UI all derive the paths here, so they agree.
 *
 * Browser-safe: no node:path (the UI imports it too).
 */
import type { Project } from '../models/domain.js';

/**
 * The video, then the subtitle sidecars the render step may write beside it,
 * and the post's thumbnail. Every one of them moves with the video when the
 * folder changes, and counts when a name is checked for being taken there.
 */
export const PROJECT_OUTPUT_EXTENSIONS = ['.mp4', '.srt', '.vtt', '.jpg'] as const;

/** The base name of the finished files: the chosen-folder name, else "output". */
export function projectOutputBaseName(project: Pick<Project, 'outputFileName'>): string {
  return project.outputFileName?.trim() || 'output';
}

/** `dir` + `name`, with the separator the folder path already uses. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** The finished video of a project. */
export function projectOutputVideoPath(project: Pick<Project, 'outputDir' | 'outputFileName'>): string {
  return joinPath(project.outputDir, `${projectOutputBaseName(project)}.mp4`);
}

/** The finished video's thumbnail: a picture for a post (get_outputs), beside the video. */
export function projectOutputThumbnailPath(project: Pick<Project, 'outputDir' | 'outputFileName'>): string {
  return joinPath(project.outputDir, `${projectOutputBaseName(project)}.jpg`);
}

/** Every file a render of this project may write in its output folder (video first). */
export function projectOutputFiles(project: Pick<Project, 'outputDir' | 'outputFileName'>): string[] {
  const base = projectOutputBaseName(project);
  return PROJECT_OUTPUT_EXTENSIONS.map((ext) => joinPath(project.outputDir, `${base}${ext}`));
}

/**
 * A file-name stem from a project name: no character Windows or macOS refuses
 * in a file name, no trailing dot or space, not a reserved device name, and
 * not too long. "video" when nothing usable is left.
 */
export function safeFileStem(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const stem = cleaned.slice(0, 120).trim() || 'video';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `${stem}_` : stem;
}

/**
 * The base name for a project's files in a chosen folder: "<name>.<lang>",
 * or "<name> (2).<lang>"… when `taken` says the name is used there.
 */
export function chosenOutputBaseName(
  projectName: string,
  targetLanguage: string,
  taken: (baseName: string) => boolean,
): string {
  const stem = safeFileStem(projectName);
  const lang = targetLanguage.split('-')[0]!.toLowerCase() || 'dub';
  for (let n = 1; n < 1000; n++) {
    const base = n === 1 ? `${stem}.${lang}` : `${stem} (${n}).${lang}`;
    if (!taken(base)) return base;
  }
  return `${stem}.${lang}.${Date.now()}`;
}
