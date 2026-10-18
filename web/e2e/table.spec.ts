// Tables (docs/TABLE-PLAN.md §8) — the Table block end to end: insert, type with Tab / Enter,
// paste a spreadsheet block into a cell, "type or paste the whole table", grid lines and cut
// marks, text direction Across ↓ / ↑, cut between columns (preview cut lines, piece readout, print
// bar note) and a print on the virtual printer in pieces, undo, autosave across a reload, and the
// piano templates. The "Table cells" card under the preview (docs/TABLE-PLAN.md §12): placement,
// every column of the 12-key template visible, a wide grid that scrolls visibly with the focused
// cell in view, and "Insert special character" (Ω) in the cells and in a text block.
// TABLE_SCREENS=<dir> also saves the desktop (1280 × 800, dark and light, also cut between
// columns) and iPhone (375 px) screenshots there.
import { devices, expect, test, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const card = (page: Page) => page.getByRole('region', { name: /^Table cells/ })
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Properties' })
const symbolsButton = (scope: ReturnType<Page['locator']>) => scope.getByRole('button', { name: 'Insert special character' })
const symbols = (page: Page) => page.getByRole('dialog', { name: 'Special characters' })
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
    await expect(card(page).getByText('2 rows × 4 columns')).toBeVisible()

    // A spreadsheet block pasted into a cell fills the grid from there.
    await pasteInto(page, 1, 2, 'RE\tMI\tFA\tSOL\nD\tE\tF\tG')
    await expect(card(page).getByText('2 rows × 5 columns')).toBeVisible()
    await expect(cell(page, 1, 5)).toHaveValue('SOL')
    await expect(cell(page, 2, 5)).toHaveValue('G')
    await expect(blocks(page).nth(1)).toContainText('DO RE MI FA SOL')

    // ♯ at the caret, from "Insert special character": the cell gets the focus back, caret after it.
    await cell(page, 1, 1).click()
    await cell(page, 1, 1).evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2)) // (End does not move the caret on macOS)
    await symbolsButton(card(page)).click()
    await symbols(page).getByRole('button', { name: 'Sharp ♯' }).click()
    await expect(symbols(page)).toBeHidden()
    await expect(cell(page, 1, 1)).toHaveValue('DO♯')
    await expect(cell(page, 1, 1)).toBeFocused()
    expect(await cell(page, 1, 1).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([3, 3])

    // One undo step for the ♯, then one for the whole paste.
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(cell(page, 1, 1)).toHaveValue('DO')
    await expect(cell(page, 1, 5)).toHaveValue('SOL')
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(card(page).getByText('2 rows × 4 columns')).toBeVisible()
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
    await expect(card(page).getByText('3 rows × 3 columns')).toBeVisible()
    await expect(cell(page, 3, 2)).toBeFocused()
    await undo.click()
    await expect(card(page).getByText('2 rows × 3 columns')).toBeVisible()

    await cell(page, 1, 2).click()
    await page.getByRole('button', { name: 'Add column', exact: true }).click()
    await expect(card(page).getByText('2 rows × 4 columns')).toBeVisible()
    await expect(cell(page, 1, 4)).toBeFocused()
    await undo.click()
    await expect(card(page).getByText('2 rows × 3 columns')).toBeVisible()

    // Remove the current cell's column: the cell that takes its place gets the focus.
    await cell(page, 1, 2).click()
    await page.locator('.tools').getByRole('button', { name: 'Remove column 2', exact: true }).click()
    await expect(card(page).getByText('2 rows × 2 columns')).toBeVisible()
    await expect(cell(page, 1, 2)).toHaveValue('C')
    await expect(cell(page, 1, 2)).toBeFocused()
    await undo.click()
    await expect(card(page).getByText('2 rows × 3 columns')).toBeVisible()
    await expect(cell(page, 1, 2)).toHaveValue('B')

    // Remove a row with its × button.
    await page.locator('tbody').getByRole('button', { name: 'Remove row 1', exact: true }).click()
    await expect(card(page).getByText('1 row × 3 columns')).toBeVisible()
    await expect(cell(page, 1, 1)).toHaveValue('1')
    await undo.click()
    await expect(card(page).getByText('2 rows × 3 columns')).toBeVisible()

    // At most 6 rows: Add row is disabled and says why.
    const addRow = page.getByRole('button', { name: 'Add row', exact: true })
    for (let n = 3; n <= 6; n++) {
      await addRow.click()
      await expect(card(page).getByText(`${n} rows × 3 columns`)).toBeVisible()
    }
    await expect(addRow).toBeDisabled()
    await expect(addRow).toHaveAccessibleDescription('A table has at most 6 rows.')

    // The only row and the only column cannot be removed.
    await page.getByText('Type or paste the whole table').click()
    await page.getByLabel(/One line per row/).fill('X')
    await page.getByRole('button', { name: 'Fill table' }).click()
    await expect(card(page).getByText('1 row × 1 column')).toBeVisible()
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
    await expect(card(page).getByText('2 rows × 5 columns')).toBeVisible()
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

  test('the cells card: under the preview, only for a table, the selected table, the inspector link', async ({ page }) => {
    await expect(card(page)).toHaveCount(0)
    await insertTable(page)
    await waitRendered(page)
    // Centre column, under the preview and above "Variables & batch"; the inspector has no cells.
    // The three boxes at the same instant (the preview card can still change height between
    // separate boundingBox calls on a cold start).
    await card(page).getByRole('button', { name: /^Symbols/ }).waitFor()
    const [cardBox, previewBox, batchBox] = await page.evaluate(() => {
      const box = (el: Element | null | undefined) => {
        const r = el!.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const batch = [...document.querySelectorAll('button')].find((b) => /Variables & batch/.test(b.textContent ?? ''))
      return [box(document.querySelector('#table-cells')), box(document.querySelector('[aria-label="Label preview"]')), box(batch)]
    })
    expect(cardBox.y).toBeGreaterThanOrEqual(previewBox.y + previewBox.height)
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(batchBox.y)
    expect(Math.abs(cardBox.x - previewBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(cardBox.width - previewBox.width)).toBeLessThanOrEqual(1)
    await expect(inspector(page).getByRole('textbox', { name: /^Row \d+, column \d+$/ })).toHaveCount(0)
    await expect(inspector(page).getByRole('radiogroup', { name: 'Text direction' })).toBeVisible()
    await expect(inspector(page).getByText('2 rows × 3 columns')).toBeVisible()

    // The inspector's link focuses the grid's current cell.
    await cell(page, 2, 2).click()
    await page.getByRole('radio', { name: 'Across ↓' }).click()
    await inspector(page).getByRole('button', { name: 'edit the cells below the preview' }).click()
    await expect(cell(page, 2, 2)).toBeFocused()

    // Undo / redo reach the card.
    await cell(page, 1, 1).fill('X')
    await page.getByRole('button', { name: 'Undo' }).first().click()
    await expect(cell(page, 1, 1)).toHaveValue('A')
    await page.getByRole('button', { name: 'Redo' }).first().click()
    await expect(cell(page, 1, 1)).toHaveValue('X')

    // A second table: the card edits the selected one.
    await insertTable(page)
    await expect(card(page)).toHaveCount(1)
    await expect(card(page).getByRole('heading')).toHaveText('Table cells · block 3')
    await cell(page, 1, 1).fill('SECOND')
    await blocks(page).nth(1).click()
    await expect(card(page).getByRole('heading')).toHaveText('Table cells · block 2')
    await expect(cell(page, 1, 1)).toHaveValue('X')
    await expect(blocks(page).nth(2)).toContainText('SECOND')

    // Not a table: no card.
    await blocks(page).nth(0).click()
    await expect(page.getByRole('heading', { name: /Text block/ })).toBeVisible()
    await expect(card(page)).toHaveCount(0)
  })

  test('the cells card: all 12 columns of the 12-key template visible; a wide grid scrolls visibly, focused cell in view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openTemplate(page, 'Piano notes, all 12 keys')
    await waitRendered(page)
    await expect(card(page).getByText('2 rows × 12 columns')).toBeVisible()
    const scroller = card(page).getByRole('group', { name: /^Table cells, 2 rows × 12 columns/ })
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    const box = (await scroller.boundingBox())!
    for (const c of [1, 6, 12]) {
      const b = (await cell(page, 1, c).boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(box.x)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width)
    }
    await expect(cell(page, 1, 12)).toHaveValue('SI')
    await expect(card(page).getByText(/More columns/)).toHaveCount(0)

    // 40 columns: the grid scrolls in its box (never the page), says so, and keeps the focus in view.
    await cell(page, 1, 1).click()
    await pasteInto(page, 1, 1, Array.from({ length: 40 }, (_, i) => `N${i + 1}`).join('\t'))
    await expect(card(page).getByText('2 rows × 40 columns')).toBeVisible()
    const wide = card(page).getByRole('group', { name: /^Table cells, 2 rows × 40 columns/ })
    expect(await wide.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await expect(card(page).getByText('More columns → · scroll sideways')).toBeVisible()
    await cell(page, 1, 39).focus()
    await page.keyboard.press('Tab')
    await expect(cell(page, 1, 40)).toBeFocused()
    await expect(card(page).getByText('← More columns · scroll sideways')).toBeVisible()
    const w = (await wide.boundingBox())!
    const last = (await cell(page, 1, 40).boundingBox())!
    expect(last.x + last.width).toBeLessThanOrEqual(w.x + w.width)
    expect(last.x).toBeGreaterThanOrEqual(w.x)
  })

  test('Insert special character: keyboard, Escape, one undo step, the text block too', async ({ page }) => {
    // The text block (selected at start): the symbol goes in at the caret of the text.
    const text = inspector(page).getByRole('textbox', { name: 'Text', exact: true })
    await text.fill('AB')
    await text.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 1))
    const open = symbolsButton(inspector(page))
    await expect(open).toHaveAttribute('title', /Insert special character/)
    await open.click()
    await expect(symbols(page)).toBeVisible()
    // Grouped; the first symbol has the focus; arrows move; Enter picks.
    await expect(symbols(page).getByRole('group', { name: 'Marks' })).toBeVisible()
    await expect(symbols(page).getByRole('button', { name: 'Sharp ♯' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(symbols(page).getByRole('button', { name: 'Flat ♭' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(symbols(page).getByRole('group', { name: 'Arrows' }).locator(':focus')).toHaveCount(1)
    await page.keyboard.press('End')
    await expect(symbols(page).getByRole('button', { name: 'Black square ■' })).toBeFocused()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await expect(symbols(page)).toBeHidden()
    await expect(text).toHaveValue('A♭B')
    await expect(text).toBeFocused()
    expect(await text.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 2])
    // Typing after it is a step of its own; undo removes the typing, then the symbol alone.
    await page.keyboard.type('C')
    await expect(text).toHaveValue('A♭CB')
    const undo = page.getByRole('button', { name: 'Undo' }).first()
    await undo.click()
    await expect(text).toHaveValue('A♭B')
    await undo.click()
    await expect(text).toHaveValue('AB')

    // Escape closes the menu, gives the button its focus back and keeps the block selected.
    await open.click()
    await expect(symbols(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(symbols(page)).toBeHidden()
    await expect(open).toBeFocused()
    await expect(page.getByRole('heading', { name: /Text block/ })).toBeVisible()

    // The rendered label has the symbol, without a font fallback warning.
    await open.click()
    const before = await previewPixels(page)
    await symbols(page).getByRole('button', { name: 'Star ★' }).click()
    await expect(text).toHaveValue('AB★')
    await waitRendered(page, before)
    await expect(preview(page).locator('.warnings')).toHaveCount(0)
  })

  test('Symbols in the cells card: a labelled button, the menu never covers the cell it writes into', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openTemplate(page, 'Piano notes, all 12 keys')
    const open = symbolsButton(card(page))
    await expect(open).toContainText('Symbols')
    await expect(open).toHaveAccessibleName(/^Symbols/)
    await cell(page, 2, 5).click()
    await open.click()
    await expect(symbols(page).getByRole('button', { name: 'Sharp ♯' })).toBeFocused()
    const pop = (await symbols(page).boundingBox())!
    const at = (await cell(page, 2, 5).boundingBox())!
    const overlaps = at.x < pop.x + pop.width && at.x + at.width > pop.x && at.y < pop.y + pop.height && at.y + at.height > pop.y
    expect(overlaps).toBe(false)
    expect(pop.y).toBeGreaterThanOrEqual(0)
    expect(pop.y + pop.height).toBeLessThanOrEqual(800)
    // Close (the header) gives the button its focus back.
    await symbols(page).getByRole('button', { name: 'Close' }).click()
    await expect(symbols(page)).toBeHidden()
    await expect(open).toBeFocused()
  })

  test('screenshots: the cells card under the preview, dark and light, symbols open (TABLE_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set TABLE_SCREENS=<dir> to save the screenshots')
    await page.setViewportSize({ width: 1280, height: 800 })
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await openTemplate(page, 'Piano notes, all 12 keys')
      await waitRendered(page)
      await quietToasts(page)
      await card(page).evaluate((el) => el.scrollIntoView({ block: 'end' }))
      if (scheme === 'dark') {
        await cell(page, 1, 3).click()
        await symbolsButton(card(page)).click()
        await expect(symbols(page).getByRole('button', { name: 'Sharp ♯' })).toBeFocused()
      }
      await page.screenshot({ path: `${screens}/table-desktop-${scheme}.png` })
      if (scheme === 'dark') await page.keyboard.press('Escape')
    }
  })

  test('screenshot: the table editor with the piano notes (TABLE_SCREENS)', async ({ page }) => {
    test.skip(!screens, 'set TABLE_SCREENS=<dir> to save the screenshots')
    await page.setViewportSize({ width: 1280, height: 800 })
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
    // The cells card right under the preview, then the symbols over it.
    await card(page).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 120))
    await expect(card(page)).toBeVisible()
    await page.screenshot({ path: `${screens}/table-iphone.png` })
    await cell(page, 1, 2).tap()
    await symbolsButton(card(page)).tap()
    await expect(symbols(page)).toBeVisible()
    await page.screenshot({ path: `${screens}/table-iphone-symbols.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: /Table block/ }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70))
    await page.screenshot({ path: `${screens}/table-iphone-inspector.png` })
  })
})
