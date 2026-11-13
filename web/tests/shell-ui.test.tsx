// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as appModule from '../src/app';
import { App } from '../src/app';
import { onAskOpen, openAsk } from '../src/ask/controller';
import { installShortcuts } from '../src/lib/keys';
import { navigate } from '../src/lib/navigate';
import HomePage from '../src/pages/home';
import { AppShell, focusPageHeading } from '../src/shell/AppShell';
import { ConnectionStatus } from '../src/shell/ConnectionStatus';
import { NAV } from '../src/shell/nav';
import { UpdatePrompt } from '../src/shell/UpdatePrompt';

// The four groups and nine items of design section 3, verbatim.
const EXPECTED_NAV = [
  { label: 'يومي', items: [['الرئيسية', '/'], ['اليوم', '/day']] },
  { label: 'التقدّم', items: [['العادات', '/habits'], ['الأهداف', '/goals'], ['المراجعة', '/review']] },
  { label: 'الجلسات', items: [['التركيز', '/focus'], ['التنفّس', '/breath']] },
  { label: 'أخرى', items: [['اسأل', '/ask'], ['الإعدادات', '/settings']] },
];

const go = (path: string): void => history.replaceState(null, '', path);

/** Counts openAsk() calls through the public subscription for the length of one test. */
function countAsk(): { count: () => number; stop: () => void } {
  let n = 0;
  const stop = onAskOpen(() => {
    n += 1;
  });
  return { count: () => n, stop };
}

// The home page reads the API. These tests are about the shell, so the network is simply down.
beforeEach(() => {
  go('/');
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
});
afterEach(() => vi.unstubAllGlobals());

describe('NAV (shell/nav.ts)', () => {
  it('has the four groups of design section 3 with their nine items and routes, in order', () => {
    expect(NAV.map((g) => ({ label: g.label, items: g.items.map((i) => [i.label, i.href]) }))).toEqual(EXPECTED_NAV);
  });
});

describe('the app shell', () => {
  it('renders one navigation landmark with an Arabic name, nine links in four labelled groups', () => {
    render(<App />);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
    for (const group of EXPECTED_NAV) {
      const list = within(nav).getByRole('list', { name: group.label });
      expect(within(list).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(group.items);
    }
  });

  it('puts the brand, the navigation and the connection state inside one landmark (axe region, Task 9 M-3)', () => {
    render(<App />);
    const side = screen.getByRole('complementary', { name: 'الشريط الجانبي' });
    expect(side.querySelector('.brand')).not.toBeNull();
    expect(within(side).getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeTruthy();
    expect(side.querySelector('.connection')).not.toBeNull();
  });

  it('shows no navigation on the pairing page: every item would lead back to it (Task 24)', async () => {
    go('/pair');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'الإقران' });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'الشريط الجانبي' }).querySelector('.brand')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'القائمة' })).toBeNull();
  });

  it('marks the active item with aria-current="page", and only that one', async () => {
    go('/habits/water');
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['العادات']);
    await screen.findByRole('heading', { level: 1, name: 'تفاصيل العادة' });
  });

  it('marks the home item active only on / itself', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'الرئيسية' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'اليوم' }).getAttribute('aria-current')).toBeNull();
  });

  it('has the skip link to the main content as the first focusable element', () => {
    const { container } = render(<App />);
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable[0]?.textContent).toBe('تخطي إلى المحتوى');
    expect(focusable[0]?.getAttribute('href')).toBe('#main');
    const main = screen.getByRole('main');
    expect(main.id).toBe('main');
    fireEvent.click(focusable[0] as HTMLElement);
    expect(document.activeElement).toBe(main);
  });

  it('renders the home page eagerly, with its heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeTruthy();
  });

  it('loads a lazy page on navigation, moves aria-current and focuses the page heading', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: 'الأهداف' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'الأهداف' });
    expect(location.pathname).toBe('/goals');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole('link', { name: 'الأهداف' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'الرئيسية' }).getAttribute('aria-current')).toBeNull();
  });

  it.each([
    ['/day', 'اليوم'],
    ['/day/morning', 'اليوم'],
    ['/day/evening', 'اليوم'],
    ['/habits', 'العادات'],
    ['/habits/new', 'عادة جديدة'],
    ['/habits/water', 'تفاصيل العادة'],
    ['/habits/water/edit', 'تعديل العادة'],
    ['/goals', 'الأهداف'],
    ['/goals/O1', 'تفاصيل الهدف'],
    ['/review', 'المراجعة'],
    ['/focus', 'التركيز'],
    ['/breath', 'التنفّس'],
    ['/ask', 'اسأل'],
    ['/settings', 'الإعدادات'],
    ['/pair', 'الإقران'],
  ])('routes %s to its placeholder page %s', async (path, title) => {
    go(path);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
  });

  it('shows a not-found page with a way home for an unknown path', async () => {
    go('/nowhere');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'الصفحة غير موجودة' })).toBeTruthy();
    const home = within(screen.getByRole('main')).getByRole('link', { name: 'العودة إلى الرئيسية' });
    expect(home.getAttribute('href')).toBe('/');
  });

  it.each(['/nowhere', '/habits/a/b/c', '/day/noon', '/goals/O1/extra', '/settings/extra'])(
    'marks no nav item current on not-found path %s (M-8)',
    async (path) => {
      go(path);
      render(<App />);
      expect(await screen.findByRole('heading', { level: 1, name: 'الصفحة غير موجودة' })).toBeTruthy();
      const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
      const current = within(nav)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current).toEqual([]);
    },
  );

  it('sets document.title to "<page name> · يومي" on initial load and on navigation (M-1)', async () => {
    render(<App />);
    expect(document.title).toBe('الرئيسية · يومي');
    fireEvent.click(screen.getByRole('link', { name: 'الأهداف' }));
    await screen.findByRole('heading', { level: 1, name: 'الأهداف' });
    await waitFor(() => expect(document.title).toBe('الأهداف · يومي'));
  });

  it('keeps focus on a control inside #main when moving from /day/morning to /day/evening (I-5)', async () => {
    go('/day/morning');
    render(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'اليوم' });
    const main = screen.getByRole('main');
    const switcher = document.createElement('button');
    switcher.type = 'button';
    switcher.textContent = 'المساء';
    main.appendChild(switcher);
    switcher.focus();
    expect(document.activeElement).toBe(switcher);

    navigate('/day/evening');
    await waitFor(() => expect(location.pathname).toBe('/day/evening'));
    expect(document.activeElement).toBe(switcher);
    expect(document.activeElement).not.toBe(heading);
  });

  it('shows an Arabic error state with a retry that reloads the app when a lazy page chunk rejects (I-2)', async () => {
    const lazyPage = (appModule as { lazyPage?: (load: () => Promise<unknown>, onRetry?: () => void) => unknown }).lazyPage;
    expect(typeof lazyPage).toBe('function');
    let reloads = 0;
    const BrokenPage = lazyPage!(() => Promise.reject(new Error('Failed to fetch dynamically imported module')), () => {
      reloads += 1;
    }) as typeof HomePage;

    render(
      <LocationProvider>
        <AppShell>
          <Router onRouteChange={focusPageHeading}>
            <Route path="/" component={HomePage} />
            <Route path="/habits" component={BrokenPage} />
          </Router>
        </AppShell>
      </LocationProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'العادات' }));
    const errorHeading = await screen.findByRole('heading', { level: 1, name: 'تعذّر التحميل' });
    expect(screen.queryByRole('heading', { level: 1, name: 'الرئيسية' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(errorHeading));

    const retry = within(screen.getByRole('main')).getByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    expect(reloads).toBe(1);
  });

  it('has the «اسأل» button in the header; it calls openAsk once', () => {
    const ask = countAsk();
    render(<App />);
    const header = screen.getByRole('banner');
    fireEvent.click(within(header).getByRole('button', { name: 'اسأل' }));
    expect(ask.count()).toBe(1);
    ask.stop();
  });

  it('G then A goes to /habits (codes, not keys: the Arabic layout gives ل then ش)', async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(document.body, { key: 'ش', code: 'KeyA' });
    expect(await screen.findByRole('heading', { level: 1, name: 'العادات' })).toBeTruthy();
    expect(location.pathname).toBe('/habits');
    expect(screen.getByRole('link', { name: 'العادات' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('the narrow-width menu (under 900px the sidebar is a top bar with a drawer)', () => {
  beforeEach(() => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
  });

  it('the menu button reports aria-expanded, controls the nav, and Escape closes the drawer', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'القائمة' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(button.getAttribute('aria-controls')).toBe(nav.id);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('choosing a link closes the drawer', async () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'القائمة' });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('link', { name: 'التركيز' }));
    await screen.findByRole('heading', { level: 1, name: 'التركيز' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('holds focus inside the open drawer: Tab from the last link wraps to the menu button, Shift+Tab back (I-4)', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'القائمة' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    const lastLink = screen.getByRole('link', { name: 'الإعدادات' });
    lastLink.focus();
    expect(document.activeElement).toBe(lastLink);

    const tabForward = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
    lastLink.dispatchEvent(tabForward);
    expect(tabForward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);

    const tabBackward = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(tabBackward);
    expect(tabBackward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(lastLink);
  });

  it('closes on clicking the already-active nav link and returns focus to the menu button (I-4)', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'القائمة' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('link', { name: 'الرئيسية' }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on a pointer press outside the sidebar and returns focus to the menu button (I-4)', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'القائمة' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.pointerDown(screen.getByRole('main'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });
});

describe('installShortcuts (lib/keys.ts)', () => {
  let dispose: () => void = () => undefined;
  let ask: ReturnType<typeof countAsk>;

  beforeEach(() => {
    dispose = installShortcuts();
    ask = countAsk();
  });

  afterEach(() => {
    dispose();
    ask.stop();
  });

  it('Ctrl with KeyK calls openAsk once on the Arabic layout (key is ن)', () => {
    fireEvent.keyDown(document.body, { ctrlKey: true, key: 'ن', code: 'KeyK' });
    expect(ask.count()).toBe(1);
  });

  it('Meta with KeyK does the same (macOS)', () => {
    fireEvent.keyDown(document.body, { metaKey: true, key: 'ن', code: 'KeyK' });
    expect(ask.count()).toBe(1);
  });

  it('Ctrl+K works from inside a field too, and stops the browser default', () => {
    render(<input aria-label="حقل" />);
    const event = new KeyboardEvent('keydown', {
      ctrlKey: true,
      key: 'ن',
      code: 'KeyK',
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole('textbox', { name: 'حقل' }).dispatchEvent(event);
    expect(ask.count()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('K without Ctrl or Meta does nothing', () => {
    fireEvent.keyDown(document.body, { key: 'ن', code: 'KeyK' });
    expect(ask.count()).toBe(0);
  });

  it('Slash outside a field calls openAsk once (key is ظ)', () => {
    fireEvent.keyDown(document.body, { key: 'ظ', code: 'Slash' });
    expect(ask.count()).toBe(1);
  });

  it.each([
    ['input', () => <input aria-label="حقل" />],
    ['textarea', () => <textarea aria-label="حقل" />],
    [
      'select',
      () => (
        <select aria-label="حقل">
          <option>أ</option>
        </select>
      ),
    ],
    ['contenteditable', () => <div aria-label="حقل" contentEditable tabIndex={0} />],
    ['role="textbox"', () => <div role="textbox" aria-label="حقل" tabIndex={0} />],
    ['role="combobox"', () => <div role="combobox" aria-label="حقل" tabIndex={0} />],
    ['role="searchbox"', () => <div role="searchbox" aria-label="حقل" tabIndex={0} />],
  ])('Slash and G-sequence inside a %s are ignored as text entry (M-4)', (_name, field) => {
    go('/settings');
    const { container } = render(field());
    const el = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(el, { key: 'ظ', code: 'Slash' });
    expect(ask.count()).toBe(0);
    fireEvent.keyDown(el, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(el, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');
  });

  it('ignores auto-repeat keydown events (M-2)', () => {
    go('/settings');
    fireEvent.keyDown(document.body, { ctrlKey: true, key: 'ن', code: 'KeyK', repeat: true });
    fireEvent.keyDown(document.body, { key: 'ظ', code: 'Slash', repeat: true });
    expect(ask.count()).toBe(0);
    fireEvent.keyDown(document.body, { key: 'ل', code: 'KeyG', repeat: true });
    fireEvent.keyDown(document.body, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');
  });

  it('a modified key cancels the G sequence (M-3)', () => {
    go('/settings');
    fireEvent.keyDown(document.body, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(document.body, { ctrlKey: true, key: 'ش', code: 'KeyA' });
    fireEvent.keyDown(document.body, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');

    fireEvent.keyDown(document.body, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(document.body, { shiftKey: true, key: 'ش', code: 'KeyA' });
    fireEvent.keyDown(document.body, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');
  });

  it('matches by code: a Latin k on another key and a / on the keypad do nothing', () => {
    fireEvent.keyDown(document.body, { ctrlKey: true, key: 'k', code: 'KeyL' });
    fireEvent.keyDown(document.body, { key: '/', code: 'NumpadDivide' });
    expect(ask.count()).toBe(0);
  });

  it.each([
    ['KeyH', '/'],
    ['KeyD', '/day'],
    ['KeyA', '/habits'],
    ['KeyO', '/goals'],
  ])('G then %s navigates to %s', (code, path) => {
    go('/settings');
    fireEvent.keyDown(document.body, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(document.body, { key: 'x', code });
    expect(location.pathname).toBe(path);
  });

  it('a letter without a preceding G does not navigate, and G inside a field is ignored', () => {
    go('/settings');
    fireEvent.keyDown(document.body, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');
    const { container } = render(<input aria-label="حقل" />);
    const input = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(input, { key: 'ل', code: 'KeyG' });
    fireEvent.keyDown(input, { key: 'ش', code: 'KeyA' });
    expect(location.pathname).toBe('/settings');
  });

  it('dispose removes the listener', () => {
    dispose();
    fireEvent.keyDown(document.body, { ctrlKey: true, key: 'ن', code: 'KeyK' });
    expect(ask.count()).toBe(0);
  });
});

describe('ask controller', () => {
  it('openAsk notifies every subscriber; the returned function unsubscribes', () => {
    const a = countAsk();
    const b = countAsk();
    openAsk();
    b.stop();
    openAsk();
    expect([a.count(), b.count()]).toEqual([2, 1]);
    a.stop();
  });

  it('with no subscriber (the panel arrives in task 20) openAsk opens the /ask page', () => {
    go('/goals');
    openAsk();
    expect(location.pathname).toBe('/ask');
  });
});

describe('ConnectionStatus', () => {
  it('announces the connection state politely and follows online/offline events', () => {
    render(<ConnectionStatus />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('متصل');
    fireEvent(window, new Event('offline'));
    expect(status.textContent).toContain('بلا اتصال');
    expect(status.textContent).toContain('تُحفظ التسجيلات على الجهاز');
    fireEvent(window, new Event('online'));
    expect(status.textContent).toContain('متصل');
    expect(status.textContent).not.toContain('بلا اتصال');
  });
});

describe('UpdatePrompt', () => {
  it('mounts an empty polite status live region when needRefresh is false, then fills it when true (M-6)', () => {
    let updates = 0;
    const { rerender } = render(<UpdatePrompt needRefresh={false} onUpdate={() => (updates += 1)} />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    expect(within(status).queryByRole('button')).toBeNull();

    rerender(<UpdatePrompt needRefresh onUpdate={() => (updates += 1)} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toContain('نسخة جديدة متاحة');
    fireEvent.click(within(status).getByRole('button', { name: 'تحديث الآن' }));
    expect(updates).toBe(1);
  });

  it('says a new version is available and updates on «تحديث الآن»', () => {
    let updates = 0;
    render(<UpdatePrompt needRefresh onUpdate={() => (updates += 1)} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('نسخة جديدة متاحة');
    fireEvent.click(within(status).getByRole('button', { name: 'تحديث الآن' }));
    expect(updates).toBe(1);
  });
});

describe('layout.css rules (I-3, M-9, M-10)', () => {
  const css = readFileSync(join(resolve(import.meta.dirname, '..'), 'src/styles/layout.css'), 'utf8');

  it('makes .sidebar-nav the scroll container so the sidebar foot never scrolls away (I-3)', () => {
    const navBlock = /\.sidebar-nav\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(navBlock).toMatch(/min-block-size:\s*0/);
    expect(navBlock).toMatch(/overflow-y:\s*auto/);
    const sidebarBlock = /\.sidebar\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(sidebarBlock).not.toMatch(/overflow-y:\s*auto/);
  });

  it('gives .not-found-link inline padding so the focus ring does not touch the letters (M-9)', () => {
    const linkBlock = /\.not-found-link\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(linkBlock).toMatch(/padding-inline:\s*var\(--sp-2\)/);
  });

  it('scopes the programmatic focus outline rule to #main and #main h1 (M-10)', () => {
    expect(css).not.toMatch(/(?:^|\n)\s*\[tabindex=['"]-1['"]\]:focus\s*\{/);
    expect(css).toMatch(/#main(?:\[tabindex=['"]-1['"]\])?:focus,\s*#main h1(?:\[tabindex=['"]-1['"]\])?:focus\s*\{\s*outline:\s*none;/);
  });
});
