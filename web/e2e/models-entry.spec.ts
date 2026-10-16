// Lead (printer models, docs/MODELS-PLAN.md) — the frozen entry points: "Printer model" in the
// connect dialog picks the virtual printer's model (and the model designed for), the tape picker
// lists that model's widths (36 mm on the PT-P910BT), a 36 mm label renders, and going back to
// the PT-P710BT keeps the label at 36 mm with a notice and "Fit to 24 mm". P-core-ui and
// P-render-templates keep this green (the names used here are frozen).
import { expect, test, type Page } from '@playwright/test'

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const widths = (page: Page) => page.getByRole('radiogroup', { name: 'Tape width (mm)' })
const mediaBar = (page: Page) => page.getByRole('region', { name: 'Tape and length' })
const quickM = (page: Page) => page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'M, medium', exact: true })

test('design for a 36 mm model, then back to the PT-P710BT: the label keeps 36 mm until fitted', async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24'])

  // "No printer" with the PT-P910BT: a virtual 360 dpi printer with its widest tape (36 mm);
  // the untouched new label follows the cassette, as with a real printer.
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByLabel('Printer model').selectOption('PT-P910BT')
  await expect(dialog.getByRole('button', { name: /^No printer/ })).toContainText('virtual PT-P910BT')
  await dialog.getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(dialog).toBeHidden()

  // Its widths go up to 36 mm, and the 36 mm label renders; other widths work too.
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24', '36 •'])
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeChecked()
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await widths(page).getByRole('radio', { name: '18' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Tape mismatch' })).toBeVisible() // 36 mm is loaded
  await page.getByRole('button', { name: 'Use loaded 36 mm tape' }).click()
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeChecked()
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()

  // Back to the PT-P710BT (disconnect, then design for it): the label stays 36 mm and says so.
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('dialog').getByLabel('Printer model').selectOption('PT-P710BT')
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  const notice = page.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })
  await expect(notice).toBeVisible()
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await expect(widths(page).getByRole('radio')).toHaveText(['3.5', '6', '9', '12', '18', '24'])

  // One click fits it to the widest tape the PT-P710BT takes.
  await notice.getByRole('button', { name: 'Fit to 24 mm' }).click()
  await expect(widths(page).getByRole('radio', { name: '24' })).toBeChecked()
  await expect(notice).toBeHidden()
  await expect(preview(page).getByRole('figure', { name: /on 24 mm tape/ })).toBeVisible()
})

test('a new label follows the Design-for model without an undo step, so a cassette loaded later still moves it', async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')

  // The PT-N25BT stops at 12 mm: the untouched new label is re-made on 12 mm (nothing to undo).
  await mediaBar(page).getByLabel('Printer model').selectOption('PT-N25BT')
  await expect(widths(page).getByRole('radio', { name: '12' })).toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: /This label is/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  await expect(quickM(page)).toHaveAttribute('aria-pressed', 'true')

  // The PT-P910BT takes 12 mm too: the label keeps its width, and its text gets M of the 360 dpi
  // band (M of the PT-N25BT's 180 dpi band would be a fixed size there).
  await mediaBar(page).getByLabel('Printer model').selectOption('PT-P910BT')
  await expect(widths(page).getByRole('radio', { name: '12' })).toBeChecked()
  await expect(quickM(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()

  // A virtual PT-P910BT loads 36 mm: the label is still new and untouched, so it follows.
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByLabel('Printer model').selectOption('PT-P910BT')
  await dialog.getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: 'Tape mismatch' })).toHaveCount(0)
  await expect(quickM(page)).toHaveAttribute('aria-pressed', 'true')
})

test('a new label saved by following the model is still new after a reload', async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  // Re-made for the PT-N25BT (12 mm) and autosaved; after a reload it still follows the picker.
  await mediaBar(page).getByLabel('Printer model').selectOption('PT-N25BT')
  await expect(widths(page).getByRole('radio', { name: '12' })).toBeChecked()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ptouch.prefs.v1') ?? '{}').freshLabelId as string | undefined)).toBeTruthy()
  await page.waitForTimeout(1200) // autosave (500 ms)
  await page.reload()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(widths(page).getByRole('radio', { name: '12' })).toBeChecked()
  await mediaBar(page).getByLabel('Printer model').selectOption('PT-P910BT')
  await expect(quickM(page)).toHaveAttribute('aria-pressed', 'true')
  // A virtual PT-P910BT loads 36 mm: the label follows with M of the 36 mm band.
  await chip(page).click()
  await page.getByRole('dialog', { name: /Connect your printer/ }).getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(widths(page).getByRole('radio', { name: '36 •' })).toBeChecked()
  await expect(quickM(page)).toHaveAttribute('aria-pressed', 'true')

  // Edited, it is no longer new: after a reload the picker leaves its width alone.
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'L, large', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.reload()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await mediaBar(page).getByLabel('Printer model').selectOption('PT-P300BT')
  await expect(page.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P300BT takes up to 12 mm.' })).toBeVisible()
})
