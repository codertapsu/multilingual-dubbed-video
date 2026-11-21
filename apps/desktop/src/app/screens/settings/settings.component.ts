import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { packsOfFamily, variantLabelOf } from './engine-families';
import { searchSettings, type SettingsSearchEntry } from './settings-search';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_OPTIONS,
  SETTINGS_SECTIONS,
  isSettingsSection,
  settingsSection,
  type SettingsSectionId,
} from './settings-sections';
import { SettingsStore } from './settings.store';
import { AdvancedSectionComponent } from './sections/advanced-section.component';
import { AudioSectionComponent } from './sections/audio-section.component';
import { ClaudeSectionComponent } from './sections/claude-section.component';
import { CloudSectionComponent } from './sections/cloud-section.component';
import { DiagnosticsSectionComponent } from './sections/diagnostics-section.component';
import { DownloadsSectionComponent } from './sections/downloads-section.component';
import { DubbingSectionComponent } from './sections/dubbing-section.component';
import { EnginesSectionComponent } from './sections/engines-section.component';
import { GeneralSectionComponent } from './sections/general-section.component';
import { PerformanceSectionComponent } from './sections/performance-section.component';
import { StorageSectionComponent } from './sections/storage-section.component';
import { SttSectionComponent } from './sections/stt-section.component';
import { TranslationSectionComponent } from './sections/translation-section.component';
import { TtsSectionComponent } from './sections/tts-section.component';

/**
 * SettingsComponent (route "settings/:section"): the navigation, the search
 * box and the section that is open.
 *
 * Settings used to be one page of thirteen cards; it is now sections in a left
 * navigation (settings-sections.ts has the map and the reasons), each page
 * with a one-line explanation, a reset where the defaults are known, and a
 * search over every option in the user's language. The sections share their
 * data through {@link SettingsStore}, provided here, so an engine install
 * started on one page keeps its progress on the next.
 *
 * Links reach an option directly: `/settings/<section>#<anchor>` scrolls to it
 * and marks it, and the old single-page anchors (`/settings#brand-kit`) are
 * sent to their section by the route (app.routes.ts).
 */
@Component({
  selector: 'vd-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SettingsStore],
  imports: [
    FormsModule,
    RouterLink,
    TranslatePipe,
    ErrorBannerComponent,
    GeneralSectionComponent,
    DubbingSectionComponent,
    EnginesSectionComponent,
    SttSectionComponent,
    TranslationSectionComponent,
    TtsSectionComponent,
    AudioSectionComponent,
    CloudSectionComponent,
    ClaudeSectionComponent,
    DownloadsSectionComponent,
    PerformanceSectionComponent,
    StorageSectionComponent,
    DiagnosticsSectionComponent,
    AdvancedSectionComponent,
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  /** The `:section` route parameter (component input binding). */
  readonly section = input<string | undefined>(undefined);

  protected readonly store = inject(SettingsStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly sections = SETTINGS_SECTIONS;

  /** The open section; an unknown one opens General. */
  protected readonly active = computed<SettingsSectionId>(() => {
    const s = this.section();
    return isSettingsSection(s) ? s : DEFAULT_SETTINGS_SECTION;
  });
  protected readonly activeDef = computed(() => settingsSection(this.active()));
  /** The section the open one sits under (Engines & models), for the breadcrumb. */
  protected readonly parentDef = computed(() => {
    const parent = this.activeDef().parent;
    return parent ? settingsSection(parent) : null;
  });

  // ------------------------------------------------------------------ search
  protected readonly query = signal('');

  /**
   * Everything the search box can find, in the user's language: every option
   * of SETTINGS_OPTIONS, every section by name, and every engine pack under its
   * family. Recomputed on a language switch (instant() reads the locale).
   */
  private readonly searchIndex = computed<SettingsSearchEntry[]>(() => {
    const t = (key: string) => this.translate.instant(key);
    const sectionTitle = (id: SettingsSectionId) => t(settingsSection(id).titleKey);
    const entries: SettingsSearchEntry[] = SETTINGS_SECTIONS.map((s) => ({
      anchor: '',
      section: s.id,
      title: t(s.titleKey),
      hint: t(s.introKey),
    }));
    for (const o of SETTINGS_OPTIONS) {
      entries.push({
        anchor: o.anchor,
        section: o.section,
        title: t(o.titleKey),
        ...(o.hintKey ? { hint: t(o.hintKey) } : {}),
        keywords: `${sectionTitle(o.section)} ${o.keywords ?? ''}`,
      });
    }
    for (const family of this.store.families()) {
      const key = `settings.families.${family.id}.title`;
      const familyTitle = t(key) === key ? '' : t(key);
      // "TranslateGemma · 12B", but "Gemma 3 12B" alone: its name carries the family's.
      const brand = familyTitle.split(/[\s(]/)[0]?.toLowerCase() ?? '';
      const packs = packsOfFamily(family);
      for (const pack of packs) {
        const label = variantLabelOf(pack);
        const accelKey = `settings.accel.${pack.accel}`;
        const title =
          pack.packKind !== 'model'
            ? `${label} · ${t(accelKey) === accelKey ? pack.accel : t(accelKey)}`
            : brand && !label.toLowerCase().startsWith(brand)
              ? `${familyTitle.split(' (')[0]} · ${label}`
              : label;
        const installed = this.store.isEngineInstalled(pack.id);
        entries.push({
          anchor: `pack-${pack.id}`,
          section: family.page,
          title,
          hint: `${familyTitle} · ${t(installed ? 'settings.engines.installed' : 'settings.variant.not-installed')} · ${this.store.sizeLabel(pack.approxSizeMb)}`,
          keywords: `${sectionTitle(family.page)} ${pack.displayName} ${pack.id} ${pack.accel} ${pack.description}`,
        });
      }
    }
    return entries;
  });

  protected readonly results = computed(() => searchSettings(this.searchIndex(), this.query()));
  protected readonly searching = computed(() => this.query().trim().length > 0);

  // ------------------------------------------------------------------- reset
  protected readonly resetting = signal(false);
  protected readonly resetDone = signal(false);
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  /** Move focus to the page title after a section is chosen (not on first load). */
  private focusTitleOnChange = false;

  constructor() {
    effect(() => {
      this.active();
      untracked(() => {
        this.resetDone.set(false);
        // An error belongs to the page it happened on (a pack that failed on
        // Speech-to-text); following the user to the next page, it reads as
        // that page's failure.
        this.store.error.set(null);
        if (this.focusTitleOnChange) {
          this.focusTitleOnChange = false;
          setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.section-title')?.focus(), 0);
        }
      });
    });
    this.destroyRef.onDestroy(() => {
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.cancelScroll?.();
    });
  }

  ngOnInit(): void {
    this.store.init();
    // `/settings/<section>#<anchor>`: scroll to the option and mark it. The
    // section's data arrives after it renders, so the target is waited for.
    this.route.fragment.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((fragment) => {
      if (fragment) this.scrollToAnchor(fragment);
    });
  }

  protected onNavClick(): void {
    this.focusTitleOnChange = true;
    this.query.set('');
  }

  /** Arrow keys move between the navigation's links (Home/End to the ends). */
  protected onNavKeydown(event: KeyboardEvent): void {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const links = Array.from(this.host.nativeElement.querySelectorAll<HTMLAnchorElement>('.settings-nav a'));
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? links.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(links.length - 1, at + 1)
            : Math.max(0, at < 0 ? 0 : at - 1);
    event.preventDefault();
    links[next]?.focus();
  }

  protected sectionTitleKey(id: SettingsSectionId): string {
    return settingsSection(id).titleKey;
  }

  protected clearSearch(): void {
    this.query.set('');
  }

  /** Enter in the search box opens the first result. */
  protected openFirstResult(): void {
    const first = this.results()[0];
    if (first) this.openResult(first);
  }

  protected openResult(entry: SettingsSearchEntry): void {
    this.query.set('');
    this.focusTitleOnChange = !entry.anchor;
    void this.router.navigate(['/settings', entry.section], entry.anchor ? { fragment: entry.anchor } : {});
    // Navigating to the same fragment twice emits nothing: scroll anyway.
    if (entry.anchor && entry.section === this.active()) this.scrollToAnchor(entry.anchor);
  }

  protected async reset(): Promise<void> {
    if (this.resetting()) return;
    this.resetting.set(true);
    try {
      const done = await this.store.resetSection(this.active());
      if (done) {
        this.resetDone.set(true);
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => this.resetDone.set(false), 4000);
      }
    } finally {
      this.resetting.set(false);
    }
  }

  private cancelScroll: (() => void) | null = null;

  /**
   * Bring an option into view and mark it for a moment. The element may not
   * exist yet (the engine cards render once the packs have loaded), so this
   * looks for it for a few seconds. Focus moves there too, for the keyboard
   * and screen readers; the mark is an animation, not a class, because the
   * option lives in a section component whose styles this one cannot reach.
   */
  private scrollToAnchor(anchor: string): void {
    this.cancelScroll?.();
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (): void => {
      const el = document.getElementById(anchor);
      if (!el || !this.host.nativeElement.contains(el)) {
        if (++tries < 40) timer = setTimeout(attempt, 100);
        return;
      }
      this.cancelScroll = null;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduce && typeof el.animate === 'function') {
        const color = getComputedStyle(document.documentElement).getPropertyValue('--vd-primary').trim() || '#2563eb';
        el.animate(
          [{ boxShadow: `0 0 0 3px ${color}` }, { boxShadow: `0 0 0 3px ${color}`, offset: 0.6 }, { boxShadow: '0 0 0 0 transparent' }],
          { duration: 1800, easing: 'ease-out' },
        );
      }
    };
    this.cancelScroll = () => {
      if (timer) clearTimeout(timer);
      this.cancelScroll = null;
    };
    attempt();
  }
}
