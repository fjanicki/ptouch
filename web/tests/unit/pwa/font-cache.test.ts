// Library fonts used on the first visit (before the service worker controls the page) are sent
// to the worker's font route by pwa/font-cache.ts (Workbox `CACHE_URLS`), so they work offline
// later. e2e/font-library.spec.ts checks the real worker.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pwaOptions } from '../../../pwa.config'
import { FONT_CACHE_NAME, cacheLibraryFonts } from '../../../src/pwa/font-cache'
import { loadFamily } from '../../../src/render/fonts'

class FakeFace {
  constructor(
    readonly family: string,
    readonly source: string,
  ) {}
  async load() {
    return this
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const urlsOf = (messages: unknown[]) => messages.flatMap((m) => (m as { payload: { urlsToCache: string[] } }).payload.urlsToCache)

describe('first-visit font cache', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('the worker’s runtime route for font files uses the font cache', () => {
    const route = pwaOptions.workbox?.runtimeCaching?.find((r) => String(r.urlPattern).includes('woff2'))
    expect(route?.handler).toBe('CacheFirst')
    expect(route?.options?.cacheName).toBe(FONT_CACHE_NAME)
    // The worker's own request for a sent URL has no Origin header: Vary must not make it miss.
    expect(route?.options?.matchOptions?.ignoreVary).toBe(true)
  })

  it('an uncontrolled page sends every library font file it loads, once a worker is active; core files never', async () => {
    vi.stubGlobal('FontFace', FakeFace)
    vi.stubGlobal('fonts', { add: () => {}, delete: () => true, check: () => true })
    const messages: unknown[] = []
    let activate: (v: { active: { postMessage: (m: unknown) => void } }) => void = () => {}
    const ready = new Promise<{ active: { postMessage: (m: unknown) => void } }>((r) => (activate = r))

    // Loaded before the mirror starts (reported on subscribe) and after it.
    expect(await loadFamily('vt323', 400)).toBe(true)
    const stop = cacheLibraryFonts({ ready, controlled: () => false })
    expect(await loadFamily('oswald', 700)).toBe(true)
    expect(await loadFamily('oswald', 700)).toBe(true) // once
    expect(await loadFamily('fira-sans', 400)).toBe(true) // core: precached
    await flush()
    expect(messages).toEqual([]) // no worker yet

    activate({ active: { postMessage: (m) => messages.push(m) } })
    await flush()
    expect(messages.every((m) => (m as { type: string }).type === 'CACHE_URLS')).toBe(true)
    expect(urlsOf(messages).sort()).toEqual([expect.stringMatching(/\/fonts\/Oswald-Bold\.woff2$/), expect.stringMatching(/\/fonts\/VT323-Regular\.woff2$/)])
    stop()
  })

  it('a controlled page sends nothing (the worker saw its requests); no worker: nothing at all', async () => {
    vi.stubGlobal('FontFace', FakeFace)
    vi.stubGlobal('fonts', { add: () => {}, delete: () => true, check: () => true })
    const messages: unknown[] = []
    const stop = cacheLibraryFonts({ ready: Promise.resolve({ active: { postMessage: (m) => messages.push(m) } }), controlled: () => true })
    expect(await loadFamily('anton', 400)).toBe(true)
    await flush()
    expect(messages).toEqual([])
    stop()
    expect(() => cacheLibraryFonts(undefined)()).not.toThrow()
  })
})
