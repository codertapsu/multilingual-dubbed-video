import { Injectable, computed, signal } from '@angular/core';

/** What the user picked. `system` follows the OS (prefers-color-scheme). */
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'vd.theme';

/**
 * App-wide light/dark theme.
 *
 * The tokens live in styles.scss; this only decides which set applies, by
 * writing `data-theme` on <html> (absent = follow the OS). The choice is kept
 * in localStorage like the UI language, so it is applied before the first
 * screen renders — no flash of the wrong theme on launch.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(readStored());
  private readonly osDark = signal(mediaDark());
  readonly preference = this._preference.asReadonly();

  /** The theme actually in effect. */
  readonly effective = computed<'light' | 'dark'>(() => {
    const pref = this._preference();
    return pref === 'system' ? (this.osDark() ? 'dark' : 'light') : pref;
  });

  constructor() {
    apply(this._preference());
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', (e) => this.osDark.set(e.matches));
    }
  }

  use(pref: ThemePreference): void {
    this._preference.set(pref);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* storage unavailable (private mode): the choice lasts this session */
    }
    apply(pref);
  }

  /** Cycle system → light → dark (the top-bar toggle). */
  cycle(): void {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    this.use(order[(order.indexOf(this._preference()) + 1) % order.length]!);
  }
}

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function mediaDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function apply(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
}
