import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { onUnauthorized } from '../api/auth';
import { installShortcuts } from '../lib/keys';
import { navigate } from '../lib/navigate';
import { AskDrawer } from './AskDrawer';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** Keeps document.title in sync with the current page heading: «<page name> · يومي». */
export function syncPageTitle(): void {
  const title = document.getElementById('main')?.querySelector('h1')?.textContent?.trim();
  document.title = title ? `${title} · يومي` : 'يومي';
}

/** After a route change (the lazy page loaded and rendered), focus moves to the page heading so a
 *  screen reader starts on the new page, unless focus is still inside #main (same-page sub-routes). */
export function focusPageHeading(): void {
  syncPageTitle();
  const main = document.getElementById('main');
  if (!main) return;
  const active = document.activeElement;
  if (active && active !== main && main.contains(active)) return;
  const heading = main.querySelector<HTMLElement>('h1') ?? main;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

export function AppShell(props: { children?: ComponentChildren }) {
  const { path } = useLocation();

  useEffect(() => installShortcuts(), []);
  useEffect(() => onUnauthorized(() => navigate('/pair')), []);
  useEffect(() => {
    syncPageTitle();
  }, [path]);

  const skip = (event: MouseEvent): void => {
    event.preventDefault();
    document.getElementById('main')?.focus();
  };

  return (
    <div class="shell">
      <a class="skip-link" href="#main" onClick={skip}>
        تخطي إلى المحتوى
      </a>
      <Sidebar path={path} />
      <div class="shell-body">
        <TopBar />
        <main id="main" class="page" tabIndex={-1}>
          {props.children}
        </main>
      </div>
      <AskDrawer />
    </div>
  );
}
