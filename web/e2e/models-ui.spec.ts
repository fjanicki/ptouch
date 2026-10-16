// P-core-ui (docs/MODELS-PLAN.md §3.4–§3.8) — the model picker (Design for), Bluetooth LE / design-
// only models, the unsupported-width notice ("Fit to …", "Design for …") and the blocked Print,
// the media bar while a printer is connected, a real (stubbed Web Serial) printer of an untested
// model with its dismissible notice, Diagnostics following the model, and 375 px without
// horizontal scroll.
import { expect, test, type Page } from '@playwright/test'
import { stubSerial } from './fixtures/serial-stub'

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const mediaBar = (page: Page) => page.getByRole('region', { name: 'Tape and length' })
const widths = (page: Page) => page.getByRole('radiogroup', { name: 'Tape width (mm)' })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })

/** The real PT-P710BT status frame with the PT-P910BT's model code (st[4]) and 36 mm laminated
 * tape (st[10]): what a PT-P910BT answers over Bluetooth. */
const P910BT_STATUS_36MM = [
  0x80, 0x20, 0x42, 0x30, 0x78, 0x30, 0x00, 0x00, 0x00, 0x00, 0x24, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]

async function ready(page: Page): Promise<void> {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
}

/** Design for `model` in the media bar (no printer connected). */
async function designFor(page: Page, model: string): Promise<void> {
  await mediaBar(page).getByLabel('Printer model').selectOption(model)
  await expect(mediaBar(page).getByLabel('Printer model')).toHaveValue(model)
}

/** A 36 mm label designed for the PT-P910BT, then the PT-P710BT picked: the notice shows. */
async function unsupported36(page: Page): Promise<void> {
  await designFor(page, 'PT-P910BT')
  await widths(page).getByRole('radio', { name: '36' }).click()
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await designFor(page, 'PT-P710BT')
  await expect(page.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })).toBeVisible()
}

test('the model picker groups models a browser can reach; a Bluetooth LE model is design-only but selectable', async ({ page }) => {
  await ready(page)
  const picker = mediaBar(page).getByLabel('Printer model')
  await expect(picker).toHaveValue('PT-P710BT')
  await expect(picker.locator('option:checked')).toHaveText('PT-P710BT · up to 24 mm · tested')
  await expect(picker.locator('optgroup[label="Connects from this browser"] option')).toContainText(['PT-P710BT · up to 24 mm · tested'])
  await expect(picker.locator('optgroup[label^="Design only"] option', { hasText: 'PT-N25BT' })).toHaveCount(1)
  await expect(picker.locator('optgroup[label="Connects from this browser"] option', { hasText: 'PT-N25BT' })).toHaveCount(0)

  // PT-N25BT: Bluetooth LE only. The untouched label follows it to 12 mm; the note says why it
  // can't be connected, and it stays fully usable for designing.
  await designFor(page, 'PT-N25BT')
  await expect(mediaBar(page).getByText('Bluetooth LE only: a browser can’t connect to it. Design and export labels here.')).toBeVisible()
  await expect(picker).toHaveAccessibleDescription(/Bluetooth LE only/)
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12'])
  await expect(widths(page).getByRole('radio', { name: '12' })).toBeChecked()
  await expect(preview(page).getByRole('figure', { name: /on 12 mm tape/ })).toBeVisible()

  // Remembered per browser, and offered in the connect dialog too ("No printer" uses it).
  await page.reload()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(mediaBar(page).getByLabel('Printer model')).toHaveValue('PT-N25BT')
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await expect(dialog.getByLabel('Printer model')).toHaveValue('PT-N25BT')
  await expect(dialog.getByRole('button', { name: /^No printer/ })).toContainText('virtual PT-N25BT')
  await expect(dialog).toContainText(/Your Brother P-touch label printer \(e\.g\. PT-P710BT\)/)
  await expect(dialog).not.toContainText('Brother PT-P710BT over')
})

test('a width the model lacks: notice, blocked Print, “Design for” the label’s model, “Fit to”', async ({ page }) => {
  await ready(page)
  await unsupported36(page)
  const notice = page.getByRole('alert').filter({ hasText: 'This label is 36 mm' })
  // The label keeps its width (rendered with a stand-in model) and no width is checked.
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await expect(widths(page).getByRole('radio', { checked: true })).toHaveCount(0)

  // Print is blocked, on the virtual PT-P710BT too, with the same sentence.
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(printButton(page)).toBeDisabled()
  await expect(page.locator('#print-reason')).toHaveText('This label is 36 mm; PT-P710BT takes up to 24 mm. Fit it to 24 mm to print it.')
  // While a printer is connected, the media bar names it instead of the picker; no "Design for"
  // shortcut (the connected printer wins).
  await expect(mediaBar(page).getByLabel('Printer model')).toHaveCount(0)
  await expect(mediaBar(page)).toContainText('PT-P710BT (virtual printer)')
  await expect(notice.getByRole('button', { name: /^Design for/ })).toHaveCount(0)
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // "Design for PT-P910BT" goes back to the model the label was made for; focus moves to the
  // width now checked (the pressed button is gone) and the change is announced.
  await notice.getByRole('button', { name: 'Design for PT-P910BT' }).press('Enter')
  await expect(notice).toBeHidden()
  await expect(mediaBar(page).getByLabel('Printer model')).toHaveValue('PT-P910BT')
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeChecked()
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeFocused()
  await expect(page.locator('[aria-live="polite"][aria-atomic="true"]').first()).toHaveText('Designing for PT-P910BT')

  // Back on the PT-P710BT, "Fit to 24 mm" retapes (one undo step) and keeps focus on the widths.
  await designFor(page, 'PT-P710BT')
  await notice.getByRole('button', { name: 'Fit to 24 mm' }).click()
  await expect(notice).toBeHidden()
  await expect(widths(page).getByRole('radio', { name: '24' })).toBeChecked()
  await expect(widths(page).getByRole('radio', { name: '24' })).toBeFocused()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(notice).toBeVisible()
})

test('a real printer of an untested model: notice with Diagnostics and a report link; Dismiss is remembered', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, status: P910BT_STATUS_36MM })
  await ready(page)
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(page.getByRole('dialog')).toBeHidden()
  // The untouched label follows the cassette, and the widths are the PT-P910BT's.
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24', '36 •'])
  await expect(mediaBar(page)).toContainText('PT-P910BT (connected)')

  const notice = page.getByRole('status', { name: 'Untested printer model' })
  await expect(notice).toContainText('PT-P910BT hasn’t been tested with ptouch studio yet.')
  const href = (await notice.getByRole('link', { name: 'Report an issue' }).getAttribute('href')) ?? ''
  const url = new URL(href)
  expect(url.pathname).toBe('/fjanicki/ptouch/issues/new')
  expect(url.searchParams.get('title')).toBe('Untested model: PT-P910BT')
  expect(url.searchParams.get('body')).toMatch(/^Model: PT-P910BT\nConnection: Bluetooth\n/)
  expect(href).not.toMatch(/PT-P910BT[0-9A-F]{4}|(?:[0-9A-F]{2}%3A){5}/i)

  // Diagnostics names the model; the virtual-printer tape list is the model's.
  await notice.getByRole('button', { name: 'Open Diagnostics' }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible()
  await expect(page.locator('dt:text-is("Model") + dd')).toHaveText('PT-P910BT (untested)')
  await expect(page.getByLabel('Tape').locator('option')).toHaveText(['3.5 mm', '6 mm', '9 mm', '12 mm', '18 mm', '24 mm', '36 mm'])
  await expect(page.getByLabel('Tape')).toHaveValue('36')
  await page.getByRole('button', { name: /back to studio/i }).click()

  await page.getByRole('status', { name: 'Untested printer model' }).getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('status', { name: 'Untested printer model' })).toHaveCount(0)

  // After a reload and a new connection, the dismissed model stays quiet.
  await page.reload()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  if (!/PT-P910BT · 36 mm/.test((await chip(page).getAttribute('aria-label')) ?? '')) {
    await chip(page).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  }
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(mediaBar(page)).toContainText('PT-P910BT (connected)')
  await expect(page.getByRole('status', { name: 'Untested printer model' })).toHaveCount(0)
})

const quickSizes = (page: Page) => page.getByRole('group', { name: 'Quick text size' })

test('a new label follows a real printer of another model and dpi: M of its band, not the PT-P710BT’s M', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, status: P910BT_STATUS_36MM })
  await ready(page)
  await expect(quickSizes(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(widths(page).getByRole('radio', { name: '36 •' })).toBeChecked()
  // M of the PT-P910BT's 36 mm band (454 dots at 360 dpi): 16.02 mm cap height, not 9.03 mm.
  await expect(quickSizes(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Cap height')).toHaveValue('16.02')
})

test('a label designed on the PT-P710BT keeps M when switched to a PT-P910BT’s loaded 36 mm tape', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, status: P910BT_STATUS_36MM })
  await ready(page)
  const m = quickSizes(page).getByRole('button', { name: 'M, medium', exact: true })
  await quickSizes(page).getByRole('button', { name: 'L, large', exact: true }).click()
  await m.click()
  await expect(m).toHaveAttribute('aria-pressed', 'true')
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  // Designed: it keeps 24 mm and gets the mismatch banner; switching keeps M as M.
  await page.getByRole('button', { name: 'Use loaded 36 mm tape' }).click()
  await expect(widths(page).getByRole('radio', { name: '36 •' })).toBeChecked()
  await expect(m).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Cap height')).toHaveValue('16.02')
})

test('after a lost link the studio designs for the Design-for model again', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, status: P910BT_STATUS_36MM })
  await ready(page)
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(mediaBar(page)).toContainText('PT-P910BT (connected)')
  await page.evaluate(async () => {
    const [port] = await (navigator as unknown as { serial: { getPorts(): Promise<EventTarget[]> } }).serial.getPorts()
    port?.dispatchEvent(new Event('disconnect'))
  })
  await expect(chip(page)).toHaveAccessibleName(/lost/i)
  // Not "(connected)" any more: the picker is back, with the PT-P710BT's widths.
  await expect(mediaBar(page)).not.toContainText('(connected)')
  const picker = mediaBar(page).getByLabel('Printer model')
  await expect(picker).toHaveValue('PT-P710BT')
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24'])
  // A pick takes effect right away.
  await picker.selectOption('PT-P300BT')
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12'])
})

test('the virtual printer never shows the untested-model notice', async ({ page }) => {
  await ready(page)
  await designFor(page, 'PT-P910BT')
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(mediaBar(page)).toContainText('PT-P910BT (virtual printer)')
  await expect(page.getByRole('status', { name: 'Untested printer model' })).toHaveCount(0)
})

test('Diagnostics follows the Design-for model: tape list, virtual run and report', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await ready(page)
  await designFor(page, 'PT-P300BT')
  await page.getByRole('button', { name: /^diagnostics$/i }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible()
  await expect(page.locator('dt:text-is("Designing for") + dd')).toHaveText('PT-P300BT (no printer)')
  await expect(page.getByLabel('Tape').locator('option')).toHaveText(['3.5 mm', '6 mm', '9 mm', '12 mm'])
  await page.getByRole('radio', { name: /orientation test/i }).check()
  await page.getByRole('button', { name: /render & encode/i }).click()
  await expect(page.locator('dt:text-is("Target") + dd')).toHaveText(/^PT-P300BT · \S+-12 · \d+ pins @ 180 dpi$/, { timeout: 15_000 })

  await page.getByRole('button', { name: 'Copy diagnostics' }).click()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toContain('## Printer model')
  expect(text).toMatch(/model: +PT-P300BT \(design for, untested\)/)
  expect(text).toMatch(/tape widths: +3\.5, 6, 9, 12 mm/)
})

test('1024–1440 px: the model picker keeps the media bar on two rows', async ({ page }) => {
  for (const width of [1024, 1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    await ready(page)
    await expect(mediaBar(page).getByLabel('Printer model')).toBeVisible()
    const rows = await mediaBar(page).evaluate((bar) => new Set([...bar.querySelectorAll(':scope > .group')].map((g) => Math.round(g.getBoundingClientRect().top))).size)
    expect(rows, `${width} px`).toBe(2)
  }
})

test('375 px: model picker and the notice fit without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await ready(page)
  await unsupported36(page)
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24'])
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await designFor(page, 'PT-P910BT')
  await expect(widths(page).getByRole('radio')).toHaveCount(7)
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow2).toBeLessThanOrEqual(0)
})
