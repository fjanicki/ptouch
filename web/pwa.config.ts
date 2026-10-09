// Owned by W5 (PWA). Imported by vite.config.ts. ARCHITECTURE.md §9:
// generateSW precaches the app shell, the wasm core, fonts and icons (revisioned, so every
// deploy is a new cache version; outdated caches are cleaned up). scope/start_url default to
// Vite's `base` (/ptouch/ on Pages). registerType 'prompt' + src/pwa/: a new version is only
// activated when the user reloads from the toast, never under a running print.
//
// Fonts (docs/FONTS-AND-SIZE-PLAN.md): only the four core families are precached. The font
// library loads each family on first use; the runtime rule below then keeps it CacheFirst, so a
// font used once also works offline (on the first visit, before the worker controls the page,
// src/pwa/font-cache.ts sends the files to this rule). Lazily loaded files never change content under the same
// name (public/fonts/SOURCES.md), which is what makes CacheFirst safe without revisions.
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
    // Shell (html/js/css), the wasm core, the core fonts and icons. Source maps are not
    // precached (they are fetched only by devtools). The font glob must list exactly the core
    // families of render/font-catalog.ts (tests/unit/render/font-catalog.test.ts checks it).
    globPatterns: ['**/*.{js,css,html,wasm,svg,png}', 'fonts/{FiraSans,ArchivoNarrow,JetBrainsMono,AtkinsonHyperlegible}-*.woff2'], // the manifest is added by the plugin
    runtimeCaching: [
      {
        // Same-origin font library files (any base path). Precached core files never reach this
        // route: the precache route answers them first.
        urlPattern: /\/fonts\/[A-Za-z0-9_-]+\.woff2$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'ptouch-fonts',
          // ~25 families × 1–3 weights; old entries go first if the library ever grows.
          expiration: { maxEntries: 100 },
          cacheableResponse: { statuses: [200] },
          // Same-origin files that never change content: a response's `Vary` (e.g. Origin) must
          // not make a request without that header miss, such as the one the worker makes itself
          // for a font a first-visit page sent it (src/pwa/font-cache.ts, `CACHE_URLS`).
          matchOptions: { ignoreVary: true },
        },
      },
    ],
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
