import { inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';

import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { TranslateService } from '../i18n';

/**
 * A screen that holds edits the user has not committed yet.
 *
 * Implemented by {@link EditorComponent}; kept as an interface so the guard
 * never has to import a screen (which would defeat its lazy loading).
 */
export interface HasUnsavedChanges {
  /** True when leaving now would discard something the user typed. */
  hasUnsavedChanges(): boolean;
}

/**
 * Ask before throwing away unsaved work.
 *
 * WHY: the editor keeps translation edits in a draft buffer that is only
 * written by Save. Every other exit — the top nav, "Re-dub from…", the browser
 * back gesture — dropped them on the floor with no prompt and no autosave, and
 * on a long transcript that is a lot of typing. Confirming is the cheap fix;
 * the buffer itself stays the source of truth so nothing is written behind the
 * user's back either.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (
  component,
): Promise<boolean> => {
  if (!component?.hasUnsavedChanges?.()) return true;
  const confirm = inject(ConfirmService);
  const translate = inject(TranslateService);
  return confirm.confirm({
    title: translate.instant('confirm.discard-edits-title'),
    message: translate.instant('confirm.discard-edits-body'),
    confirmLabel: translate.instant('confirm.discard-edits-confirm'),
    danger: true,
  });
};
