// The navigation map of design section 3: four groups, nine items. /pair stays off the menu.

export interface NavItem {
  readonly label: string;
  readonly href: string;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  {
    label: 'يومي',
    items: [
      { label: 'الرئيسية', href: '/' },
      { label: 'اليوم', href: '/day' },
    ],
  },
  {
    label: 'التقدّم',
    items: [
      { label: 'العادات', href: '/habits' },
      { label: 'الأهداف', href: '/goals' },
      { label: 'المراجعة', href: '/review' },
    ],
  },
  {
    label: 'الجلسات',
    items: [
      { label: 'التركيز', href: '/focus' },
      { label: 'التنفّس', href: '/breath' },
    ],
  },
  {
    label: 'أخرى',
    items: [
      { label: 'اسأل', href: '/ask' },
      { label: 'الإعدادات', href: '/settings' },
    ],
  },
];

/** Whether the item owns the path: / only itself, every other item its sub-pages too. */
export function isActive(href: string, path: string): boolean {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}
