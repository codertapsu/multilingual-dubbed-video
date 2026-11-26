/**
 * The per-line translation checks' findings (lineQuality.ts in the
 * orchestrator) as the editor names them: a short label and its explanation.
 * Shared by the inspector and the lines list, which shows why a line is
 * flagged right on its row (H7). Pure.
 */
import type { LineQualityFlag } from '../../../core/models';

export const QUALITY_LABELS: Readonly<Record<LineQualityFlag, { label: string; title: string }>> = {
  untranslated: { label: 'editor.untranslated', title: 'editor.untranslated-title' },
  'wrong-script': { label: 'editor.quality.wrong-script', title: 'editor.quality.wrong-script-title' },
  pinyin: { label: 'editor.quality.pinyin', title: 'editor.quality.pinyin-title' },
  alternatives: { label: 'editor.quality.alternatives', title: 'editor.quality.alternatives-title' },
  'no-diacritics': { label: 'editor.quality.no-diacritics', title: 'editor.quality.no-diacritics-title' },
};
