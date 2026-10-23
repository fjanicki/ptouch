// Cut blocks (docs/CUT-PLAN.md §6) — the Cut block end to end: Insert Cut turns Cut each on in the
// same undo step (announced, toast), the red cut line, the piece readout, the Cut's panel and its
// block-list row; Cut each off → cut marks and "Turn on Cut each"; a trailing Cut is ignored;
// fixed length = "Length of each piece"; a printer without a cutter; a print on the virtual
// Bluetooth printer decoded into one page per piece with a cut after each; a batch of 2 records ×
// 2 pieces; autosave across a reload. CUT_SCREENS=<dir> also saves the desktop (1280 × 800,
// light and dark, a 3-piece strip with its Cut selected) and iPhone (375 px) screenshots there.
import { devices, expect, test, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'
import { stubVirtualSerial, type VirtualSerialWindow } from './fixtures/virtual-serial'

test.use({ serviceWorkers: 'block' })

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Properties' })
const toasts = (page: Page) => page.getByRole('log', { name: 'Notifications' })
const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const printButton = (page: Page) => page.getByRole('contentinfo', { name: 'Print' }).getByRole('button', { name: /^Print/ })
/** The Cut panel's live status line (the label panel has an <output> too). */
const cutStatus = (page: Page) => inspector(page).locator('p[role="status"]')
const cutEach = (page: Page) => page.getByRole('switch', { name: 'Cut each', exact: true })
const screens = process.env.CUT_SCREENS
/** Flips a Switch (its visible track covers the input: click the label). */
const toggle = (page: Page, name: string) => page.locator('label.switch', { has: page.getByRole('switch', { name, exact: true }) }).click()

async function previewPixels(page: Page): Promise<string> {
  return preview(page)
    .locator('canvas')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL())
}

async function waitRendered(page: Page, previous?: string): Promise<string> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  if (previous !== undefined) await expect.poll(() => previewPixels(page)).not.toBe(previous)
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
  return previewPixels(page)
}

/** Closes the "Ready to work offline" note (it may appear a moment after the load). */
async function quietToasts(page: Page): Promise<void> {
  const offline = page.getByRole('button', { name: 'Dismiss', exact: true })
  await offline.waitFor({ timeout: 3000 }).then(() => offline.click(), () => {})
}

async function insertText(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Insert Text' }).click()
  await page.getByLabel('Text', { exact: true }).fill(text)
}

/** A 3-piece strip: Kitchen | Office | QR code. */
async function threePieces(page: Page): Promise<void> {
  await page.getByLabel('Text', { exact: true }).fill('Kitchen')
  await page.getByRole('button', { name: 'Insert Cut' }).click()
  await insertText(page, 'Office')
  await page.getByRole('button', { name: 'Insert Cut' }).click()
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await expect(blocks(page)).toHaveCount(5)
  await waitRendered(page)
}

/** Decoded summary of everything written to the virtual serial port since `from`. */
async function decodedJob(page: Page, from: number): Promise<{ pages: number[]; violations: string[]; printerViolations: string[]; commands: string[] }> {
  return page.evaluate((start) => {
    type Bmp = { length: number; free(): void }
    const w = window as unknown as VirtualSerialWindow
    const mod = w.__vsWasm as unknown as { decodeJob(m: string, b: Uint8Array): { pages(): Bmp[]; violations(): string[]; commands(): string[]; free(): void } }
    const job = mod.decodeJob('PT-P710BT', Uint8Array.from(w.__vsWrites.slice(start).flat()))
    const pages = job.pages()
    const out = { pages: pages.map((p) => p.length), violations: job.violations(), printerViolations: w.__vsPrinter?.violations() ?? [], commands: job.commands() }
    for (const p of pages) p.free()
    job.free()
    return out
  }, from)
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./')
    await waitRendered(page)
  })

  test('insert a Cut: Cut each on in the same undo step, cut line, readout, panel, block list', async ({ page }) => {
    await page.getByLabel('Text', { exact: true }).fill('Kitchen')
    // Cut each off first: inserting a Cut turns it on and says so.
    await toggle(page, 'Cut each')
    await expect(cutEach(page)).not.toBeChecked()
    let px = await waitRendered(page)
    await page.getByRole('button', { name: 'Insert Cut' }).click()
    await expect(page.getByRole('heading', { name: /Cut block/ })).toBeVisible()
    await expect(cutEach(page)).toBeChecked()
    await expect(toasts(page)).toContainText('Cut each turned on')
    // Nothing after it yet: announced as ignored, and the panel's status line says so from the
    // start (it does not flip from "The printer cuts here." once the render lands).
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Added cut. Cut each turned on. Add a block after it to start the next piece' })).toBeAttached()
    await expect(cutStatus(page)).toHaveText('This cut is ignored, so the strip is not cut here.')
    // Nothing after it yet: ignored, with the warning in the list and the panel.
    await expect(blocks(page).nth(1)).toContainText('Ignored: nothing after it')
    await expect(blocks(page).nth(1).locator('.warn')).toBeVisible()
    await expect(inspector(page).getByText('Nothing is printed after this cut, so it is ignored.')).toBeVisible()

    // One Undo removes the Cut and turns Cut each back off.
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(blocks(page)).toHaveCount(1)
    await expect(cutEach(page)).not.toBeChecked()
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await expect(blocks(page)).toHaveCount(2)
    await expect(cutEach(page)).toBeChecked()

    // The Cut is selected: the next block goes after it and starts piece 2.
    await blocks(page).nth(1).getByRole('button').first().click()
    await insertText(page, 'Office')
    px = await waitRendered(page, px)
    await expect(preview(page).locator('.cut.piece')).toHaveCount(1)
    await expect(preview(page).getByText(/^Cut into 2 pieces: about [\d.]+ and [\d.]+ mm, each incl\. 2 × 2 mm feed$/)).toBeVisible()
    await expect(preview(page).getByText(/strip, before cutting/)).toBeVisible()
    // The row leads with the piece lengths (a narrow row still shows them; it wraps) and says
    // them in words.
    await expect(blocks(page).nth(1).locator('.summary')).toHaveText(/^[\d.]+\s\/ [\d.]+\smm$/)
    await expect(blocks(page).nth(1).getByRole('button').first()).toHaveAccessibleName(/^Cut: Printer cuts: pieces of [\d.]+ and [\d.]+ mm, block 2 of 3$/)
    await blocks(page).nth(1).getByRole('button').first().click()
    await expect(cutStatus(page)).toHaveText('The printer cuts here.')
    await expect(inspector(page).getByText(/^Piece before: about [\d.]+ mm · piece after: about [\d.]+ mm \(each with the printer’s 2 mm feed at both ends\)\.$/)).toBeVisible()
    await expect(inspector(page).getByText('Each piece is laid out like a label on its own: start and end margins (2 mm / 2 mm) and length (auto) apply to every piece.')).toBeVisible()
    await expect(page.getByText('Cuts at every Cut block and after the label.')).toBeVisible()

    // Cut each off: the Cut prints as a cut mark; "Turn on Cut each" turns it back on.
    await toggle(page, 'Cut each')
    px = await waitRendered(page, px)
    await expect(inspector(page).getByText('Cut each is off: the strip won’t be cut. A cut mark is printed here instead.')).toBeVisible()
    await expect(preview(page).locator('.cut.piece')).toHaveCount(0)
    await expect(preview(page).locator('.cut.mark')).toHaveCount(1)
    await expect(preview(page).getByText(/^2 pieces to cut apart at the marks: about [\d.]+ and [\d.]+ mm$/)).toBeVisible()
    await expect(blocks(page).nth(1).locator('.summary')).toHaveText(/^[\d.]+\s\/ [\d.]+\smm, by hand$/)
    await expect(page.getByText('Off: the Cut blocks print as cut marks.')).toBeVisible()
    // The live status line holds the state only (the lengths below it are not announced).
    await expect(cutStatus(page)).toHaveText('Cut each is off: the strip won’t be cut. A cut mark is printed here instead.')
    await inspector(page).getByRole('button', { name: 'Turn on Cut each' }).focus()
    await page.keyboard.press('Enter')
    await expect(cutEach(page)).toBeChecked()
    // The button is gone: keyboard focus stays in the panel, on the line that followed it.
    await expect(inspector(page).getByRole('button', { name: 'Turn on Cut each' })).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
    await expect(inspector(page).getByText(/^Each piece is laid out like a label on its own/)).toBeFocused()
    px = await waitRendered(page, px)
    await expect(preview(page).locator('.cut.piece')).toHaveCount(1)
    await expect(cutStatus(page)).toHaveText('The printer cuts here.')

    // Fixed length: the length of each piece.
    await page.getByRole('radiogroup', { name: 'Length' }).getByRole('radio', { name: 'Fixed' }).click()
    await expect(page.getByLabel('Length of each piece')).toBeVisible()
    await expect(page.getByText(/^Each cut piece ≈ [\d.]+ mm with the printer’s feed$/)).toBeVisible()
    // Cut apart by hand at the marks, the printer's feed is only at the strip's ends.
    await toggle(page, 'Cut each')
    px = await waitRendered(page, px)
    await expect(page.getByText(/^Each piece ≈ [\d.]+ mm when cut apart at the marks \(incl\. the printer’s feed\)$/)).toBeVisible()
    await expect(preview(page).getByText(/^2 pieces to cut apart at the marks: about [\d.]+ mm each$/)).toBeVisible()
    await toggle(page, 'Cut each')
    await expect(page.getByRole('switch', { name: 'Frame', exact: true })).toBeVisible()
    await expect(page.getByText('Border around every piece')).toBeVisible()
  })

  test('a printer without a cutter: the Cut prints as a cut mark', async ({ page }) => {
    await page.getByRole('region', { name: 'Tape and length' }).getByLabel('Printer model').selectOption('PT-P300BT')
    await page.getByRole('button', { name: 'Insert Cut' }).click()
    // At the end of the label: ignored until a block follows it.
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Added cut. Add a block after it to start the next piece' })).toBeAttached()
    await expect(cutStatus(page)).toHaveText('This cut is ignored, so the strip is not cut here.')
    await insertText(page, 'Office')
    await blocks(page).nth(1).getByRole('button').first().click()
    await expect(inspector(page).getByText('This printer has no cutter: a cut mark (short ticks at both tape edges) is printed here. Cut the strip with scissors.')).toBeVisible()
    // Between two printed blocks: a cut mark.
    await blocks(page).nth(0).getByRole('button').first().click()
    await page.getByRole('button', { name: 'Insert Cut' }).click()
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Added cut. This printer has no cutter: a cut mark is printed' })).toBeAttached()
  })

  test('a Cut inserted at the end with Cut each already on is announced as ignored, then cuts once a block follows', async ({ page }) => {
    await expect(cutEach(page)).toBeChecked()
    await page.getByRole('button', { name: 'Insert Cut' }).click()
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Added cut. Add a block after it to start the next piece' })).toBeAttached()
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'The printer cuts here' })).toHaveCount(0)
    await expect(cutStatus(page)).toHaveText('This cut is ignored, so the strip is not cut here.')
    await waitRendered(page)
    await expect(cutStatus(page)).toHaveText('This cut is ignored, so the strip is not cut here.')
    // Between two printed blocks: the printer cuts there.
    await insertText(page, 'Office')
    await blocks(page).nth(0).getByRole('button').first().click()
    await page.getByRole('button', { name: 'Insert Cut' }).click()
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Added cut. The printer cuts here' })).toBeAttached()
    await expect(cutStatus(page)).toHaveText('The printer cuts here.')
  })

  test('screenshots: a 3-piece strip with its Cut selected, light and dark (CUT_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set CUT_SCREENS=<dir> to save the screenshots')
    await page.setViewportSize({ width: 1280, height: 800 })
    await threePieces(page)
    await blocks(page).nth(1).getByRole('button').first().click()
    await expect(inspector(page).getByText('The printer cuts here.')).toBeVisible()
    await quietToasts(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(400) // colour transitions
      await page.screenshot({ path: `${screens}/cut-desktop-${scheme}.png` })
    }
  })
})

test('print a 3-piece strip on the virtual Bluetooth printer: one page per piece, cut after each; autosave', async ({ page }) => {
  test.setTimeout(90_000)
  await stubVirtualSerial(page, { openFailures: 0 })
  await page.goto('./')
  await waitRendered(page)
  await threePieces(page)
  await expect(preview(page).locator('.cut.piece')).toHaveCount(2)
  await expect(preview(page).getByText(/^Cut into 3 pieces: about [\d.]+, [\d.]+ and [\d.]+ mm, each incl\. 2 × 2 mm feed$/)).toBeVisible()

  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(page.locator('dialog.connect')).toBeHidden()
  await expect(printButton(page)).toBeEnabled()
  const before = await page.evaluate(() => (window as unknown as VirtualSerialWindow).__vsWrites.length)
  await printButton(page).click()
  await expect(toasts(page).filter({ hasText: 'Label printed in 3 pieces' })).toBeVisible({ timeout: 60_000 })

  const job = await decodedJob(page, before)
  expect(job.violations).toEqual([])
  expect(job.printerViolations).toEqual([])
  expect(job.pages).toHaveLength(3)
  // Full cut after every page (ESC i M 0x40), chain off (ESC i K 0x08), one job.
  expect(job.commands.filter((c) => /^VariousMode\(/.test(c))).toEqual(['VariousMode(64)', 'VariousMode(64)', 'VariousMode(64)'])
  expect(job.commands.filter((c) => /^AdvancedMode\(/.test(c))).toEqual(['AdvancedMode(8)', 'AdvancedMode(8)', 'AdvancedMode(8)'])
  expect(job.commands.filter((c) => /^Initialize/.test(c))).toHaveLength(1)
  expect(job.commands.filter((c) => /^PrintLast/.test(c))).toHaveLength(1)

  // Autosave: the Cuts are back after a reload.
  await page.waitForTimeout(800)
  await page.reload()
  await waitRendered(page)
  await expect(blocks(page)).toHaveCount(5)
  await expect(blocks(page).nth(1).getByRole('button').first()).toHaveAccessibleName(/^Cut: Printer cuts: pieces of /)
  await expect(preview(page).locator('.cut.piece')).toHaveCount(2)
})

test('a batch of 2 records × 2 pieces prints 4 pieces in one job', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('./')
  await waitRendered(page)
  await page.getByLabel('Text', { exact: true }).fill('{{name}}')
  await page.getByRole('button', { name: 'Insert Cut' }).click()
  await insertText(page, '{{room}}')
  await page.getByRole('button', { name: /Variables & batch/ }).click()
  const box = page.getByLabel('Paste from a spreadsheet or CSV (first row = column names)')
  await expect(box).toBeVisible()
  await box.fill('name;room\nAda;Lab 1\nGrace;Lab 2\n')
  await page.getByRole('button', { name: 'Use pasted data' }).click()
  await expect(page.getByRole('switch', { name: 'Print as a batch' })).toBeChecked()
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^No printer/ }).click()
  await expect(dialog).toBeHidden()
  await expect(printButton(page)).toBeEnabled()
  await expect(printButton(page)).toHaveText(/Print 2 labels/)
  await printButton(page).click()
  await expect(toasts(page).filter({ hasText: '4 pieces printed' })).toBeVisible({ timeout: 90_000 })
})

test.describe('iPhone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ viewport: { ...viewport, width: 375 }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('screenshot: a 3-piece strip on an iPhone (CUT_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set CUT_SCREENS=<dir> to save the screenshots')
    await removeDeviceApis(page)
    await page.goto('./')
    await page.getByRole('button', { name: 'Start designing' }).click()
    await waitRendered(page)
    await threePieces(page)
    await blocks(page).nth(1).getByRole('button').first().click()
    await quietToasts(page)
    await page.getByRole('heading', { name: /Cut block/ }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70))
    await page.screenshot({ path: `${screens}/cut-iphone.png` })
    await preview(page).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60))
    await page.screenshot({ path: `${screens}/cut-iphone-preview.png` })
  })
})
