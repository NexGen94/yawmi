import type { ManifestOptions, VitePWAOptions } from 'vite-plugin-pwa';

// Technical plumbing only. No visual design is approved yet (D-061), so the two colors below
// are neutral placeholders and the icons come from a placeholder glyph (assets/icon.svg).
export const manifest = {
  id: '/',
  name: 'يومي',
  short_name: 'يومي',
  lang: 'ar',
  dir: 'rtl',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  // TODO(design): take both colors from the approved design tokens.
  theme_color: '#ffffff',
  background_color: '#ffffff',
  icons: [
    { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
} satisfies Partial<ManifestOptions>;

export const pwaOptions = {
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  // An update waits until the user accepts it; nothing swaps silently under an open session.
  registerType: 'prompt',
  // Registration is done by src/main.tsx through virtual:pwa-register.
  injectRegister: false,
  // The shell (js, css, html), the manifest and its icons are precached so the app opens
  // offline; these two extra files are the ones the head links to. API calls are never cached.
  includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
  manifest,
} satisfies Partial<VitePWAOptions>;
