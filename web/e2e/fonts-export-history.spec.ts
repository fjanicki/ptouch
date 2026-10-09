// P4 (docs/STUDIO-V1-PLAN.md) — custom fonts (upload → pick → preview changes → survives a
// reload; removed font → "not on this device"), PNG/PDF export downloads, and print history +
// tape usage after printing to the virtual printer (reprint, clear, reset).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { makeTestFont } from '../tests/unit/persist/font-fixture'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const toasts = (page: Page) => page.getByRole('log', { name: 'Notifications' })
const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })

async function previewPixels(page: Page): Promise<string> {
  return preview(page)
    .locator('canvas')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL())
}

async function settled(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
}

async function openFromLabels(page: Page, item: string, title: string) {
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: item }).click()
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Picks a font in the font picker (FontPicker: the "Font" button opens a listbox). */
async function pickFont(page: Page, name: string, group = 'Your fonts'): Promise<void> {
  await page.getByLabel('Font', { exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose a font' })
  await picker.getByRole('group', { name: group }).getByRole('option', { name, exact: true }).click()
  await expect(picker).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await settled(page)
})

test('upload a font, use it for a text block, keep it after a reload', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('HELLO')
  await settled(page)
  const before = await previewPixels(page)

  const dialog = await openFromLabels(page, 'Fonts…', 'Fonts')
  await expect(dialog.getByText('No fonts added yet.')).toBeVisible()
  await dialog.getByLabel('Font files').setInputFiles({ name: 'BoxSans.ttf', mimeType: 'font/ttf', buffer: Buffer.from(makeTestFont({ family: 'E2E Box Sans' })) })
  const fonts = dialog.getByRole('list', { name: 'Your fonts' })
  await expect(fonts.getByText('E2E Box Sans', { exact: true })).toBeVisible()
  await expect(fonts).toContainText('TrueType')
  // A file that is not a font is refused with a message.
  await dialog.getByLabel('Font files').setInputFiles({ name: 'notes.ttf', mimeType: 'font/ttf', buffer: Buffer.from('just some text, not a font') })
  await expect(dialog.getByRole('alert')).toContainText('not a font file')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await pickFont(page, 'E2E Box Sans')
  await expect.poll(() => previewPixels(page)).not.toBe(before)
  await settled(page)
  await expect(page.getByText('From the font file')).toBeVisible()
  const withFont = await previewPixels(page)

  // Stored in IndexedDB: still there (and still used) after a reload (once autosave ran).
  await expect.poll(() => savedLabelsJson(page)).toContain('"customFont"')
  await page.reload()
  await settled(page)
  await expect(page.getByLabel('Font', { exact: true })).toHaveText('E2E Box Sans')
  await expect.poll(() => previewPixels(page)).toBe(withFont)

  // Removing it: the block falls back to the built-in font and says so.
  page.once('dialog', (d) => void d.accept())
  const again = await openFromLabels(page, 'Fonts…', 'Fonts')
  await again.getByRole('button', { name: 'Remove E2E Box Sans' }).click()
  await expect(again.getByText('No fonts added yet.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('“E2E Box Sans” is not on this device — using Fira Sans.')).toBeVisible()
  await expect(page.getByLabel('Weight')).toBeVisible()
  await page.getByRole('button', { name: 'Choose font…' }).click()
  await expect(page.getByRole('dialog', { name: 'Fonts' })).toBeVisible()
})

test('fonts from this computer: listed on request, missing ones fall back with a note', async ({ page }) => {
  // Local Font Access stub: one font that no machine has, so local("…") never resolves.
  await page.addInitScript(() => {
    const w = window as unknown as { queryLocalFonts: () => Promise<unknown[]>; __localQueries: number }
    w.__localQueries = 0
    w.queryLocalFonts = async () => {
      w.__localQueries++
      return [{ family: 'Ptouch E2E', fullName: 'Ptouch E2E Missing', postscriptName: 'PtouchE2E-Missing', style: 'Regular' }]
    }
  })
  await page.reload()
  await settled(page)
  await page.getByLabel('Text', { exact: true }).fill('Local')
  const dialog = await openFromLabels(page, 'Fonts…', 'Fonts')
  // No permission prompt until the user asks.
  expect(await page.evaluate(() => (window as unknown as { __localQueries: number }).__localQueries)).toBe(0)
  await dialog.getByRole('button', { name: 'Use fonts from this computer…' }).click()
  await expect(dialog.getByText('1 font available.', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await pickFont(page, 'Ptouch E2E Missing', 'This computer (varies by machine)')
  await expect(page.getByText('“Ptouch E2E Missing” is not on this device — using Fira Sans.')).toBeVisible()
  await expect(preview(page).getByText(/not available on this device/)).toBeVisible()
})

test('export the label as PNG and PDF', async ({ page }) => {
  await page.getByLabel('Label name').fill('Cable tags')
  await page.getByLabel('Text', { exact: true }).fill('Export me')
  await settled(page)
  const dialog = await openFromLabels(page, 'Export image (PNG, PDF)…', 'Export image')
  await expect(dialog.getByText('180 dpi', { exact: false }).first()).toBeVisible()

  const [png] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Download PNG/ }).click()])
  expect(png.suggestedFilename()).toBe('cable-tags.png')
  const pngBytes = await readDownload(png)
  expect([...pngBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  // IHDR: height = the 24 mm printable band (128 dots), 1-bit greyscale.
  expect(pngBytes.readUInt32BE(20)).toBe(128)
  expect([pngBytes[24], pngBytes[25]]).toEqual([1, 0])
  expect(pngBytes.includes(Buffer.from('pHYs'))).toBe(true)

  const [pdf] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Download PDF/ }).click()])
  expect(pdf.suggestedFilename()).toBe('cable-tags.pdf')
  const pdfText = (await readDownload(pdf)).toString('latin1')
  expect(pdfText.startsWith('%PDF-1.4')).toBe(true)
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdfText)
  expect((Number(box?.[2]) * 25.4) / 72).toBeCloseTo(24, 0)
})

test('printed labels land in the history and the tape counter; reprint, clear, reset', async ({ page }) => {
  page.on('dialog', (d) => void d.accept()) // confirm() for clear / reset
  await page.getByLabel('Label name').fill('Shelf B')
  await page.getByLabel('Text', { exact: true }).fill('Shelf B')
  await chip(page).click()
  await page.getByRole('dialog', { name: /Connect your printer/ }).getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await settled(page)
  await page.getByRole('button', { name: 'Print label' }).click()
  await expect(toasts(page).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 20_000 })

  let dialog = await openFromLabels(page, 'Print history…', 'Print history')
  const list = dialog.getByRole('list', { name: 'Printed labels' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Shelf B')
  await expect(list).toContainText('24 mm tape · 1 label')
  await expectUsage(dialog, 1, 1)

  await dialog.getByRole('button', { name: 'Reprint Shelf B' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => {
    const d = await openFromLabels(page, 'Print history…', 'Print history')
    const n = await d.getByRole('list', { name: 'Printed labels' }).getByRole('listitem').count()
    await page.keyboard.press('Escape')
    return n
  }, { timeout: 20_000 }).toBe(2)

  dialog = await openFromLabels(page, 'Print history…', 'Print history')
  await expectUsage(dialog, 2, 2)
  await dialog.getByRole('button', { name: 'Reset counter' }).click()
  await expect(dialog.getByText(/^Nothing printed since/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Clear history' }).click()
  await expect(dialog.getByText(/Labels you print show up here/)).toBeVisible()
})

/** Every label autosave stored (IndexedDB `ptouch-labels`), as JSON. */
async function savedLabelsJson(page: Page): Promise<string> {
  return page.evaluate(async () => {
    // Never open (= create) the database before the app has: idb-keyval creates its store only
    // when it creates the database.
    if (!(await indexedDB.databases()).some((d) => d.name === 'ptouch-labels')) return ''
    return new Promise<string>((resolve) => {
      const req = indexedDB.open('ptouch-labels')
      req.onerror = () => resolve('')
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('labels')) return resolve('')
        const all = db.transaction('labels').objectStore('labels').getAll()
        all.onsuccess = () => resolve(JSON.stringify(all.result))
        all.onerror = () => resolve('')
      }
    })
  })
}

/** The 24 mm row of the tape usage table: used length, labels, jobs. */
async function expectUsage(dialog: Locator, labels: number, jobs: number): Promise<void> {
  const cells = dialog.getByRole('table').getByRole('row', { name: /^24 mm/ }).getByRole('cell')
  await expect(cells.nth(0)).toHaveText(/^\d+ mm$/)
  await expect(cells.nth(1)).toHaveText(String(labels))
  await expect(cells.nth(2)).toHaveText(String(jobs))
}

async function readDownload(d: import('@playwright/test').Download): Promise<Buffer> {
  const stream = await d.createReadStream()
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(parts)
}
