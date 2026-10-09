// Studio v1 integration (docs/STUDIO-V1-PLAN.md §4): flows that cross the packages, checked on
// the dots the printer received. Web Serial is the wasm VirtualPrinter (e2e/fixtures/
// virtual-serial.ts); the expected symbol is encoded by the same wasm bindings (`encodeCode`)
// from the payload the test expects, then searched for in the printed page module by module —
// so a match proves the exact WIFI:/DataMatrix content and its module size on the tape.
//  (a) Wi-Fi sticker template on 12 mm → SSID/password → print → WIFI: string; share link
//      without the password.          (b) 3-row CSV batch → 3 thumbnails → ONE chained job.
//  (c) DataMatrix prints.             (d) compact + auto module size → a larger QR on 12 mm.
//  Also the integration fixes: batch preparation can be cancelled, an unknown variable blocks
//  a single print, the Labels menu keeps its name on phones, theme-color follows the theme,
//  and design-only phones hide the idle connection chip.
// Export (PNG/PDF) and history/reprint: e2e/fonts-export-history.spec.ts; the iPhone hand-off:
// e2e/iphone.spec.ts.
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'
import { stubVirtualSerial, type VirtualSerialWindow } from './fixtures/virtual-serial'

// The routed __e2e__ bindings must not be answered by the service worker.
test.use({ serviceWorkers: 'block' })

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const toasts = (page: Page) => page.getByRole('log', { name: 'Notifications' })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })

type Spec = { symbology: 'qr'; data: string; ecc: 'L' | 'M' | 'Q' | 'H' } | { symbology: 'datamatrix'; data: string }
interface Found {
  /** Dots per module. */
  m: number
  x: number
  y: number
  /** Modules per side. */
  size: number
}

async function ready(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
}

async function connectBluetooth(page: Page, tape: RegExp): Promise<void> {
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(tape)
  await expect(page.locator('dialog.connect')).toBeHidden() // closes itself after a moment
}

/** Switches are toggled from the keyboard (their styled track covers the input). */
async function turnOn(page: Page, sw: Locator): Promise<void> {
  await sw.focus()
  await page.keyboard.press('Space')
  await expect(sw).toBeChecked()
}

/** The label JSON inside a share link. */
function decodeLink(url: string): string {
  const payload = url.split('#d=')[1] ?? ''
  return inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8')
}

/**
 * Looks for the symbol `specs` encodes (any of them: e.g. every QR error-correction level) in
 * `source`: the printed page `n` as the printer decoded the bytes it received, or the preview
 * canvas. Every module must be all ink or all blank at the found scale and offset.
 */
async function findSymbol(page: Page, specs: Spec[], source: { printed: number } | 'preview'): Promise<Found | null> {
  const canvas = source === 'preview' ? preview(page).locator('canvas').first() : page.locator('body')
  return canvas.evaluate(
    async (el, [specs, source]) => {
      type Bmp = { length: number; height: number; get(x: number, y: number): boolean; free(): void }
      type Wasm = {
        encodeCode(s: unknown): { width: number; height: number; modules: number[] }
        decodeJob(m: string, b: Uint8Array): { pages(): Bmp[]; free(): void }
      }
      const w = window as unknown as VirtualSerialWindow & { __e2eWasm?: Wasm }
      if (!w.__vsWasm && !w.__e2eWasm) {
        const base = document.baseURI
        const mod = (await import(/* @vite-ignore */ new URL('__e2e__/ptouch.js', base).href)) as Wasm & { default: (o: { module_or_path: URL }) => Promise<unknown> }
        await mod.default({ module_or_path: new URL('__e2e__/ptouch_bg.wasm', base) })
        w.__e2eWasm = mod
      }
      const wasm = (w.__vsWasm as unknown as Wasm | undefined) ?? (w.__e2eWasm as Wasm)

      // The dots as a 0/1 grid.
      let W = 0
      let H = 0
      let dots: Uint8Array
      if (source === 'preview') {
        const c = el as HTMLCanvasElement
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        const { width, height, data } = ctx.getImageData(0, 0, c.width, c.height)
        W = width
        H = height
        dots = new Uint8Array(W * H)
        for (let i = 0; i < W * H; i++) dots[i] = 0.299 * (data[i * 4] as number) + 0.587 * (data[i * 4 + 1] as number) + 0.114 * (data[i * 4 + 2] as number) < 128 ? 1 : 0
      } else {
        const job = wasm.decodeJob('PT-P710BT', Uint8Array.from(w.__vsWrites.flat()))
        const pages = job.pages()
        const p = pages[source.printed]
        if (!p) throw new Error(`no printed page ${source.printed}`)
        W = p.length
        H = p.height
        dots = new Uint8Array(W * H)
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dots[y * W + x] = p.get(x, y) ? 1 : 0
        for (const q of pages) q.free()
        job.free()
      }

      for (const spec of specs) {
        const mx = wasm.encodeCode(spec)
        const n = mx.width
        for (let m = 16; m >= 1; m--) {
          const side = n * m
          for (let y0 = 0; y0 + side <= H; y0++)
            for (let x0 = 0; x0 + side <= W; x0++) {
              let ok = true
              for (let r = 0; r < n && ok; r++)
                for (let c = 0; c < n && ok; c++) {
                  const v = mx.modules[r * n + c] as number
                  for (let dy = 0; dy < m && ok; dy++) for (let dx = 0; dx < m && ok; dx++) if (dots[(y0 + r * m + dy) * W + x0 + c * m + dx] !== v) ok = false
                }
              if (ok) return { m, x: x0, y: y0, size: n }
            }
        }
      }
      return null
    },
    [specs, source] as const,
  )
}

/** Decoded job summary: pages, protocol violations, and the command list. */
async function decodedJob(page: Page, fromWrite = 0): Promise<{ pages: number; violations: string[]; printed: number; printerViolations: string[]; commands: string[]; distinctPages: number }> {
  return page.evaluate((from) => {
    type Bmp = { length: number; height: number; get(x: number, y: number): boolean; free(): void }
    const w = window as unknown as VirtualSerialWindow
    const mod = w.__vsWasm as unknown as { decodeJob(m: string, b: Uint8Array): { pages(): Bmp[]; violations(): string[]; commands(): string[]; pageCount: number; free(): void } }
    const vp = w.__vsPrinter
    if (!mod || !vp) throw new Error('virtual serial port was never opened')
    const job = mod.decodeJob('PT-P710BT', Uint8Array.from(w.__vsWrites.slice(from).flat()))
    const pages = job.pages()
    const keys = new Set(
      pages.map((p) => {
        let s = `${p.length}x${p.height}:`
        for (let x = 0; x < p.length; x++) for (let y = 0; y < p.height; y++) s += p.get(x, y) ? '1' : '0'
        return s
      }),
    )
    for (const p of pages) p.free()
    const out = { pages: job.pageCount, violations: job.violations(), printed: vp.printedCount, printerViolations: vp.violations(), commands: job.commands(), distinctPages: keys.size }
    job.free()
    return out
  }, fromWrite)
}

/** Chunks written to the port so far (to decode only what a print sends). */
const writeCount = (page: Page) => page.evaluate(() => (window as unknown as VirtualSerialWindow).__vsWrites.length)

const ALL_ECC = ['L', 'M', 'Q', 'H'] as const

test('(a) Wi-Fi sticker 12 mm: fill the network, print, the QR holds the WIFI: string; the share link has no password', async ({ page, context }) => {
  test.setTimeout(90_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await stubVirtualSerial(page, { mediaId: 'tze128-12', openFailures: 0 })
  await page.goto('./')
  await ready(page)

  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: /New from template/ }).click()
  await page.getByRole('dialog', { name: 'New from template' }).getByRole('button', { name: 'Wi-Fi sticker (12 mm)', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Code block/ })).toBeVisible()
  // `;` and `:` must be escaped in the payload.
  await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill('Cafe;5G')
  await page.getByLabel('Password', { exact: true }).fill('p@ss:word1')
  await ready(page)
  await expect(preview(page).getByRole('alert')).toHaveCount(0)

  await connectBluetooth(page, /PT-P710BT · 12 mm/)
  await expect(printButton(page)).toBeEnabled()
  await printButton(page).click()
  await expect(toasts(page).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 45_000 })

  const job = await decodedJob(page)
  expect(job.violations).toEqual([])
  expect(job.printerViolations).toEqual([])
  expect(job.pages).toBe(1)
  const found = await findSymbol(page, ALL_ECC.map((ecc) => ({ symbology: 'qr' as const, data: 'WIFI:T:WPA;S:Cafe\\;5G;P:p@ss\\:word1;;', ecc })), { printed: 0 })
  expect(found, 'the printed QR encodes the escaped WIFI: string').not.toBeNull()
  expect(found?.m).toBeGreaterThanOrEqual(2) // "OK close up" or better on 12 mm

  // The share link keeps the network name and leaves the password out by default.
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Share without the Wi-Fi password?' })
  await expect(dialog.getByRole('checkbox', { name: 'Include Wi-Fi password' })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Continue without password' }).click()
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  await expect.poll(clipboard).toContain('#d=')
  const shared = decodeLink(await clipboard())
  expect(shared).toContain('"ssid":"Cafe;5G"')
  expect(shared).not.toContain('p@ss:word1')
})

/** Pastes `csv` into the batch panel's table (opens the panel). */
async function pasteBatch(page: Page, csv: string): Promise<void> {
  const toggle = page.getByRole('button', { name: /Variables & batch/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  // The panel body loads lazily: wait for its paste disclosure.
  const summary = page.locator('summary', { hasText: /^(Paste data|Replace with pasted data…)$/ })
  await expect(summary).toBeVisible()
  const box = page.getByLabel('Paste from a spreadsheet or CSV (first row = column names)')
  if (!(await box.isVisible())) await summary.click()
  await box.fill(csv)
  await page.getByRole('button', { name: 'Use pasted data' }).click()
}

test('Wi-Fi passwords from a batch column ({{pw}}) are left out of the share link too', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('./')
  await ready(page)
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: /New from template/ }).click()
  await page.getByRole('dialog', { name: 'New from template' }).getByRole('button', { name: 'Wi-Fi sticker (12 mm)', exact: true }).click()
  await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill('Guest {{room}}')
  await page.getByLabel('Password', { exact: true }).fill('{{pw}}')
  await pasteBatch(page, 'room,pw\n101,S3cret-101\n102,S3cret-102\n')
  await ready(page)

  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Share without the Wi-Fi password?' })
  await dialog.getByRole('button', { name: 'Continue without password' }).click()
  await expect(toasts(page).filter({ hasText: /\{\{pw\}\} column of the data table/ })).toBeVisible()
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  await expect.poll(clipboard).toContain('#d=')
  const shared = decodeLink(await clipboard())
  expect(shared).toContain('"101"')
  expect(shared).not.toContain('S3cret-10')
})

test('a header-only table blocks printing instead of printing blank labels', async ({ page }) => {
  await page.goto('./')
  await ready(page)
  await page.getByLabel('Text', { exact: true }).fill('Hi {{name}}')
  await pasteBatch(page, 'name\n')
  await ready(page)
  await expect(page.locator('#print-reason')).toHaveText('The data table has no rows, so {{name}} would print blank: paste data or add a row.')
  await expect(printButton(page)).toBeDisabled()
})

test('(b) a 3-row CSV: 3 thumbnails, and the printer gets ONE chained job with 3 different pages', async ({ page }) => {
  test.setTimeout(90_000)
  await stubVirtualSerial(page, { openFailures: 0 })
  await page.goto('./')
  await ready(page)
  await page.getByLabel('Text', { exact: true }).fill('{{name}}')
  await page.getByRole('button', { name: /Variables & batch/ }).click()
  await page.getByLabel('Paste from a spreadsheet or CSV (first row = column names)').fill('name\nAda\nGrace\nLinus\n')
  await page.getByRole('button', { name: 'Use pasted data' }).click()
  const labels = page.getByRole('list', { name: 'Batch labels' })
  await labels.scrollIntoViewIfNeeded()
  await expect(labels.locator('canvas[data-painted]')).toHaveCount(3, { timeout: 15_000 })

  // Chain printing: no cut after the last label, so the next job wastes no leader.
  await connectBluetooth(page, /PT-P710BT · 24 mm/)
  const chain = page.getByRole('switch', { name: 'Chain' })
  if (!(await chain.isChecked())) await turnOn(page, chain)
  await expect(chain).toBeChecked()
  await expect(printButton(page)).toHaveText(/Print 3 labels/)
  await expect(printButton(page)).toBeEnabled()
  const before = await writeCount(page)
  await printButton(page).click()
  await expect(toasts(page).filter({ hasText: '3 labels printed' })).toBeVisible({ timeout: 60_000 })

  const job = await decodedJob(page, before)
  expect(job.violations).toEqual([])
  expect(job.printerViolations).toEqual([])
  expect(job.pages).toBe(3)
  expect(job.printed).toBe(3)
  expect(job.distinctPages).toBe(3)
  // Chain on: the advanced-mode "no chain printing" bit (0x08) is clear on every page.
  const advanced = job.commands.flatMap((c) => /^AdvancedMode\((\d+)\)$/.exec(c)?.[1] ?? []).map(Number)
  expect(advanced).toHaveLength(3)
  expect(advanced.every((v) => (v & 0x08) === 0)).toBe(true)
  // One job: initialised once, two "print" (next page) commands and one final one. Status
  // requests in between decode as their own commands and are ignored here.
  expect(job.commands.filter((c) => /^Initialize/.test(c))).toHaveLength(1)
  expect(job.commands.filter((c) => /^Print\b(?!Last)/.test(c))).toHaveLength(2)
  expect(job.commands.filter((c) => /^PrintLast/.test(c))).toHaveLength(1)
})

test('(c) a DataMatrix block renders and prints', async ({ page }) => {
  test.setTimeout(90_000)
  await stubVirtualSerial(page, { openFailures: 0 })
  await page.goto('./')
  await ready(page)
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await page.getByRole('radio', { name: 'DataMatrix' }).click()
  await page.getByLabel('Content').fill('A-0001')
  await ready(page)
  await expect(preview(page).getByRole('alert')).toHaveCount(0)
  const shown = await findSymbol(page, [{ symbology: 'datamatrix', data: 'A-0001' }], 'preview')
  expect(shown).not.toBeNull()

  await connectBluetooth(page, /PT-P710BT · 24 mm/)
  await printButton(page).click()
  await expect(toasts(page).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 45_000 })
  const job = await decodedJob(page)
  expect(job.violations).toEqual([])
  const printed = await findSymbol(page, [{ symbology: 'datamatrix', data: 'A-0001' }], { printed: 0 })
  expect(printed).toEqual(shown) // same place, same size as the preview
})

test('(d) on 12 mm tape, the compact quiet zone with automatic size prints a larger QR than standard', async ({ page }) => {
  await stubVirtualSerial(page) // only for the test-side wasm bindings
  await page.goto('./')
  await ready(page)
  await page.getByRole('radio', { name: '12' }).click()
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await page.getByLabel('Content').fill('HELLO')
  await ready(page)
  const qr = ALL_ECC.map((ecc) => ({ symbology: 'qr' as const, data: 'HELLO', ecc }))
  const standard = await findSymbol(page, qr, 'preview')
  await page.getByRole('radiogroup', { name: 'Quiet zone' }).getByRole('radio', { name: 'Compact' }).click()
  await ready(page)
  const compact = await findSymbol(page, qr, 'preview')
  expect(standard?.size).toBe(21)
  expect(standard?.m).toBe(2) // 42 dots ≈ 5.9 mm
  expect(compact?.m).toBe(3) // 63 dots ≈ 8.9 mm of the 70-dot band
})

test('a batch can be cancelled while its labels are prepared; nothing is sent', async ({ page }) => {
  test.setTimeout(90_000)
  await stubVirtualSerial(page, { openFailures: 0 })
  await page.goto('./')
  await ready(page)
  await page.getByLabel('Text', { exact: true }).fill('Item {{n}}')
  await page.getByRole('button', { name: /Variables & batch/ }).click()
  await turnOn(page, page.getByRole('switch', { name: 'Print as a batch' }))
  const count = page.getByLabel('Labels to print (without data)')
  await count.fill('400')
  await count.press('Tab')
  await connectBluetooth(page, /PT-P710BT · 24 mm/)
  const writesBefore = await writeCount(page)
  await expect(printButton(page)).toHaveText(/Print 400 labels/)
  await expect(printButton(page)).toBeEnabled({ timeout: 30_000 })
  await printButton(page).click()
  await expect(page.getByText(/Preparing label \d+ of 400/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(toasts(page).filter({ hasText: 'Printing cancelled' })).toBeVisible()
  await expect(printButton(page)).toBeEnabled()
  // Only status requests went out, no raster data.
  const sent = await page.evaluate((n) => (window as unknown as VirtualSerialWindow).__vsWrites.slice(n).reduce((a, c) => a + c.length, 0), writesBefore)
  expect(sent).toBeLessThan(64)
  expect(await page.evaluate(() => (window as unknown as VirtualSerialWindow).__vsPrinter?.printedCount)).toBe(0)
})

test('an unknown variable blocks a single print with the reason', async ({ page }) => {
  await page.goto('./')
  await ready(page)
  await page.getByLabel('Text', { exact: true }).fill('Room {{room}}')
  await ready(page)
  await expect(page.locator('#print-reason')).toHaveText('Unknown variable {{room}}: add a column or counter with that name, or fix the spelling.')
  await expect(printButton(page)).toBeDisabled()
})

test('theme-color follows the in-app theme', async ({ page }) => {
  await page.goto('./')
  await ready(page)
  const media = () => page.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => `${m.content} ${m.media}`))
  expect(await media()).toEqual(['#ffffff (prefers-color-scheme: light)', '#191e29 (prefers-color-scheme: dark)'])
  const toggle = page.getByRole('button', { name: /theme \(click to change\)/ })
  await toggle.click() // system → light
  expect(await media()).toEqual(['#ffffff all', '#191e29 not all'])
  await toggle.click() // light → dark
  expect(await media()).toEqual(['#ffffff not all', '#191e29 all'])
  await toggle.click() // dark → system
  expect(await media()).toEqual(['#ffffff (prefers-color-scheme: light)', '#191e29 (prefers-color-scheme: dark)'])
})

test.describe('phones', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true })

  test('the Labels menu keeps its accessible name at 360 px', async ({ page }) => {
    await page.goto('./')
    await ready(page)
    await page.getByRole('button', { name: 'Labels' }).click()
    await expect(page.getByRole('menu', { name: 'Labels' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(chip(page)).toBeVisible() // printing is possible here: the chip stays
    // The theme moves into "More", leaving the label name room to read.
    await expect(page.getByRole('button', { name: /theme \(click to change\)/ })).toBeHidden()
    expect(await page.getByRole('textbox', { name: 'Label name' }).evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(110)
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Use light theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })

  test('design-only (no Web Serial / WebUSB): the idle connection chip gives way to the hand-off', async ({ page }) => {
    await removeDeviceApis(page)
    await page.goto('./')
    await page.getByRole('button', { name: 'Design labels anyway' }).click()
    await ready(page)
    await expect(chip(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Send to computer…' })).toBeVisible()
    await expect(page.locator('#print-reason')).toHaveText(/needs Chrome or Edge/)
    await page.getByRole('button', { name: 'Send to computer…' }).click()
    await expect(page.getByRole('dialog', { name: 'Send to computer' })).toBeVisible()
  })
})
