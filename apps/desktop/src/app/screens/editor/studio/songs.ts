/**
 * Lines kept as the original song, from the editor (plan 6.2): the
 * inspector's button and the Songs block go through here. A mark is applied
 * at once on the server (it may split a voice clip the line shared, which an
 * undo of the line fields could not put back), so it is not part of the
 * editor's undo history: marking again undoes it, and the project's edit
 * history records it.
 */
import type { IpcService } from '../../../core/ipc/ipc.service';
import type { SongReason } from '../../../core/ipc/cast-songs.types';
import { toAppError } from '../../../core/state/project.store';
import type { StudioStore } from './studio.store';

/** Why the app thinks a line is sung: the chip's label and its explanation. */
export const SONG_REASON_KEYS: Record<SongReason, { label: string; title: string }> = {
  traditional: { label: 'songs.reason.traditional', title: 'songs.reason.traditional-title' },
  repeats: { label: 'songs.reason.repeats', title: 'songs.reason.repeats-title' },
  sung: { label: 'songs.reason.sung', title: 'songs.reason.sung-title' },
};

/**
 * What the song button does for these lines: keep them as the original song
 * when any of them is spoken, dub them again when all are songs. Pure.
 */
export function songActionFor(lines: readonly { song?: boolean }[]): 'keep' | 'dub' | null {
  if (lines.length === 0) return null;
  return lines.every((l) => l.song === true) ? 'dub' : 'keep';
}

/** The lines a re-voice may ask for: never a song line, which has no voice. Pure. */
export function voicedOnly(ids: readonly string[], lines: readonly { id: string; song?: boolean }[]): string[] {
  const songs = new Set(lines.filter((l) => l.song === true).map((l) => l.id));
  return ids.filter((id) => !songs.has(id));
}

/**
 * Keep `ids` as the original song (song=true) or dub them again: the edits
 * waiting to be saved go first (the server refuses a mark on lines it has
 * not seen), the timeline is read again after. On a series (the project its
 * parts were made from) the parts get the same marks, by time: their lines
 * are the series' lines. Null when it did not happen (the error is shown by
 * the store).
 */
export async function markSongLines(
  store: Pick<StudioStore, 'flushNow' | 'reload' | 'projectId' | 'error' | 'dubRunning' | 'project'>,
  ipc: Pick<IpcService, 'markSongs'>,
  ids: readonly string[],
  song: boolean,
): Promise<{ changed: { id: string }[]; revoice: string[] } | null> {
  if (ids.length === 0 || store.dubRunning()) return null;
  try {
    if (!(await store.flushNow())) return null;
    const series = store.project()?.series?.role === 'parent';
    const res = await ipc.markSongs(store.projectId(), { lineIds: [...ids], song, ...(series ? { applyToParts: true } : {}) });
    await store.reload();
    return res;
  } catch (err) {
    store.error.set(toAppError(err));
    return null;
  }
}
