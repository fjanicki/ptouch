// Lead (studio v1, docs/STUDIO-V1-PLAN.md) — every v1 entry point is reachable from the Labels
// menu and opens its dialog, which closes with Escape. Packages
// keep this green while they fill the dialogs (titles are frozen).
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
})

const ENTRIES: [menuItem: string, dialogTitle: string][] = [
  ['New from template…', 'New from template'],
  ['Print history…', 'Print history'],
  ['Export image (PNG, PDF)…', 'Export image'],
  ['Send to computer…', 'Send to computer'],
  ['Fonts…', 'Fonts'],
]

for (const [item, title] of ENTRIES) {
  test(`Labels → ${item} opens “${title}”`, async ({ page }) => {
    await page.getByRole('button', { name: 'Labels' }).click()
    await page.getByRole('menuitem', { name: item }).click()
    const dialog = page.getByRole('dialog', { name: title })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}

test('the batch panel and variable hints are mounted without errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await expect(page.getByRole('heading', { name: /Code block/ })).toBeVisible()
  expect(errors).toEqual([])
})
