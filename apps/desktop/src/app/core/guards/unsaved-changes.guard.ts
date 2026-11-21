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
  /** What would be lost, in words, for the prompt (a generic sentence without it). */
  unsavedChangesList?(): string[];
}

/**
 * Ask before throwing away unsaved work.
 *
 * WHY: leaving a screen drops what only a button saves, with no prompt and no
 * autosave. In the editor that is the project settings draft (applied by a
 * re-dub), the character sheet and the greeting times. The guard used to ask
 * about the line edits instead, which save themselves (anything changed in
 * the last half second, flushed as the editor closes), and say nothing about
 * those drafts: the prompt came when nothing was at risk, and not when
 * something was. The screen decides what counts; the prompt names it.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (
  component,
): Promise<boolean> => {
  if (!component?.hasUnsavedChanges?.()) return true;
  const confirm = inject(ConfirmService);
  const translate = inject(TranslateService);
  const what = component.unsavedChangesList?.() ?? [];
  return confirm.confirm({
    title: translate.instant('confirm.discard-edits-title'),
    message:
      what.length > 0
        ? translate.instant('confirm.discard-drafts-body', { what: what.join(', ') })
        : translate.instant('confirm.discard-edits-body'),
    confirmLabel: translate.instant('confirm.discard-edits-confirm'),
    danger: true,
  });
};
