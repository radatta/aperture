import type { ManifestOptions } from 'vite-plugin-pwa';

// Web-app manifest for the installable shell (Phase 9.1). Colors are the dark identity anchor
// (styles/tokens.css): dusky teal-green ground #33453f. theme_color is static browser chrome —
// the in-app theme still follows the home mode; this is just the OS-level install color.
export const APERTURE_MANIFEST: Partial<ManifestOptions> = {
  name: 'Aperture',
  short_name: 'Aperture',
  description: 'A three-mode life OS — plan the morning, do the day, reflect at night.',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  theme_color: '#33453f',
  background_color: '#33453f',
  categories: ['productivity', 'lifestyle'],
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: 'icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};
