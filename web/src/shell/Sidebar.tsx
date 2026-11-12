import { useEffect, useRef, useState } from 'preact/hooks';

import { ConnectionStatus } from './ConnectionStatus';
import { isActive, NAV } from './nav';

// One outline icon per item, drawn on a 24-unit grid with the same stroke (set in layout.css).
const ICONS: Readonly<Record<string, string>> = {
  '/': 'M4.5 10.5 12 4l7.5 6.5V20h-5v-5.5h-5V20h-5z',
  '/day':
    'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6',
  '/habits': 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM8.5 12.3l2.4 2.4 4.6-4.9',
  '/goals': 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 11.25a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5z',
  '/review': 'M5 6h14v14H5zM5 10.5h14M9 3.5v4M15 3.5v4',
  '/focus': 'M12 7a6.75 6.75 0 1 0 0 13.5A6.75 6.75 0 1 0 12 7zM12 10.5v3.5l2.25 1.5M10 3.5h4',
  '/breath': 'M3.5 9.5H14a2.75 2.75 0 1 0-2.75-2.75M3.5 14.5H17a2.75 2.75 0 1 1-2.75 2.75',
  '/ask': 'M5 5.5h14v10h-8.5L6 19.5v-4H5zM9 9.5h6M9 12h3.5',
  '/settings': 'M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9M15 5.5v4M9 14.5v4',
};

const NAV_ID = 'nav-main';

// The navy sidebar: the name, the four groups, the connection state at the foot. Under 900px
// (layout.css) it is a top bar and the same <nav> opens below it as a drawer.
export function Sidebar(props: { path: string }) {
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);

  // A new page closes the drawer.
  useEffect(() => setOpen(false), [props.path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape' || event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (event.code !== 'Tab' && event.key !== 'Tab') return;
      const first = button.current;
      const links = nav.current?.querySelectorAll<HTMLElement>('a[href]');
      const last = links?.[links.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !sidebar.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !sidebar.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (sidebar.current?.contains(event.target as Node)) return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onNavLinkClick = (): void => {
    if (!open) return;
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div ref={sidebar} class="sidebar" data-open={open ? '' : undefined}>
      <div class="sidebar-bar">
        <span class="brand">يومي</span>
        <button
          ref={button}
          type="button"
          class="menu-button"
          aria-label="القائمة"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls={NAV_ID}
          onClick={() => setOpen(!open)}
        >
          <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={open ? 'M6 6l12 12M18 6 6 18' : 'M4 7h16M4 12h16M4 17h16'} />
          </svg>
        </button>
      </div>
      <nav ref={nav} id={NAV_ID} class="sidebar-nav" aria-label="التنقل الرئيسي">
        {NAV.map((group, g) => (
          <div class="nav-group" key={group.label}>
            <p class="nav-group-label" id={`nav-group-${g}`}>
              {group.label}
            </p>
            <ul class="nav-list" role="list" aria-labelledby={`nav-group-${g}`}>
              {NAV[g]?.items.map((item) => (
                <li key={item.href}>
                  <a
                    class="nav-link"
                    href={item.href}
                    aria-current={isActive(item.href, props.path) ? 'page' : undefined}
                    onClick={onNavLinkClick}
                  >
                    <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d={ICONS[item.href]} />
                    </svg>
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div class="sidebar-foot">
        <ConnectionStatus />
      </div>
    </div>
  );
}
