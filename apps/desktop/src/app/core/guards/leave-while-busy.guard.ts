import { inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';

import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { TranslateService } from '../i18n';

/**
 * A screen doing work that leaving it would interrupt or hide.
 *
 * Implemented by the New project form; an interface so this guard never
 * imports a screen (which would defeat its lazy loading).
 */
export interface LeaveWhileBusy {
  /**
   * The question to ask before leaving now, as translation keys (title, body,
   * and the two buttons), or null when leaving is fine.
   */
  leaveWarning(): { title: string; message: string; leave: string; stay: string } | null;
}

/**
 * Ask before leaving a screen in the middle of its work.
 *
 * WHY: Continue on the New project form copies the video into the project,
 * which takes a while for a long one, and the top navigation stayed live.
 * Leaving then cleared the form the user had kept, or a restored copy of it
 * made a second project (and a second copy of the video) — and an Ollama
 * download finishing later pulled the user to the dub's screen from wherever
 * they had gone (UX audit, 2026-11-21). Leaving stays the user's choice: the
 * work goes on, and the form tells them how it ended.
 */
export const leaveWhileBusyGuard: CanDeactivateFn<LeaveWhileBusy> = async (component): Promise<boolean> => {
  const warning = component?.leaveWarning?.();
  if (!warning) return true;
  const confirm = inject(ConfirmService);
  const translate = inject(TranslateService);
  return confirm.confirm({
    title: translate.instant(warning.title),
    message: translate.instant(warning.message),
    confirmLabel: translate.instant(warning.leave),
    cancelLabel: translate.instant(warning.stay),
    danger: false,
  });
};
