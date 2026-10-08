// End-to-end integration: the production build under /ptouch/, Web Serial replaced by a
// Bluetooth port whose far end is the wasm VirtualPrinter (e2e/fixtures/virtual-serial.ts).
// Connect (first open fails like the real Mac) → chip shows PT-P710BT 24 mm → add a text block
// → print → progress → completion; then the job the printer received, decoded by the core,
// must equal the preview bitmap dot for dot.
import { expect, test, type Page } from '@playwright/test'
import { stubVirtualSerial, type VirtualSerialWindow } from './fixtures/virtual-serial'

// The routed __e2e__ bindings must not be answered by the service worker.
test.use({ serviceWorkers: 'block' })

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })

interface Comparison {
  violations: string[]
  printedCount: number
  decodedPages: number
  decodeViolations: string[]
  preview: { width: number; height: number; ink: number }
  printed: { length: number; height: number; ink: number; diff: number }
  decoded: { length: number; height: number; ink: number; diff: number }
}

/** Reads the preview canvas (exact dots, tinted) and compares it with what the printer got. */
async function compareWithPreview(page: Page): Promise<Comparison> {
  return preview(page)
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      type Bmp = { length: number; height: number; get(x: number, y: number): boolean; free(): void }
      const w = window as unknown as VirtualSerialWindow
      const mod = w.__vsWasm as unknown as { decodeJob(m: string, b: Uint8Array): { pages(): Bmp[]; violations(): string[]; pageCount: number; free(): void } }
      const vp = w.__vsPrinter
      if (!mod || !vp) throw new Error('virtual serial port was never opened')

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // Ink is drawn in the cassette's ink colour (black on this white tape).
      const inkAt = (x: number, y: number) => {
        const i = (y * width + x) * 4
        return 0.299 * (data[i] as number) + 0.587 * (data[i + 1] as number) + 0.114 * (data[i + 2] as number) < 128
      }
      let previewInk = 0
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inkAt(x, y)) previewInk++

      const diffOf = (b: Bmp) => {
        let ink = 0
        let diff = 0
        for (let y = 0; y < b.height; y++)
          for (let x = 0; x < b.length; x++) {
            const dot = b.get(x, y)
            if (dot) ink++
            if (x >= width || y >= height ? dot : dot !== inkAt(x, y)) diff++
          }
        return { length: b.length, height: b.height, ink, diff }
      }

      const printedPage = vp.printedPage(0)
      if (!printedPage) throw new Error('nothing printed')
      const printed = diffOf(printedPage)
      printedPage.free()

      const decodedJob = mod.decodeJob('PT-P710BT', Uint8Array.from(w.__vsWrites.flat()))
      const pages = decodedJob.pages()
      const firstPage = pages[0]
      if (!firstPage) throw new Error('decoded job has no pages')
      const decoded = diffOf(firstPage)
      for (const p of pages) p.free()
      const result = {
        violations: vp.violations(),
        printedCount: vp.printedCount,
        decodedPages: decodedJob.pageCount,
        decodeViolations: decodedJob.violations(),
        preview: { width, height, ink: previewInk },
        printed,
        decoded,
      }
      decodedJob.free()
      return result
    })
}

test('Bluetooth to the wasm virtual printer: connect, add text, print, decoded job equals the preview', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await stubVirtualSerial(page, { openFailures: 1 })
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')

  // Connect over "Bluetooth": the first open() fails with NetworkError, the retry wakes it.
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as VirtualSerialWindow).__vsOpenAttempts)).toBe(2)

  // Add a text block and edit it; wait for the preview to settle on the new content.
  await page.getByLabel('Text', { exact: true }).fill('ptouch')
  await page.getByRole('button', { name: 'Insert Text' }).click()
  const blocks = page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
  await expect(blocks).toHaveCount(2)
  await page.getByLabel('Text', { exact: true }).fill('studio 24 mm')
  await expect(blocks.nth(1)).toContainText('studio 24 mm')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)

  // Print: progress comes from the printer's status pushes, then the completion toast.
  await expect(printButton(page)).toBeEnabled()
  await printButton(page).click()
  await expect(page.getByRole('progressbar', { name: 'Print progress' })).toBeVisible()
  await expect(page.getByText(/(Sending|Printing) label 1 of 1|Printing label/).first()).toBeVisible()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 30_000 })
  await expect(printButton(page)).toBeEnabled()

  const c = await compareWithPreview(page)
  expect(c.violations).toEqual([])
  expect(c.decodeViolations).toEqual([])
  expect(c.printedCount).toBe(1)
  expect(c.decodedPages).toBe(1)
  expect(c.preview.ink).toBeGreaterThan(200) // the label is not blank
  for (const page of [c.printed, c.decoded]) {
    expect({ length: page.length, height: page.height }).toEqual({ length: c.preview.width, height: c.preview.height })
    expect(page.ink).toBe(c.preview.ink)
    expect(page.diff).toBe(0)
  }
  expect(errors).toEqual([])
})
