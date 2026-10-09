// Lead (fonts and size, docs/FONTS-AND-SIZE-PLAN.md) — the frozen entry points: new text gets the
// user's default size (half the band on 12 mm and wider instead of "fit"), the quick sizes sit in
// the text properties and under the preview, and a text block can be sized in points. P-picker
// and P-size keep this green (the names used here are frozen).
import { expect, test, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })

async function printedMm(page: Page): Promise<number> {
  const t = await preview(page).getByText(/ printed \+ 2 × /).textContent()
  return Number(/([\d.]+) mm printed/.exec(t ?? '')?.[1] ?? NaN)
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
})

test('the first label’s text is half the tape height, and Fit makes it longer', async ({ page }) => {
  const props = page.getByRole('group', { name: 'Quick text size' })
  const near = page.getByRole('group', { name: 'Text size of the selected block' })
  await expect(props.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true')
  await expect(near.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true')
  const half = await printedMm(page)
  await near.getByRole('button', { name: 'Fit tape' }).click()
  await expect(props.getByRole('button', { name: 'Fit tape' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('radio', { name: 'Fit tape' })).toBeChecked()
  await expect.poll(() => printedMm(page)).toBeGreaterThan(half * 1.5)
})

test('a text block can be sized in points', async ({ page }) => {
  const half = await printedMm(page)
  await page.getByRole('radio', { name: 'Points' }).click()
  const size = page.getByLabel('Font size')
  await expect(size).toHaveValue('12')
  // 12 pt (30 dots em) is already well under half of the 24 mm band: wait for it to land, so
  // the 8 pt reading below is not taken from a render that is still in flight.
  await expect.poll(() => printedMm(page)).toBeLessThan(half * 0.6)
  const twelve = await printedMm(page)
  await size.fill('8')
  await size.blur()
  await expect.poll(() => printedMm(page)).toBeLessThan(twelve - 1)
  const small = await printedMm(page)
  await size.fill('20')
  await size.blur()
  await expect.poll(() => printedMm(page)).toBeGreaterThan(small * 1.5)
  await expect(page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'false')
})

test('the default size preference applies to new text blocks', async ({ page }) => {
  const quick = page.getByRole('group', { name: 'Quick text size' })
  await page.getByRole('button', { name: 'Insert Text' }).click()
  await expect(quick.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    const raw = localStorage.getItem('ptouch.prefs.v1')
    localStorage.setItem('ptouch.prefs.v1', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), defaultTextSize: 'fit' }))
  })
  await page.reload()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await page.getByRole('button', { name: 'Insert Text' }).click()
  await expect(quick.getByRole('button', { name: 'Fit tape' })).toHaveAttribute('aria-pressed', 'true')
})

test('the font control is still labelled “Font”', async ({ page }) => {
  await expect(page.getByLabel('Font', { exact: true })).toBeVisible()
})
