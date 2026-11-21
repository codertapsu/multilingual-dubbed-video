import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

import { isTextEntry, planReveal, revealAllowed, type FocusedElementLike } from './error-view';

/** How much of a banner must be on screen to count as seen: its title line. */
const HEAD_PX = 48;

/**
 * Brings error banners into view, one at a time (error-view.ts `planReveal`
 * has the rules). Banners ask for it when they appear or their error changes;
 * all that ask in the same render are decided together, because a page can
 * show several at once (Settings: one at the top, one under each pack, model
 * and language pair) and each scrolling to itself would leave the page at
 * whichever came last. It also keeps the two times the rules need: when the
 * user arrived on the page, and when they last clicked or typed.
 */
@Injectable({ providedIn: 'root' })
export class ErrorRevealService {
  /** Created with the first banner, which is part of the page the user just arrived on. */
  private navigatedAt = Date.now();
  private gestureAt = 0;
  private readonly pending = new Set<HTMLElement>();
  private flushQueued = false;

  constructor() {
    inject(Router).events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.navigatedAt = Date.now();
    });
    const touched = (): void => {
      this.gestureAt = Date.now();
    };
    document.addEventListener('pointerdown', touched, { capture: true, passive: true });
    document.addEventListener('keydown', touched, { capture: true, passive: true });
  }

  /** A banner appeared, or its error changed: consider it with the others of this render. */
  request(banner: HTMLElement): void {
    this.pending.add(banner);
    if (this.flushQueued) return;
    this.flushQueued = true;
    // After the render that showed it: every banner of that render has asked by then.
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    const banners = [...this.pending].filter((el) => el.isConnected).sort(byDocumentOrder);
    this.pending.clear();
    const first = banners[0];
    if (!first) return;
    const doc = first.ownerDocument;
    const active = doc.activeElement;
    const modals = Array.from(doc.querySelectorAll('[aria-modal="true"]'));
    const plan = planReveal(
      banners.map((el) => ({
        visible: headVisible(el),
        behindModal: modals.length > 0 && !modals.some((m) => m.contains(el)),
      })),
      {
        allowed: revealAllowed({ now: Date.now(), navigatedAt: this.navigatedAt, gestureAt: this.gestureAt }),
        readingBanner: !!active?.closest('.error-banner'),
        typing: isTextEntry(active as FocusedElementLike | null),
      },
    );
    const target = plan ? banners[plan.index] : undefined;
    if (!plan || !target) return;
    if (plan.scroll) {
      const reduceMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      target.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    // preventScroll: focusing would otherwise jump there at once, cutting the smooth scroll short.
    if (plan.focus) target.focus({ preventScroll: true });
  }
}

function byDocumentOrder(a: Node, b: Node): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** The banner's title line is on screen: inside the window and every clipping box around it. */
function headVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const view = el.ownerDocument.defaultView;
  let top = 0;
  let bottom = view?.innerHeight ?? 0;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (view?.getComputedStyle(p).overflowY === 'visible') continue;
    const box = p.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return rect.top >= top && rect.top + Math.min(rect.height, HEAD_PX) <= bottom;
}
