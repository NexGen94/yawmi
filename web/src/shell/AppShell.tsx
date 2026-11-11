import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { installShortcuts } from '../lib/keys';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** After a route change (the lazy page loaded and rendered), focus moves to the page heading so a
 *  screen reader starts on the new page. The main region takes focus when a page has no <h1>. */
export function focusPageHeading(): void {
  const main = document.getElementById('main');
  const heading = main?.querySelector<HTMLElement>('h1') ?? main;
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

export function AppShell(props: { children?: ComponentChildren }) {
  const { path } = useLocation();

  useEffect(() => installShortcuts(), []);

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
    </div>
  );
}
