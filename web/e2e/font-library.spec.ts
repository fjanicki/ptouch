// P-lib — the font library in the production build under /ptouch/ (docs/FONTS-AND-SIZE-PLAN.md
// §3.1, §2.5): library fonts are never fetched at startup (nor precached by the service worker),
// a label that uses one fetches each face it needs exactly once, from this site, and after that
// first use the label renders offline from the service worker's font cache.
import { deflateRawSync } from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const CORE = /\/fonts\/(FiraSans|ArchivoNarrow|JetBrainsMono|AtkinsonHyperlegible)-[A-Za-z]+\.woff2$/
const FONT_FILE = /\/fonts\/[A-Za-z0-9_-]+\.woff2$/

/** A schema-3 label with two Oswald Bold blocks and one Fira Sans block, as a `#d=` fragment. */
function oswaldShareHash(): string {
  const text = (id: string, t: string, fontFamily: string, fontWeight: number) => ({ id, kind: 'text', text: t, fontFamily, fontWeight, italic: false, size: { mode: 'fit' }, align: 'center', lineHeight: 1.1, invert: false })
  const doc = {
    schema: 3,
    id: '6f1d1e0a-2a51-4c55-8f3e-5b0c9a7d1e01',
    name: 'Oswald crate',
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    tape: { widthMm: 12, mediaId: 'tze231-12', colors: { tape: '#ffffff', ink: '#000000' } },
    length: { mode: 'auto' },
    marginsMm: { start: 2, end: 2 },
    layout: { mode: 'flow', gapMm: 2, align: 'center' },
    items: [text('6f1d1e0a-2a51-4c55-8f3e-5b0c9a7d1e02', 'CRATE', 'oswald', 700), text('6f1d1e0a-2a51-4c55-8f3e-5b0c9a7d1e03', '07', 'oswald', 700), text('6f1d1e0a-2a51-4c55-8f3e-5b0c9a7d1e04', 'tools', 'fira-sans', 600)],
    print: { copies: 1, autoCut: true, chain: false, mirror: false, threshold: 128 },
  }
  return `#d=${deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64url')}`
}

/** Every font file the page or its service worker requests, as URL paths. */
function recordFontRequests(context: BrowserContext): string[] {
  const seen: string[] = []
  context.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (FONT_FILE.test(path)) seen.push(path)
  })
  return seen
}

/** The preview has drawn the open label with a loaded (not fallback) "ptouch Oswald" face. */
async function oswaldDrawn(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'ptouch Oswald' && f.weight === '700' && f.status === 'loaded')))
    .toBe(true)
  await expect(preview(page).getByText(/could not be loaded/)).toHaveCount(0)
}

test.describe('lazy loading', () => {
  test.use({ serviceWorkers: 'block' })

  test('no library font at startup; a label using one fetches each face once, from /ptouch/fonts/', async ({ page, context }) => {
    const fonts = recordFontRequests(context)
    await page.goto('./')
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await page.waitForLoadState('networkidle')
    expect(fonts.filter((p) => !CORE.test(p))).toEqual([])

    await page.goto(`./${oswaldShareHash()}`)
    await oswaldDrawn(page)
    // Re-render with another block: the face is cached in the page, no second request.
    await page.getByRole('button', { name: 'Insert Text' }).click()
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await page.waitForLoadState('networkidle')
    expect(fonts.filter((p) => !CORE.test(p))).toEqual(['/ptouch/fonts/Oswald-Bold.woff2'])
  })
})

test('a library font used once renders offline (service worker font cache)', async ({ page, context }) => {
  const fonts = recordFontRequests(context)
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    if (reg.active?.state !== 'activated') await new Promise((r) => reg.active?.addEventListener('statechange', r, { once: true }))
  })
  // The precache holds the core families only.
  expect(fonts.filter((p) => !CORE.test(p))).toEqual([])
  const precached = await page.evaluate(async () => {
    const out: string[] = []
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(`${name} ${new URL(req.url).pathname}`)
    return out.filter((s) => s.includes('/fonts/'))
  })
  expect(precached.some((s) => /FiraSans-SemiBold\.woff2/.test(s))).toBe(true)
  expect(precached.filter((s) => !CORE.test(s.replace(/\?.*$/, '').split(' ')[1] ?? ''))).toEqual([])

  // Second visit: the page is controlled, so the font request goes through the service worker.
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await page.goto(`./${oswaldShareHash()}`)
  await oswaldDrawn(page)
  // Kept by the runtime rule (pwa.config.ts), not the precache.
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open('ptouch-fonts')).keys()).map((r) => new URL(r.url).pathname)))
    .toEqual(['/ptouch/fonts/Oswald-Bold.woff2'])

  await context.setOffline(true)
  try {
    await page.goto('about:blank')
    await page.goto(`./${oswaldShareHash()}`)
    await oswaldDrawn(page)
  } finally {
    await context.setOffline(false)
  }
})

test('a library font used on the very first visit (page not yet controlled) also renders offline later', async ({ page, context }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    if (reg.active?.state !== 'activated') await new Promise((r) => reg.active?.addEventListener('statechange', r, { once: true }))
  })
  // First visit: the worker is active but does not control this page, so it never sees the request.
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  await page.goto(`./${oswaldShareHash()}`)
  await oswaldDrawn(page)
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  // The page put the file into the worker's font cache itself (pwa/font-cache.ts).
  await expect
    .poll(() => page.evaluate(async () => ((await caches.has('ptouch-fonts')) ? (await (await caches.open('ptouch-fonts')).keys()).map((r) => new URL(r.url).pathname) : [])))
    .toEqual(['/ptouch/fonts/Oswald-Bold.woff2'])

  await context.setOffline(true)
  try {
    await page.goto('about:blank')
    await page.goto(`./${oswaldShareHash()}`)
    await oswaldDrawn(page)
  } finally {
    await context.setOffline(false)
  }
})
