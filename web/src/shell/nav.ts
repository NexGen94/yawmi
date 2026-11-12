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

const ROUTE_PATTERNS: Readonly<Record<string, RegExp>> = {
  '/': /^\/$/,
  '/day': /^\/day(?:\/(?:morning|evening))?$/,
  '/habits': /^\/habits(?:\/[^/]+(?:\/edit)?)?$/,
  '/goals': /^\/goals(?:\/[^/]+)?$/,
  '/review': /^\/review$/,
  '/focus': /^\/focus$/,
  '/breath': /^\/breath$/,
  '/ask': /^\/ask$/,
  '/settings': /^\/settings$/,
};

/** Whether the item owns the path: only known routes under the item match; not-found paths match none. */
export function isActive(href: string, path: string): boolean {
  const clean = path.replace(/\/+$/g, '') || '/';
  return ROUTE_PATTERNS[href]?.test(clean) ?? false;
}
