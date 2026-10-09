// P1 — variables + batch printing (docs/STUDIO-V1-PLAN.md): paste CSV → table → preview row →
// one chained job on the virtual printer; unknown variables and empty cells are flagged before
// printing; the 500-row cap; keyboard-only table editing; the 360 px phone layout.
import { expect, test, type Page } from '@playwright/test'

const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })
const panelToggle = (page: Page) => page.getByRole('button', { name: /Variables & batch/ })
const table = (page: Page) => page.getByRole('table', { name: 'Batch data' })

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
})

async function openPanel(page: Page): Promise<void> {
  if ((await panelToggle(page).getAttribute('aria-expanded')) !== 'true') await panelToggle(page).click()
  await expect(panelToggle(page)).toHaveAttribute('aria-expanded', 'true')
}

async function pasteData(page: Page, csv: string): Promise<void> {
  await openPanel(page)
  const box = page.getByLabel('Paste from a spreadsheet or CSV (first row = column names)')
  if (!(await box.isVisible())) await page.getByText(/Replace with pasted data/).click()
  await box.fill(csv)
  await page.getByRole('button', { name: 'Use pasted data' }).click()
}

async function connectVirtual(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Connection:/ }).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^No printer/ }).click()
  await expect(dialog).toBeHidden()
}

test('paste CSV → table → preview row → 3 rows × 2 copies print as one job', async ({ page }) => {
  test.setTimeout(120_000) // the virtual printer feeds at a realistic speed
  await page.getByLabel('Text', { exact: true }).fill('{{name}} {{room}}')
  await pasteData(page, 'name;room\nAda;Lab 1\n"Hopper, Grace";Lab 2\nLinus;Lab 3\n')

  await expect(table(page).getByRole('textbox', { name: 'name, row 2' })).toHaveValue('Hopper, Grace')
  await expect(table(page).getByRole('textbox', { name: 'Column 2 name' })).toHaveValue('room')
  await expect(page.getByRole('switch', { name: 'Print as a batch' })).toBeChecked()
  await expect(panelToggle(page)).toContainText('3 labels')

  // Every row has a thumbnail; choosing one shows that label in the main preview.
  const labels = page.getByRole('list', { name: 'Batch labels' })
  await expect(labels.getByRole('button')).toHaveCount(3)
  await labels.scrollIntoViewIfNeeded() // thumbnails render lazily, when they come into view
  await expect(labels.locator('canvas[data-painted]')).toHaveCount(3, { timeout: 15_000 })
  await labels.getByRole('button', { name: /Label 2: Hopper, Grace/ }).click()
  await expect(labels.getByRole('button', { name: /Label 2/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Preview: label 2 of 3')).toBeVisible()
  await page.getByRole('button', { name: 'Next label' }).click()
  await expect(page.getByText('Preview: label 3 of 3')).toBeVisible()

  await connectVirtual(page)
  await page.getByRole('button', { name: 'More copies' }).click()
  await expect(page.getByText('Copies of each')).toBeVisible()
  await expect(printButton(page)).toHaveText(/Print 6 labels/)
  // Exact once every label was measured (rendered in the background).
  await expect(page.getByText(/3 labels × 2 in one job: uses [\d.]+ m(m)? of tape incl\. the ~24 mm leader\./)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Full cut after every label (this printer has no half cut).')).toBeVisible()
  await expect(printButton(page)).toBeEnabled()
  await printButton(page).click()
  await expect(page.getByRole('progressbar', { name: 'Print progress' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: '6 labels printed' })).toBeVisible({ timeout: 90_000 })
})

test('unknown variables and empty cells are flagged before printing', async ({ page }) => {
  await pasteData(page, 'name,room\nAda,\nGrace,Lab 2')
  await page.getByLabel('Text', { exact: true }).fill('{{name}} {{rom}} {{room}}')

  // In the properties: chips with text, not colour alone.
  const hint = page.getByRole('group', { name: 'Variables in this field' })
  await expect(hint.getByRole('listitem').filter({ hasText: '{{rom}}' })).toContainText('unknown')
  await expect(hint.getByRole('listitem').filter({ hasText: '{{name}}' })).toContainText('column')
  await expect(hint.getByText('This variable is not defined')).toBeVisible()

  // In the panel: the list, a one-click fix, and the empty cell of a used column.
  await expect(panelToggle(page)).toContainText('1 unknown')
  await expect(page.getByText(/Unknown variable:/)).toBeVisible()
  await expect(table(page).getByRole('textbox', { name: 'room, row 1 (empty, used on the label)' })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('1 cell is empty in columns the label uses.')).toBeVisible()

  await connectVirtual(page)
  await expect(printButton(page)).toBeDisabled()
  await expect(page.locator('#print-reason')).toHaveText(/Unknown variable \{\{rom\}\}/)

  await page.getByRole('button', { name: 'Column rom' }).click()
  await expect(table(page).getByRole('textbox', { name: 'Column 3 name' })).toHaveValue('rom')
  await expect(panelToggle(page)).not.toContainText('unknown')
})

test('"Edit data…" opens the batch panel from the text properties', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('Asset {{id}}')
  await expect(panelToggle(page)).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Edit data…' }).click()
  await expect(panelToggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(panelToggle(page)).toBeFocused()
})

test('more than 500 rows: only the first 500 are kept, with a message', async ({ page }) => {
  const csv = ['n2', ...Array.from({ length: 600 }, (_, i) => `row ${i + 1}`)].join('\n')
  await page.getByLabel('Text', { exact: true }).fill('{{n2}}')
  await pasteData(page, csv)
  await expect(page.getByText('Only the first 500 rows were kept.')).toBeVisible()
  await expect(page.getByText('500 rows is the maximum for one batch.')).toBeVisible()
  await expect(panelToggle(page)).toContainText('500 labels')
  await expect(page.getByRole('button', { name: 'Row', exact: true })).toBeDisabled()
  await expect(page.getByText('Rows 1–20 of 500')).toBeVisible()
  await page.getByRole('button', { name: 'Next rows' }).click()
  await expect(table(page).getByRole('textbox', { name: 'n2, row 21' })).toHaveValue('row 21')
})

test('keyboard only: type rows, move with arrows, Enter adds a row', async ({ page }) => {
  await openPanel(page)
  await page.getByRole('button', { name: 'New table' }).focus()
  await page.keyboard.press('Enter')
  // The new column's name is selected: rename it by typing.
  await page.keyboard.type('item')
  await page.keyboard.press('Enter')
  await expect(table(page).getByRole('textbox', { name: 'Column 1 name' })).toHaveValue('item')
  await page.getByLabel('Text', { exact: true }).fill('{{item}}')

  const first = table(page).getByRole('textbox', { name: 'item, row 1' })
  await first.focus()
  await page.keyboard.type('Bolts')
  await page.keyboard.press('Enter') // last row: adds one and moves there
  await expect(table(page).getByRole('textbox', { name: 'item, row 2' })).toBeFocused()
  await page.keyboard.type('Nuts')
  await page.keyboard.press('ArrowUp')
  await expect(first).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(table(page).getByRole('textbox', { name: 'item, row 2' })).toHaveValue('Nuts')
  await expect(panelToggle(page)).toContainText('2 labels')

  // Remove a row with the keyboard; focus stays in the table.
  await table(page).getByRole('button', { name: 'Remove row 2' }).focus()
  await page.keyboard.press('Enter')
  await expect(table(page).getByRole('textbox', { name: 'item, row 2' })).toHaveCount(0)
  await expect(first).toBeFocused()
})

test('360 px: the batch panel fits the phone without horizontal page scroll', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('{{name}} {{room}} {{shelf}} {{bin}}')
  await pasteData(page, 'name,room,shelf,bin\nAda,Lab 1,A,1\nGrace,Lab 2,B,2')
  await page.setViewportSize({ width: 360, height: 760 })
  await panelToggle(page).scrollIntoViewIfNeeded()
  await expect(page.getByRole('list', { name: 'Batch labels' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  const box = await panelToggle(page).boundingBox()
  expect(box && box.height >= 44).toBe(true)
  // The wide table scrolls inside its own box.
  const scroller = table(page).locator('xpath=..')
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
})
