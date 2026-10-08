// Owned by W5 (PWA). Imported by vite.config.ts. ARCHITECTURE.md §9:
// generateSW precaches the app shell, the wasm core, fonts and icons (revisioned, so every
// deploy is a new cache version; outdated caches are cleaned up). scope/start_url default to
// Vite's `base` (/ptouch/ on Pages). registerType 'prompt' + src/pwa/: a new version is only
// activated when the user reloads from the toast, never under a running print.
import type { VitePWAOptions } from 'vite-plugin-pwa'

export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  injectRegister: false, // registered from src/pwa/register.ts
  // public/ (favicon, icons, fonts) is already matched by workbox.globPatterns over dist/;
  // listing it here as well would add every file to the precache twice.
  includeAssets: [],
  includeManifestIcons: false,
  manifest: {
    name: 'ptouch studio',
    short_name: 'ptouch',
    description: 'Design and print labels on Brother P-touch printers, right from the browser. No install, no account, works offline.',
    lang: 'en',
    dir: 'ltr',
    display: 'standalone',
    orientation: 'any',
    categories: ['productivity', 'utilities'],
    theme_color: '#1d2433',
    background_color: '#f4f5f8',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  },
  workbox: {
    // Shell (html/js/css), the wasm core, fonts and icons. Source maps are not
    // precached (they are fetched only by devtools).
    globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,png}'], // the manifest is added by the plugin
    globIgnores: ['**/*.map'],
    cacheId: 'ptouch-studio',
    cleanupOutdatedCaches: true,
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    // Single-page app: any navigation inside the scope gets the cached shell (offline reloads,
    // share links with #d=… fragments).
    navigateFallback: 'index.html',
    // The licence notices are real pages, never the app shell.
    navigateFallbackDenylist: [/\/licenses\//],
  },
}
