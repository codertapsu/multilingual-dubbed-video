import { Pipe, inject, type PipeTransform } from '@angular/core';

import { TranslateService, type TranslateParams } from './translate.service';

/**
 * `{{ 'nav.projects' | translate }}` — and with placeholders,
 * `{{ 'queue.position' | translate: { n: 3 } }}`.
 *
 * IMPURE, on purpose. A pure pipe memoizes on its ARGUMENTS, so when the user
 * switches language the key is unchanged and Angular would serve the cached
 * string forever — the UI would keep the old language until a reload. (Reading
 * the locale signal inside `transform` does not save a pure pipe here: this app
 * runs zone-based change detection, so nothing re-invokes the pipe.)
 *
 * The cost of impure is that `transform` runs on every change-detection cycle,
 * so it memoizes internally on (key, params, locale) and returns the cached
 * string after a cheap comparison. Only an actual language switch or a changed
 * parameter does real work.
 */
@Pipe({ name: 'translate', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  private lastKey: string | null | undefined;
  private lastParamsJson: string | null = null;
  private lastLocale: string | null = null;
  private lastValue = '';

  transform(key: string | null | undefined, params?: TranslateParams): string {
    if (!key) return '';
    const locale = this.translate.locale();
    // Most bindings pass no params, so this is a null check rather than a
    // stringify on the hot path.
    const paramsJson = params ? JSON.stringify(params) : null;
    if (key === this.lastKey && locale === this.lastLocale && paramsJson === this.lastParamsJson) {
      return this.lastValue;
    }
    this.lastKey = key;
    this.lastLocale = locale;
    this.lastParamsJson = paramsJson;
    this.lastValue = this.translate.instant(key, params);
    return this.lastValue;
  }
}
