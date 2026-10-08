// Editor flows (W4): add/edit text and codes with a live preview, reorder, delete, undo/redo,
// keyboard-only use, and basic accessibility checks (every control has a name).
import { expect, test, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')

/** PNG of the preview canvas (the exact printed dots, tinted). */
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

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await waitRendered(page)
})

test('typing text updates the preview and the block list', async ({ page }) => {
  const before = await previewPixels(page)
  const text = page.getByLabel('Text', { exact: true })
  await text.fill('M3 × 12\nDIN 912')
  await waitRendered(page, before)
  await expect(blocks(page).first()).toContainText('M3 × 12')
  const length = await preview(page).locator('figcaption').innerText()
  expect(length).toMatch(/\d+(\.\d)? mm/)
})

test('insert a QR code, edit it, switch to EAN-13 with validation', async ({ page }) => {
  const before = await previewPixels(page)
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await expect(blocks(page)).toHaveCount(2)
  await expect(page.getByRole('heading', { name: /Code block/ })).toBeVisible()
  await waitRendered(page, before)
  await page.getByLabel('Content').fill('https://fjanicki.github.io/ptouch/')
  await expect(blocks(page).nth(1)).toContainText('https://fjanicki.github.io')
  await page.getByRole('radio', { name: 'EAN-13' }).click()
  const data = page.getByRole('textbox', { name: 'Data' })
  await expect(data).toHaveValue(/^\d{12,13}$/)
  await data.fill('12AB')
  await expect(page.getByText('EAN-13 takes digits only.')).toBeVisible()
  await expect(data).toHaveAttribute('aria-invalid', 'true')
})

test('reorder with Alt+arrows, delete, undo and redo', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('First')
  await page.getByRole('button', { name: 'Insert Icon' }).click()
  await expect(blocks(page)).toHaveCount(2)
  await expect(blocks(page).nth(1)).toContainText('Icon')

  // Keyboard reorder: focus the icon row, Alt+↑ moves it before the text.
  await blocks(page).nth(1).getByRole('button', { pressed: true }).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(blocks(page).first()).toContainText('Icon')
  await expect(blocks(page).nth(1)).toContainText('First')

  // Delete, then undo / redo via shortcuts (focus outside text fields).
  await blocks(page).first().getByRole('button', { name: /^Delete/ }).click()
  await expect(blocks(page)).toHaveCount(1)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.keyboard.press(`${mod}+z`)
  await expect(blocks(page)).toHaveCount(2)
  await expect(blocks(page).first()).toContainText('Icon')
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(blocks(page)).toHaveCount(1)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(blocks(page)).toHaveCount(2)
})

test('keyboard-only: insert, edit and select blocks without a mouse', async ({ page }) => {
  await page.getByRole('button', { name: 'Insert Text' }).focus()
  await page.keyboard.press('Enter')
  await expect(blocks(page)).toHaveCount(2)
  const text = page.getByLabel('Text', { exact: true })
  await text.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Keyboard')
  await expect(blocks(page).nth(1)).toContainText('Keyboard')
  // ArrowUp in the list moves selection; the properties panel follows.
  await blocks(page).nth(1).getByRole('button', { pressed: true }).focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('heading', { name: /Text block 1\/2/ })).toBeVisible()
  // Shortcuts dialog opens with "?" and closes with Escape.
  await page.locator('body').press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden()
})

test('tape width, length and zoom controls drive the preview', async ({ page }) => {
  const before = await previewPixels(page)
  await page.getByRole('radio', { name: '12' }).click()
  await waitRendered(page, before)
  await expect(preview(page).getByText(/12 mm tape · printable/)).toBeVisible()
  await page.getByRole('radio', { name: 'Fixed' }).first().click()
  await page.getByLabel('Printed length').fill('80')
  await expect(preview(page).getByText(/^80 mm printed/)).toBeVisible()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.getByRole('button', { name: /^Zoom \d+ %\. Activate to fit/ })).toBeVisible()
  await page.getByRole('button', { name: /^Zoom/ }).filter({ hasText: '%' }).click()
  await expect(page.getByRole('button', { name: /fit to window/ })).toBeVisible()
})

test('every control has an accessible name and ids are unique', async ({ page }) => {
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  const problems = await page.evaluate(() => {
    const out: string[] = []
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el).position === 'fixed'
    const named = (el: Element): boolean => {
      if (el.getAttribute('aria-label')?.trim()) return true
      const by = el.getAttribute('aria-labelledby')
      if (by && by.split(/\s+/).every((id) => document.getElementById(id)?.textContent?.trim())) return true
      if ((el as HTMLInputElement).labels?.length) return true
      if (el.tagName === 'BUTTON' && el.textContent?.trim()) return true
      return false
    }
    for (const el of document.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role=radio], [role=switch]')) {
      if (!visible(el) && !(el instanceof HTMLInputElement && el.type === 'checkbox')) continue
      if (el instanceof HTMLInputElement && el.type === 'file') continue
      if (!named(el)) out.push(`unnamed ${el.tagName.toLowerCase()} ${el.outerHTML.slice(0, 80)}`)
    }
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
    for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) out.push(`duplicate id ${id}`)
    if (!document.querySelector('main')) out.push('no main landmark')
    return out
  })
  expect(problems).toEqual([])
})

// 16×16 PNG: black square on white (generated once, inlined to keep the test hermetic).
const PNG_16 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAFklEQVR4nGP4jwYYyBRggIKBFqDQLwCg+79B5TZx+wAAAABJRU5ErkJggg==',
  'base64',
)

test('insert an image: file picker, dithering options, preview updates', async ({ page }) => {
  const before = await previewPixels(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Insert Image' }).click()
  await (await chooser).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG_16 })
  await expect(blocks(page)).toHaveCount(2)
  await expect(page.getByRole('heading', { name: /Image block/ })).toBeVisible()
  await expect(page.getByLabel('Dithering')).toHaveValue('floyd-steinberg')
  await waitRendered(page, before)
  await page.getByLabel('Dithering').selectOption('threshold')
  await expect(page.getByRole('slider', { name: 'Threshold' })).toBeVisible()
})

test('labels are saved: new label, reopen the first from the library, reload keeps it', async ({ page }) => {
  await page.getByLabel('Label name').fill('Drawer A1')
  await page.getByLabel('Text', { exact: true }).fill('M4 nuts')
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: 'New label' }).click()
  await expect(page.getByLabel('Label name')).toHaveValue('Untitled label')
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: 'Open…' }).click()
  const library = page.getByRole('dialog', { name: 'Your labels' })
  await library.getByRole('button', { name: 'Open Drawer A1' }).click()
  await expect(library).toBeHidden()
  await expect(page.getByLabel('Label name')).toHaveValue('Drawer A1')
  await expect(blocks(page).first()).toContainText('M4 nuts')
  await page.waitForTimeout(700) // autosave debounce
  await page.reload()
  await expect(page.getByLabel('Label name')).toHaveValue('Drawer A1')
  await expect(blocks(page).first()).toContainText('M4 nuts')
})
