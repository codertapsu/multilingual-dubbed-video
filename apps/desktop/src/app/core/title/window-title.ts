/** What the window is called on a screen without a title of its own. */
export const APP_NAME = 'VideoDubber';

/**
 * The window title for a route's title key ("VideoDubber — Tải video"). A key
 * the locales lack comes back from `translate` as itself, and the app's name
 * beats "nav.title.download" in the title bar and the taskbar. Pure.
 */
export function windowTitle(pageKey: string | undefined, translate: (key: string) => string): string {
  if (!pageKey) return APP_NAME;
  const page = translate(pageKey);
  return page && page !== pageKey ? `${APP_NAME} — ${page}` : APP_NAME;
}
