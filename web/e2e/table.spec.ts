// Tables (docs/TABLE-PLAN.md §8) — the Table block end to end: insert, type with Tab / Enter,
// paste a spreadsheet block into a cell, "type or paste the whole table", grid lines and cut
// marks, text direction Across ↓ / ↑, cut between columns (preview cut lines, piece readout, print
// bar note) and a print on the virtual printer in pieces, undo, autosave across a reload, and the
// piano templates.
// TABLE_SCREENS=<dir> also saves the desktop (1280 × 720, also cut between columns) and iPhone
// (375 px) screenshots there.
import { devices, expect, test, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const cell = (page: Page, r: number, c: number) => page.getByRole('textbox', { name: `Row ${r}, column ${c}`, exact: true })
const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print/ }).last()
const screens = process.env.TABLE_SCREENS
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

async function insertTable(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Insert Table' }).click()
  await expect(page.getByRole('heading', { name: /Table block/ })).toBeVisible()
  await expect(cell(page, 1, 1)).toHaveValue('A')
}

/** A paste event with `text` on the focused cell (the clipboard API needs no permission here). */
async function pasteInto(page: Page, r: number, c: number, text: string): Promise<void> {
  await cell(page, r, c).evaluate((el, t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

/** Closes the "Ready to work offline" note (it may appear a moment after the load). */
async function quietToasts(page: Page): Promise<void> {
  const offline = page.getByRole('button', { name: 'Dismiss', exact: true })
  await offline.waitFor({ timeout: 3000 }).then(() => offline.click(), () => {})
}

async function openTemplate(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: /New from template/ }).click()
  const gallery = page.getByRole('dialog', { name: 'New from template' })
  await expect(gallery.getByRole('heading', { name: 'Music' })).toBeVisible()
  await gallery.getByRole('button', { name, exact: true }).click()
  await expect(gallery).toBeHidden()
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./')
    await waitRendered(page)
  })

  test('insert a table, type with Tab and Enter, paste a block into a cell', async ({ page }) => {
    const before = await previewPixels(page)
    await insertTable(page)
    await waitRendered(page, before)
    await expect(blocks(page).nth(1)).toContainText('Table')
    await expect(blocks(page).nth(1)).toContainText('2 × 3')

    // Tab moves along the row; Enter goes down, then to the top of the next column.
    await cell(page, 1, 1).fill('DO')
    await cell(page, 1, 1).press('Tab')
    await expect(cell(page, 1, 2)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(cell(page, 1, 1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(cell(page, 2, 1)).toBeFocused()
    await page.keyboard.type('C')
    await page.keyboard.press('Enter')
    await expect(cell(page, 1, 2)).toBeFocused()
    // Enter after the last cell adds a column.
    await cell(page, 2, 3).focus()
    await page.keyboard.press('Enter')
    await expect(cell(page, 1, 4)).toBeFocused()
    await expect(page.getByText('2 rows × 4 columns')).toBeVisible()

    // A spreadsheet block pasted into a cell fills the grid from there.
    await pasteInto(page, 1, 2, 'RE\tMI\tFA\tSOL\nD\tE\tF\tG')
    await expect(page.getByText('2 rows × 5 columns')).toBeVisible()
    await expect(cell(page, 1, 5)).toHaveValue('SOL')
    await expect(cell(page, 2, 5)).toHaveValue('G')
    await expect(blocks(page).nth(1)).toContainText('DO RE MI FA SOL')

    // ♯ at the caret.
    await cell(page, 1, 1).click()
    await cell(page, 1, 1).evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2)) // (End does not move the caret on macOS)
    await page.getByRole('button', { name: 'Insert sharp ♯' }).click()
    await expect(cell(page, 1, 1)).toHaveValue('DO♯')

    // One undo step for the ♯, then one for the whole paste.
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(cell(page, 1, 1)).toHaveValue('DO')
    await expect(cell(page, 1, 5)).toHaveValue('SOL')
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(page.getByText('2 rows × 4 columns')).toBeVisible()
    await expect(cell(page, 1, 5)).toHaveCount(0)
    await expect(cell(page, 1, 2)).toHaveValue('B')
    await expect(cell(page, 2, 2)).toHaveValue('2')

    // One line of a comma list fills cells too (not just the one cell).
    await pasteInto(page, 1, 2, 'RE,MI,FA')
    await expect(cell(page, 1, 4)).toHaveValue('FA')
    await expect(cell(page, 1, 2)).toHaveValue('RE')
  })

  test('add and remove rows and columns: focus, one undo step each, the limits', async ({ page }) => {
    await insertTable(page)
    const undo = page.getByRole('button', { name: 'Undo' }).first()

    await cell(page, 1, 2).click()
    await page.getByRole('button', { name: 'Add row', exact: true }).click()
    await expect(page.getByText('3 rows × 3 columns')).toBeVisible()
    await expect(cell(page, 3, 2)).toBeFocused()
    await undo.click()
    await expect(page.getByText('2 rows × 3 columns')).toBeVisible()

    await cell(page, 1, 2).click()
    await page.getByRole('button', { name: 'Add column', exact: true }).click()
    await expect(page.getByText('2 rows × 4 columns')).toBeVisible()
    await expect(cell(page, 1, 4)).toBeFocused()
    await undo.click()
    await expect(page.getByText('2 rows × 3 columns')).toBeVisible()

    // Remove the current cell's column: the cell that takes its place gets the focus.
    await cell(page, 1, 2).click()
    await page.locator('.tools').getByRole('button', { name: 'Remove column 2', exact: true }).click()
    await expect(page.getByText('2 rows × 2 columns')).toBeVisible()
    await expect(cell(page, 1, 2)).toHaveValue('C')
    await expect(cell(page, 1, 2)).toBeFocused()
    await undo.click()
    await expect(page.getByText('2 rows × 3 columns')).toBeVisible()
    await expect(cell(page, 1, 2)).toHaveValue('B')

    // Remove a row with its × button.
    await page.locator('tbody').getByRole('button', { name: 'Remove row 1', exact: true }).click()
    await expect(page.getByText('1 row × 3 columns')).toBeVisible()
    await expect(cell(page, 1, 1)).toHaveValue('1')
    await undo.click()
    await expect(page.getByText('2 rows × 3 columns')).toBeVisible()

    // At most 6 rows: Add row is disabled and says why.
    const addRow = page.getByRole('button', { name: 'Add row', exact: true })
    for (let n = 3; n <= 6; n++) {
      await addRow.click()
      await expect(page.getByText(`${n} rows × 3 columns`)).toBeVisible()
    }
    await expect(addRow).toBeDisabled()
    await expect(addRow).toHaveAccessibleDescription('A table has at most 6 rows.')

    // The only row and the only column cannot be removed.
    await page.getByText('Type or paste the whole table').click()
    await page.getByLabel(/One line per row/).fill('X')
    await page.getByRole('button', { name: 'Fill table' }).click()
    await expect(page.getByText('1 row × 1 column')).toBeVisible()
    for (const name of ['Remove row 1', 'Remove column 1']) {
      const buttons = page.getByRole('button', { name, exact: true })
      await expect(buttons).toHaveCount(2)
      for (const b of await buttons.all()) await expect(b).toBeDisabled()
    }
  })

  test('the unsent "type or paste" text stays with its table', async ({ page }) => {
    await insertTable(page)
    await insertTable(page)
    await expect(blocks(page)).toHaveCount(3)
    await page.getByText('Type or paste the whole table').click()
    await page.getByLabel(/One line per row/).fill('X Y')
    // Select the other table: its own text, the box closed, nothing to fill yet.
    await blocks(page).nth(1).click()
    await expect(page.getByRole('heading', { name: /Table block 2\/3/ })).toBeVisible()
    await expect(page.locator('details.paste')).not.toHaveAttribute('open', /.*/)
    await page.getByText('Type or paste the whole table').click()
    await expect(page.getByLabel(/One line per row/)).toHaveValue('A B C\n1 2 3')
    await expect(page.getByRole('button', { name: 'Fill table' })).toBeDisabled()
    await expect(blocks(page).nth(2)).toContainText('2 × 3')
  })

  test('fill from text, grid, cut marks, direction, cut between columns and print in pieces', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete block' }).click()
    await insertTable(page)
    await page.getByText('Type or paste the whole table').click()
    await page.getByLabel(/One line per row/).fill('DO RE MI FA SOL\nC D E F G')
    let px = await previewPixels(page)
    await page.getByRole('button', { name: 'Fill table' }).click()
    await expect(page.getByText('2 rows × 5 columns')).toBeVisible()
    px = await waitRendered(page, px)

    // Cut marks first: with grid lines on, the ticks fall on the column lines.
    await toggle(page, 'Cut marks')
    px = await waitRendered(page, px)
    await toggle(page, 'Grid lines')
    px = await waitRendered(page, px)

    await page.getByRole('radio', { name: 'Across ↓' }).click()
    await expect(page.getByText(/reads from the top tape edge down/)).toBeVisible()
    px = await waitRendered(page, px)
    await page.getByRole('radio', { name: 'Across ↑' }).click()
    await expect(page.getByText(/reads from the bottom tape edge up/)).toBeVisible()
    px = await waitRendered(page, px)
    await expect(page.getByRole('radiogroup', { name: 'Piece length' }).getByRole('radio', { name: 'Fixed' })).toBeVisible()
    await page.getByRole('radio', { name: 'Along' }).click()
    px = await waitRendered(page, px)

    // Connect the virtual printer (it has a cutter), then cut between the columns.
    await chip(page).click()
    await page.getByRole('dialog', { name: /Connect your printer/ }).getByRole('button', { name: /^No printer/ }).click()
    await expect(chip(page)).toHaveAccessibleName(/PT-P710BT/)
    // A label frame is one box around the strip: cutting the table (the only block) turns it off.
    await toggle(page, 'Frame')
    await expect(page.getByRole('switch', { name: 'Frame', exact: true })).toBeChecked()
    await toggle(page, 'Cut between columns')
    await expect(page.getByRole('switch', { name: 'Frame', exact: true })).not.toBeChecked()
    await expect(page.getByRole('log', { name: 'Notifications' })).toContainText(/label frame turned off/i)
    await expect(page.getByRole('switch', { name: 'Cut marks' })).toBeDisabled()
    await expect(preview(page).getByText(/^Cut into 5 pieces · about [\d.]+ mm (to [\d.]+ mm )?each/)).toBeVisible()
    // The bold figure is the tape of the 5 pieces (each with its feed margins), not one strip.
    await expect(preview(page).getByText(/of tape in 5 pieces/)).toBeVisible()
    await expect(preview(page).getByText(/strip, before cutting/)).toBeVisible()
    await expect(preview(page).locator('.cut.piece')).toHaveCount(4)
    await expect(page.getByText(/before the first piece/)).toBeAttached()
    await expect(page.getByRole('status').filter({ hasText: /^Cut into 5 pieces/ })).toBeVisible()

    await expect(printButton(page)).toBeEnabled()
    await printButton(page).click()
    await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: 'Label printed in 5 pieces' })).toBeVisible({ timeout: 30_000 })

    // Autosave: the table is back after a reload.
    await page.waitForTimeout(800)
    await page.reload()
    await waitRendered(page)
    await expect(blocks(page).first()).toContainText('2 × 5 · DO RE MI FA SOL')
  })

  test('the piano templates open and print-ready', async ({ page }) => {
    for (const name of ['Piano notes', 'Piano notes, all 12 keys', 'Piano notes, all 12 keys with flats']) {
      await openTemplate(page, name)
      await waitRendered(page)
      await expect(page.getByRole('heading', { name: /Table block/ })).toBeVisible()
      await expect(preview(page).locator('.warnings')).toHaveCount(0)
    }
    await expect(cell(page, 3, 2)).toHaveValue('RE♭')
  })

  test('screenshot: the table editor with the piano notes (TABLE_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set TABLE_SCREENS=<dir> to save the screenshots')
    await page.setViewportSize({ width: 1280, height: 720 })
    await openTemplate(page, 'Piano notes')
    await waitRendered(page)
    await quietToasts(page)
    await page.screenshot({ path: `${screens}/table-desktop.png` })
    // Cut between columns: the piece readout and the tape of the pieces under the preview.
    await toggle(page, 'Cut between columns')
    await expect(preview(page).getByText(/of tape in 7 pieces/)).toBeVisible()
    await waitRendered(page)
    await quietToasts(page)
    await page.screenshot({ path: `${screens}/table-desktop-cut.png` })
  })
})

test.describe('iPhone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ viewport: { ...viewport, width: 375 }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('screenshot: the table editor with the piano notes on an iPhone (TABLE_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set TABLE_SCREENS=<dir> to save the screenshots')
    await removeDeviceApis(page)
    await page.goto('./')
    await page.getByRole('button', { name: 'Start designing' }).click()
    await waitRendered(page)
    await openTemplate(page, 'Piano notes')
    await waitRendered(page)
    await quietToasts(page)
    await page.getByRole('heading', { name: /Table block/ }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70))
    await page.screenshot({ path: `${screens}/table-iphone.png` })
  })
})
