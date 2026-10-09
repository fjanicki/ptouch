// Lead integration (docs/FONTS-AND-SIZE-PLAN.md §5) — the three packages together, as the user
// meets them: a library font picked in the picker is fetched once from this site (nothing
// third-party) and still works offline; "Hello" at S is far shorter than at Fit on 24 mm tape; the
// default size for new text leaves existing blocks alone; a point size survives a share link; shrink
// to fit length keeps text inside a 30 mm label; a pixel font prints on its pixel grid; and the
// 12 mm Wi-Fi sticker with a real network name stays under 4 cm.
import { inflateSync, inflateRawSync } from 'node:zlib'
import { expect, test, type BrowserContext, type Download, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const quick = (page: Page) => page.getByRole('group', { name: 'Quick text size' })
const trigger = (page: Page) => page.getByRole('button', { name: 'Font', exact: true })
const picker = (page: Page) => page.getByRole('dialog', { name: 'Choose a font' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const CORE = /\/fonts\/(FiraSans|ArchivoNarrow|JetBrainsMono|AtkinsonHyperlegible)-[A-Za-z]+\.woff2$/

async function settled(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
}

async function printedMm(page: Page): Promise<number> {
  const t = await preview(page).getByText(/ printed \+ 2 × /).textContent()
  return Number(/([\d.]+) mm printed/.exec(t ?? '')?.[1] ?? NaN)
}

/** Picks a bundled font with the keyboard: search, ↓ to the first match, Enter. */
async function pickFont(page: Page, query: string, name: string): Promise<void> {
  await trigger(page).click()
  await expect(picker(page)).toBeVisible()
  await page.keyboard.type(query)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toBeHidden()
  await expect(trigger(page)).toContainText(name)
}

/** Every request the page or its service worker makes: absolute URL, and whether the service
 * worker made it (its fetch to the network behind a page request it handles). */
function recordRequests(context: BrowserContext): { url: string; sw: boolean }[] {
  const seen: { url: string; sw: boolean }[] = []
  context.on('request', (r) => void seen.push({ url: r.url(), sw: r.serviceWorker() !== null }))
  return seen
}

async function readDownload(d: Download): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of await d.createReadStream()) parts.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(parts)
}

/** The exact print bitmap, from "Export image" → PNG (1-bit, filter 0 rows): `ink[y][x]`. */
async function exportBitmap(page: Page): Promise<{ w: number; h: number; ink: boolean[][] }> {
  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Export image (PNG, PDF)…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export image' })
  const [d] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Download PNG/ }).click()])
  const png = await readDownload(d)
  await page.keyboard.press('Escape')
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  expect([png[24], png[25]]).toEqual([1, 0]) // 1-bit greyscale: there is no grey to hide
  const idat: Buffer[] = []
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o)
    if (png.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = Math.ceil(w / 8) + 1
  const ink = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => ((raw[y * stride + 1 + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) === 0))
  return { w, h, ink }
}

function inkBox(ink: boolean[][]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity
  let x1 = -1
  let y0 = Infinity
  let y1 = -1
  ink.forEach((row, y) =>
    row.forEach((on, x) => {
      if (!on) return
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }),
  )
  return { x0, x1, y0, y1 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await settled(page)
})

test('a library font from the picker: fetched once from this site, the preview changes, and it works offline', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const requests = recordRequests(context)
  // Let the service worker take control, so the font request goes through its font cache.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    if (reg.active?.state !== 'activated') await new Promise((r) => reg.active?.addEventListener('statechange', r, { once: true }))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await settled(page)

  await page.getByLabel('Text', { exact: true }).fill('CRATE 07')
  await settled(page)
  const canvas = preview(page).locator('canvas')
  const before = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())
  await pickFont(page, 'oswald', 'Oswald')
  await settled(page)
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before)
  await expect(preview(page).getByText(/could not be loaded/)).toHaveCount(0)

  // Nothing third-party; every font comes from /ptouch/fonts/, and Oswald 700 (600 resolves to
  // the nearest file) is fetched once.
  const origin = new URL(page.url()).origin
  expect(requests.filter((r) => !r.url.startsWith(origin) && !/^(data|blob):/.test(r.url))).toEqual([])
  const fonts = requests.filter((r) => new URL(r.url).pathname.endsWith('.woff2'))
  expect(fonts.every((r) => new URL(r.url).pathname.startsWith('/ptouch/fonts/'))).toBe(true)
  const oswald = fonts.filter((r) => new URL(r.url).pathname === '/ptouch/fonts/Oswald-Bold.woff2')
  // One request from the page, which the service worker fetches once from the network.
  expect(oswald.map((r) => r.sw).sort()).toEqual([false, true])
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open('ptouch-fonts')).keys()).map((r) => new URL(r.url).pathname)))
    .toContain('/ptouch/fonts/Oswald-Bold.woff2')

  // Offline, the same label (via its share link) draws with the cached face.
  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('#d=')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  await context.setOffline(true)
  try {
    await page.goto('about:blank')
    await page.goto(link)
    await settled(page)
    await expect(trigger(page)).toContainText('Oswald')
    await expect
      .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'ptouch Oswald' && f.weight === '700' && f.status === 'loaded')))
      .toBe(true)
    await expect(preview(page).getByText(/could not be loaded/)).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
  // The core families stay the only precached fonts.
  const precached = await page.evaluate(async () => {
    const out: string[] = []
    for (const name of await caches.keys()) if (name !== 'ptouch-fonts') for (const r of await (await caches.open(name)).keys()) out.push(new URL(r.url).pathname)
    return out.filter((p) => p.endsWith('.woff2'))
  })
  expect(precached.length).toBeGreaterThan(0)
  expect(precached.filter((p) => !CORE.test(p))).toEqual([])
})

test('“Hello” at S on 24 mm tape is much shorter than at Fit', async ({ page }) => {
  await expect(preview(page).getByText(/24 mm tape · printable/)).toBeVisible()
  await page.getByLabel('Text', { exact: true }).fill('Hello')
  await quick(page).getByRole('button', { name: 'Fit tape', exact: true }).click()
  await expect(quick(page).getByRole('button', { name: 'Fit tape', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await settled(page)
  const fit = await printedMm(page)
  await quick(page).getByRole('button', { name: 'S, small', exact: true }).click()
  await expect.poll(() => printedMm(page)).toBeLessThan(fit * 0.55)
  const small = await printedMm(page)
  expect(fit - small).toBeGreaterThan(15)
  // The length readout said so before the click (the chosen size shows the exact length).
  await expect(quick(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAccessibleDescription(`${Math.round(small)} mm`)
})

test('the default size for new text applies to new blocks only', async ({ page }) => {
  const pressed = (name: string) => expect(quick(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await quick(page).getByRole('button', { name: 'Fit tape', exact: true }).click()
  await pressed('Fit tape')
  await page.getByLabel('Size of new text').selectOption('third')
  // The open block keeps its size.
  await pressed('Fit tape')
  await page.getByRole('button', { name: 'Insert Text' }).click()
  await expect(blocks(page)).toHaveCount(2)
  await pressed('S, small')
  await blocks(page).first().getByRole('button', { name: /^Text/ }).click()
  await pressed('Fit tape')
  // Remembered, and the existing blocks are unchanged after a reload.
  await page.waitForTimeout(700) // autosave debounce
  await page.reload()
  await settled(page)
  await expect(page.getByLabel('Size of new text')).toHaveValue('third')
  await blocks(page).first().getByRole('button', { name: /^Text/ }).click()
  await pressed('Fit tape')
  await blocks(page).nth(1).getByRole('button', { name: /^Text/ }).click()
  await pressed('S, small')
})

test('a point size round-trips through a reload and a share link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByLabel('Text', { exact: true }).fill('Fourteen')
  await page.getByRole('radio', { name: 'Points' }).click()
  const size = page.getByLabel('Font size')
  await size.fill('14')
  await size.blur()
  await settled(page)
  await expect.poll(() => printedMm(page)).toBeGreaterThan(0)
  const mm = await printedMm(page)

  await page.waitForTimeout(700) // autosave debounce
  await page.reload()
  await settled(page)
  await expect(page.getByRole('radio', { name: 'Points' })).toBeChecked()
  await expect(page.getByLabel('Font size')).toHaveValue('14')
  expect(await printedMm(page)).toBe(mm)

  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('#d=')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  const json = inflateRawSync(Buffer.from(link.split('#d=')[1] ?? '', 'base64url')).toString('utf8')
  expect(json).toContain('"schema":3')
  expect(json).toContain('"size":{"mode":"pt","pt":14}')
  const other = await context.newPage()
  await other.goto(link)
  await settled(other)
  await expect(other.getByRole('radio', { name: 'Points' })).toBeChecked()
  await expect(other.getByLabel('Font size')).toHaveValue('14')
  expect(await printedMm(other)).toBe(mm)
})

test('shrink to fit length keeps long text inside a fixed 30 mm label', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('Screws, bolts and washers')
  await page.getByRole('radiogroup', { name: 'Length' }).getByRole('radio', { name: 'Fixed' }).click()
  const length = page.getByLabel('Printed length')
  await length.fill('30')
  await length.blur()
  await expect(page.getByText(/longer than the fixed label length/).first()).toBeVisible()
  // Click the switch's label, as a user does (its track covers the hidden checkbox).
  await page.getByText('Shrink text to fit length', { exact: true }).click()
  await expect(page.getByText(/longer than the fixed label length/)).toHaveCount(0)
  await settled(page)
  // Changing the length keeps the switch on.
  await length.fill('31')
  await length.blur()
  await length.fill('30')
  await length.blur()
  await expect(page.getByRole('switch', { name: 'Shrink text to fit length' })).toBeChecked()
  await settled(page)

  const { w, ink } = await exportBitmap(page)
  const dots = Math.round((30 * 180) / 25.4)
  expect(Math.abs(w - dots)).toBeLessThanOrEqual(1)
  // 2 mm margins at both ends (14 dots): all the ink is between them, and it is real text.
  const box = inkBox(ink)
  expect(box.x0).toBeGreaterThanOrEqual(13)
  expect(box.x1).toBeLessThanOrEqual(w - 14)
  expect(box.x1 - box.x0).toBeGreaterThan((w - 28) * 0.8)
})

test('a pixel font prints on its pixel grid (whole dots per font pixel)', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('PIXEL 42')
  await pickFont(page, 'silkscreen', 'Silkscreen')
  await settled(page)
  const badge = trigger(page).getByText('Crisp', { exact: true })
  await expect(badge).toBeVisible()
  const k = Number(/Drawn at (\d+) dots per font pixel/.exec((await badge.getAttribute('title')) ?? '')?.[1])
  expect(k).toBeGreaterThanOrEqual(2)

  const { ink } = await exportBitmap(page)
  const box = inkBox(ink)
  // Every ink/blank edge, across and along the tape, sits on one k-dot grid: no stray or partial
  // dots (a run of k-1 dots, a lone dot) anywhere in the text.
  const xs = new Set<number>()
  const ys = new Set<number>()
  for (let y = box.y0; y <= box.y1 + 1; y++) {
    for (let x = box.x0; x <= box.x1 + 1; x++) {
      const on = ink[y]?.[x] ?? false
      if (on !== (ink[y]?.[x - 1] ?? false)) xs.add((((x - box.x0) % k) + k) % k)
      if (on !== (ink[y - 1]?.[x] ?? false)) ys.add((((y - box.y0) % k) + k) % k)
    }
  }
  expect([...xs]).toEqual([0])
  expect([...ys]).toEqual([0])
})

test('the 12 mm Wi-Fi sticker with a real network name is at most 4 cm long', async ({ page }) => {
  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New from template…' }).click()
  await page.getByRole('dialog', { name: 'New from template' }).getByRole('button', { name: 'Wi-Fi sticker (12 mm)', exact: true }).click()
  await expect(preview(page).getByText(/12 mm tape · printable/)).toBeVisible()
  await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill('MyHomeNetwork')
  await settled(page)
  await expect(blocks(page).nth(1)).toContainText('Wi-Fi')
  const mm = await printedMm(page)
  expect(mm).toBeGreaterThanOrEqual(25)
  expect(mm).toBeLessThanOrEqual(40)
})
