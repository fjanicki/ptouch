// P5 (docs/STUDIO-V1-PLAN.md) — the studio on an iPhone: Chromium with the iPhone 13 viewport,
// user agent and touch (every iOS browser is WebKit: no Web Serial / WebUSB, so they are
// deleted), navigator.share stubbed. Design-only welcome and banner, "Send to computer" (share
// sheet, Copy, file; the Wi-Fi password is left out by default), no horizontal scroll at 375 and
// 360 px, 44 px touch targets, landscape (folded print bar, no "Connect printer" chip), and the
// iOS home-screen tags in the built index.html. With PW_WEBKIT=1 this file also runs in WebKit
// (playwright.config.ts), the engine of every iOS browser.
import { readFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13']
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

const PASSWORD = 'correct horse'

/** A Wi-Fi sticker label (schema 2) with a password, as a `#d=` share fragment. */
function wifiShareHash(): string {
  const doc = {
    schema: 2,
    id: '0b6c1c55-6a0e-4f1e-9d55-2f1b1a3c4d01',
    name: 'Wi-Fi sticker',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    tape: { widthMm: 12, mediaId: 'tze231-12', colors: { tape: '#ffffff', ink: '#000000' } },
    length: { mode: 'auto' },
    marginsMm: { start: 2, end: 2 },
    layout: { mode: 'flow', gapMm: 2, align: 'center' },
    items: [
      { id: '0b6c1c55-6a0e-4f1e-9d55-2f1b1a3c4d02', kind: 'text', text: 'Home', fontFamily: 'archivo-narrow', fontWeight: 700, italic: false, size: { mode: 'fit' }, align: 'start', lineHeight: 1.1, invert: false },
      {
        id: '0b6c1c55-6a0e-4f1e-9d55-2f1b1a3c4d03',
        kind: 'code',
        symbology: 'qr',
        content: 'wifi',
        data: '',
        wifi: { ssid: 'Home', password: PASSWORD, security: 'wpa', hidden: false },
        moduleDots: 'auto',
        quietZone: 'standard',
        ecc: 'M',
        showText: false,
      },
    ],
    print: { copies: 1, autoCut: true, chain: false, mirror: false, threshold: 128 },
  }
  return `#d=${deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64url')}`
}

/** The label JSON inside a share link. */
function decodeLink(url: string): string {
  const payload = url.split('#d=')[1] ?? ''
  return inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8')
}

interface ShareWindow {
  __shares: { title?: string; url?: string; files?: { name: string; type: string; text: string }[] }[]
}

/** iPhone Safari: no device APIs, no save picker, a recording share sheet. */
async function iphone(page: Page): Promise<void> {
  await removeDeviceApis(page)
  await page.addInitScript(() => {
    const w = window as unknown as ShareWindow
    w.__shares = []
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: (d?: ShareData) => !!d && (!!d.url || !!d.files?.length) })
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async (d: ShareData) => {
        const files = d.files ? await Promise.all(d.files.map(async (f) => ({ name: f.name, type: f.type, text: await f.text() }))) : undefined
        w.__shares.push({ ...(d.title ? { title: d.title } : {}), ...(d.url ? { url: d.url } : {}), ...(files ? { files } : {}) })
      },
    })
  })
}

async function startDesigning(page: Page, hash = ''): Promise<void> {
  await page.goto(`./${hash}`)
  await expect(page.getByRole('heading', { name: 'Design on your iPhone, print from a computer' })).toBeVisible()
  await page.getByRole('button', { name: 'Start designing' }).click()
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
}

const shares = (page: Page) => page.evaluate(() => (window as unknown as ShareWindow).__shares)

test.beforeEach(async ({ page }) => {
  await iphone(page)
})

test('iPhone: design-only welcome, then the editor with the design-only banner', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('On iPhone you can design labels here; printing happens from a computer with Chrome or Edge.', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: /Get Chrome/ })).toHaveCount(0) // every iOS browser is WebKit
  await expect(page.getByText(/Add to Home Screen/)).toBeVisible()
  await page.getByRole('button', { name: 'Start designing' }).click()
  await expect(page.getByText('Design mode: on iPhone you can design labels here; printing happens from a computer with Chrome or Edge.')).toBeVisible()
  // The choice is remembered: the next visit goes straight to the editor.
  await page.reload()
  await expect(page.getByRole('region', { name: 'Label preview' })).toBeVisible()
})

/** Clipboard access: Chromium grants the permissions; WebKit has no such permission names, so
 * the clipboard is an in-page stand-in there. */
async function allowClipboard(page: Page, context: BrowserContext, browserName: string): Promise<void> {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    return
  }
  await page.addInitScript(() => {
    let text = ''
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: async (t: string) => void (text = t), readText: async () => text }),
    })
  })
}

test('iPhone: Send to computer shares the link, copies it and shares the file', async ({ page, context, browserName }) => {
  await allowClipboard(page, context, browserName)
  await startDesigning(page)
  await page.getByRole('button', { name: 'Send to computer…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send to computer' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Include Wi-Fi password' })).toHaveCount(0) // nothing secret here

  const field = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(field).toHaveValue(/\/ptouch\/#d=/)
  const url = await field.inputValue()

  await dialog.getByRole('button', { name: 'Share link…' }).click()
  await expect(dialog.getByRole('status')).toHaveText(/Sent/)
  expect(await shares(page)).toEqual([{ title: 'Untitled label (ptouch label)', url }])

  await dialog.getByRole('button', { name: 'Copy' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Link copied.')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)

  await dialog.getByRole('button', { name: 'Share file…' }).click()
  await expect.poll(async () => (await shares(page)).length).toBe(2)
  const [, file] = await shares(page)
  expect(file?.files?.[0]).toMatchObject({ name: 'untitled-label.ptlabel.json', type: 'application/json' })
  expect(JSON.parse(file?.files?.[0]?.text ?? '{}').format).toBe('ptouch-label')

  // The link opens the same label (on the Mac).
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
})

test('iPhone without navigator.share (in-app browsers): no Share buttons, and the steps do not mention one', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { share?: unknown }).share
    delete (Navigator.prototype as { canShare?: unknown }).canShare
  })
  await startDesigning(page)
  await page.getByRole('button', { name: 'Send to computer…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send to computer' })
  await expect(dialog.getByRole('textbox', { name: 'Share link' })).toHaveValue(/#d=/)
  await expect(dialog.getByRole('button', { name: /^Share/ })).toHaveCount(0)
  await expect(dialog.getByRole('list', { name: 'How to print from a computer' })).not.toContainText('Tap Share')
  await expect(dialog.getByText('Copy the link, or export the file, and send it to your computer.')).toBeVisible()
})

test('iPhone: the template gallery does not ask to connect a printer', async ({ page }) => {
  await startDesigning(page)
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: /New from template/ }).click()
  const gallery = page.getByRole('dialog', { name: 'New from template' })
  await expect(gallery.getByText('Pick the template for the tape you will print on; you can change the tape width later.')).toBeVisible()
  await expect(gallery.getByText(/Connect your printer/)).toHaveCount(0)
})

test('iPhone landscape: the print bar folds its options and the "Connect printer" chip stays hidden', async ({ page }) => {
  await page.setViewportSize({ width: 812, height: 375 })
  await startDesigning(page)
  const bar = page.getByRole('contentinfo', { name: 'Print' })
  const box = await bar.boundingBox()
  expect(box?.height ?? 999).toBeLessThanOrEqual(375 * 0.3)
  await expect(page.getByRole('switch', { name: 'Mirror' })).toBeHidden() // folded behind "1 copy"
  await expect(page.getByRole('button', { name: /^Connection:/ })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('iPhone: a cancelled share sheet stays silent', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: () => Promise.reject(new DOMException('Share canceled', 'AbortError')) })
  })
  await startDesigning(page)
  await page.getByRole('button', { name: 'Send to computer…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send to computer' })
  await dialog.getByRole('button', { name: 'Share link…' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveText('')
})

test('iPhone: the Wi-Fi password is left out of the link and the file unless ticked', async ({ page }) => {
  await startDesigning(page, wifiShareHash())
  await page.getByRole('button', { name: 'Send to computer…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send to computer' })
  const include = dialog.getByRole('checkbox', { name: 'Include Wi-Fi password' })
  await expect(include).not.toBeChecked()

  const field = dialog.getByRole('textbox', { name: 'Share link' })
  await expect(field).toHaveValue(/#d=/)
  const withoutPassword = decodeLink(await field.inputValue())
  expect(withoutPassword).toContain('"ssid":"Home"')
  expect(withoutPassword).not.toContain(PASSWORD)

  await dialog.getByRole('button', { name: 'Share file…' }).click()
  await expect.poll(async () => (await shares(page)).length).toBe(1)
  expect((await shares(page))[0]?.files?.[0]?.text).not.toContain(PASSWORD)

  // Export file (iOS: a download, no save picker) leaves it out too.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export file' }).click()])
  expect(readFileSync(await download.path(), 'utf8')).not.toContain(PASSWORD)

  await include.check()
  await expect.poll(async () => decodeLink(await field.inputValue())).toContain(PASSWORD)
})

for (const width of [375, 360]) {
  test(`iPhone ${width} px: no horizontal scroll, every control ≥ 44 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 })
    await startDesigning(page)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await page.getByRole('button', { name: 'Insert QR code' }).click()
    await expect(page.getByRole('heading', { name: /Code block/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

    // Key controls, by name.
    for (const name of ['Send to computer…', 'Print label', 'Undo', 'Redo', 'Insert QR code', 'Zoom in', 'Zoom out']) {
      const box = await page.getByRole('button', { name, exact: true }).first().boundingBox()
      expect(box, name).not.toBeNull()
      expect(box?.height, name).toBeGreaterThanOrEqual(44)
      expect(box?.width, name).toBeGreaterThanOrEqual(44)
    }
    // The batch panel too (its "Paste data" disclosure is a <summary>).
    const batchToggle = page.getByRole('button', { name: /Variables & batch/ })
    await batchToggle.scrollIntoViewIfNeeded()
    await batchToggle.click()
    await expect(page.getByText('Paste data', { exact: true })).toBeVisible()
    // Every visible button, field, switch and disclosure (a checkbox inside a label counts by its label).
    const small = await page.evaluate(() => {
      const out: string[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a.btn, input, select, textarea, summary'))) {
        const input = el instanceof HTMLInputElement ? el : null
        if (input?.type === 'hidden' || input?.type === 'file') continue
        const target = input && ['checkbox', 'radio'].includes(input.type) ? (input.closest('label') ?? el) : el
        const r = target.getBoundingClientRect()
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
        if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName} "${el.getAttribute('aria-label') ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`)
      }
      return out
    })
    expect(small).toEqual([])

    // Autosave worked (WebKit's ephemeral contexts refuse Blob puts, like Safari Private Browsing).
    await expect(page.getByRole('log', { name: 'Notifications' })).not.toContainText('Could not save')

    // The hand-off dialog fits the phone and keeps 44 px controls.
    await page.getByRole('button', { name: 'Send to computer…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send to computer' })
    for (const name of ['Close', 'Copy', 'Export file', 'Share link…']) {
      const box = await dialog.getByRole('button', { name }).boundingBox()
      expect(box?.height, name).toBeGreaterThanOrEqual(44)
      expect((box?.x ?? 0) + (box?.width ?? 0), name).toBeLessThanOrEqual(width)
    }
  })
}

test('the built index.html has the iOS home-screen tags and keeps the CSP', async ({ request }) => {
  const html = await (await request.get('./')).text()
  for (const tag of [
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="ptouch" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    '<meta name="format-detection" content="telephone=no" />',
    '<link rel="apple-touch-icon" sizes="180x180" href="/ptouch/icons/apple-touch-icon.png" />',
  ]) {
    expect(html).toContain(tag)
  }
  expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/)
  expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"/)
  expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/)
  expect(html).toContain(
    `content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'"`,
  )
  const icon = await request.get('./icons/apple-touch-icon.png')
  expect(icon.ok()).toBe(true)
  expect(icon.headers()['content-type']).toBe('image/png')
  const manifest = await (await request.get('./manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ start_url: '/ptouch/', scope: '/ptouch/', display: 'standalone', short_name: 'ptouch' })
})
