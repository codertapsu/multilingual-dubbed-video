import { effect, inject, Injectable, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';

import { TranslateService } from '../i18n';
import { windowTitle } from './window-title';

/**
 * Window titles in the user's language.
 *
 * Every route's `title` was an English literal ("VideoDubber — Download source
 * video") whatever language the user chose, and Angular's default strategy
 * writes the title once per navigation, so even a translated one would have
 * stayed in the old language after a switch in Settings until the next
 * navigation. The routes carry i18n keys (`nav.title.*`, app.routes.ts); this
 * resolves the deepest route's, and writes the title again whenever the
 * locale changes.
 */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly i18n = inject(TranslateService);
  /** The active route's title key (undefined on a route without one). */
  private readonly pageKey = signal<string | undefined>(undefined);

  constructor() {
    super();
    // instant() reads the active locale, so a language switch runs this again.
    effect(() => this.title.setTitle(windowTitle(this.pageKey(), (key) => this.i18n.instant(key))));
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.pageKey.set(this.buildTitle(snapshot));
  }
}
