// Library fonts offline from the first visit (docs/FONTS-AND-SIZE-PLAN.md §3.1). The service
// worker keeps library font files in a CacheFirst runtime cache (pwa.config.ts), but it only sees
// requests of pages it controls, and the page of the first visit, which registered it, is not
// controlled (registerType 'prompt', no clientsClaim). So such a page sends every library font
// file it loads to the worker once it is active, with Workbox's `CACHE_URLS` message: the worker
// runs each URL through its own font route, which caches it exactly as it caches a request of a
// controlled page. A font tried on the first visit then works offline later. Controlled pages
// send nothing (the worker saw their requests).
import { onLibraryFontFile } from '../render/fonts'

/** Must equal the runtime cache name in pwa.config.ts (tests/unit/pwa/font-cache.test.ts). */
export const FONT_CACHE_NAME = 'ptouch-fonts'

interface WorkerLike {
  postMessage(message: unknown): void
}

export interface FontCacheEnv {
  /** Resolves once a service worker is active (`navigator.serviceWorker.ready`). */
  ready: Promise<{ active: WorkerLike | null }>
  /** The page is controlled by a service worker (its requests reach the worker's routes). */
  controlled: () => boolean
}

/** Starts sending loaded library font files to the worker's font cache. Returns a stop function. */
export function cacheLibraryFonts(env: FontCacheEnv | undefined = browserEnv()): () => void {
  if (!env) return () => {}
  const sent = new Set<string>()
  return onLibraryFontFile((url) => {
    if (sent.has(url) || env.controlled()) return
    sent.add(url)
    env.ready.then(
      (reg) => reg.active?.postMessage({ type: 'CACHE_URLS', payload: { urlsToCache: [url] } }),
      () => sent.delete(url),
    )
  })
}

function browserEnv(): FontCacheEnv | undefined {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  const sw = navigator.serviceWorker
  return { ready: sw.ready, controlled: () => sw.controller !== null }
}
