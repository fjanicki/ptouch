// P-size (docs/FONTS-AND-SIZE-PLAN.md §3.3) — text sizing in the studio: the quick sizes show the
// label length each one gives (and the chosen one matches the preview), "Use for new text" sets
// the size of the next text block, "Shrink text to fit length" keeps long text on a fixed-length
// label, and the compact quick sizes under the preview fit an iPhone at 375 px.
import { devices, expect, test, type Page } from '@playwright/test'
import { removeDeviceApis, stubSerial } from './fixtures/serial-stub'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const quick = (page: Page) => page.getByRole('group', { name: 'Quick text size' })
const near = (page: Page) => page.getByRole('group', { name: 'Text size of the selected block' })

async function printedMm(page: Page): Promise<number> {
  const t = await preview(page).getByText(/ printed \+ 2 × /).textContent()
  return Number(/([\d.]+) mm printed/.exec(t ?? '')?.[1] ?? NaN)
}

/** The length readout of a quick size button (its description), in mm. */
async function readoutMm(page: Page, name: string): Promise<number> {
  const id = await quick(page).getByRole('button', { name, exact: true }).getAttribute('aria-describedby')
  const t = await page.locator(`[id="${id}"]`).textContent()
  return Number(/(\d+) mm/.exec(t ?? '')?.[1] ?? NaN)
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./')
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  })

  test('choosing S makes the label shorter, as its readout said, and the readout matches the preview', async ({ page }) => {
    const first = await printedMm(page)
    await page.getByLabel('Text', { exact: true }).fill('Hello world')
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => printedMm(page)).toBeGreaterThan(first + 5)
    await expect.poll(() => readoutMm(page, 'M, medium')).toBe(Math.round(await printedMm(page)))
    const medium = await printedMm(page)
    // Every size has a readout; smaller sizes give shorter labels.
    const estimates = await Promise.all(['XS, extra small', 'S, small', 'M, medium', 'L, large', 'Fit tape'].map((n) => readoutMm(page, n)))
    expect(estimates.every(Number.isFinite)).toBe(true)
    expect([...estimates].sort((a, b) => a - b)).toEqual(estimates)
    const estimateS = await readoutMm(page, 'S, small')

    await quick(page).getByRole('button', { name: 'S, small', exact: true }).click()
    await expect(quick(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(near(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => printedMm(page)).toBeLessThan(medium - 2)
    const small = await printedMm(page)
    expect(Math.abs(estimateS - small)).toBeLessThanOrEqual(1)
    await expect.poll(() => readoutMm(page, 'S, small')).toBe(Math.round(small))
    await expect(quick(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAccessibleDescription(`${Math.round(small)} mm`)
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAccessibleDescription(/^≈ \d+ mm$/)
  })

  test('the compact sizes under the preview change the selected block', async ({ page }) => {
    const before = await printedMm(page)
    await near(page).getByRole('button', { name: 'L, large', exact: true }).click()
    await expect(quick(page).getByRole('button', { name: 'L, large', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => printedMm(page)).toBeGreaterThan(before)
    // Undo restores the size (one history step).
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('“Use for new text” gives the next text block this size, and the choice is remembered', async ({ page }) => {
    await page.getByRole('radio', { name: 'Points' }).click()
    const size = page.getByLabel('Font size')
    await size.fill('9')
    await size.blur()
    await page.getByRole('button', { name: 'Use for new text' }).click()
    await expect(page.getByLabel('Size of new text')).toHaveValue('pt')
    await expect(page.getByLabel('Size of new text').locator('option:checked')).toHaveText('9 pt')
    await page.getByRole('button', { name: 'Insert Text' }).click()
    await expect(page.getByRole('radio', { name: 'Points' })).toBeChecked()
    await expect(page.getByLabel('Font size')).toHaveValue('9')

    // Quick size S is remembered as "a third of the band", for any tape.
    await quick(page).getByRole('button', { name: 'S, small', exact: true }).click()
    await page.getByRole('button', { name: 'Use for new text' }).click()
    await expect(page.getByLabel('Size of new text')).toHaveValue('third')
    await page.reload()
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await expect(page.getByLabel('Size of new text')).toHaveValue('third')
    await page.getByRole('button', { name: 'Insert Text' }).click()
    await expect(quick(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // Back to the default.
    await page.getByLabel('Size of new text').selectOption('auto')
    await page.getByRole('button', { name: 'Insert Text' }).click()
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('shrink text to fit length keeps long text on a fixed-length label', async ({ page }) => {
    await page.getByLabel('Text', { exact: true }).fill('A very long label text that will not fit')
    await expect(page.getByRole('switch', { name: 'Shrink text to fit length' })).toHaveCount(0) // auto length
    await page.getByRole('radiogroup', { name: 'Length' }).getByRole('radio', { name: 'Fixed' }).click()
    const length = page.getByLabel('Printed length')
    await length.fill('40')
    await length.blur()
    await expect.poll(() => printedMm(page)).toBeCloseTo(40, 0)
    const overflow = page.getByText(/longer than the fixed label length/).first()
    await expect(overflow).toBeVisible()
    await expect(overflow).toContainText('Shrink text to fit length')

    const shrink = page.getByRole('switch', { name: 'Shrink text to fit length' })
    await shrink.focus()
    await page.keyboard.press('Space')
    await expect(shrink).toBeChecked()
    await expect(page.getByText(/longer than the fixed label length/)).toHaveCount(0)
    expect(await printedMm(page)).toBeCloseTo(40, 0)
    // Turned off again: cut off again.
    await page.keyboard.press('Space')
    await expect(shrink).not.toBeChecked()
    await expect(page.getByText(/longer than the fixed label length/).first()).toBeVisible()
  })
})

test.describe('tape changes keep the quick size', () => {
  const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
  /** The real PT-P710BT status with another tape width (byte 10). */
  const statusFor = (widthMm: number) => {
    const s = [0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    s[10] = widthMm
    return s
  }

  test('M chosen on 24 mm stays M on 12 mm: the label gets shorter, not as tall as the tape', async ({ page }) => {
    await page.goto('./')
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await page.getByLabel('Text', { exact: true }).fill('Hello')
    await quick(page).getByRole('button', { name: 'M, medium', exact: true }).click()
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    const on24 = await printedMm(page)
    await page.getByRole('radio', { name: '12' }).click()
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => printedMm(page)).toBeLessThan(on24 * 0.7)
    await page.getByRole('radio', { name: '9' }).click()
    await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/was reduced to fit/)).toHaveCount(0)
  })

  for (const [width, pressed] of [
    [12, 'M, medium'],
    [9, 'Fit tape'],
  ] as const) {
    test(`a new label follows the loaded ${width} mm tape with that tape’s default size (${pressed})`, async ({ page }) => {
      await stubSerial(page, { openFailures: 0, status: statusFor(width) })
      await page.goto('./')
      await expect(preview(page)).toHaveAttribute('data-ready', 'true')
      await chip(page).click()
      await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
      await expect(chip(page)).toHaveAccessibleName(new RegExp(`${width} mm`))
      await expect(page.getByRole('radio', { name: String(width) })).toBeChecked()
      await expect(quick(page).getByRole('button', { name: pressed, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText(/was reduced to fit/)).toHaveCount(0)
    })
  }
})

for (const [w, h] of [
  [1024, 768],
  [1280, 800],
] as const) {
  test(`${w}×${h}: the compact quick sizes are on screen, not under the print bar`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h })
    await page.goto('./')
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await expect(near(page)).toBeInViewport({ ratio: 1 })
    for (const name of ['XS, extra small', 'Fit tape']) {
      const covered = await near(page).getByRole('button', { name, exact: true }).evaluate((el) => {
        const r = el.getBoundingClientRect()
        return !el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      })
      expect(covered, name).toBe(false)
    }
  })
}

test('“Use for new text” on an empty block keeps its size (not 4 pt)', async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await page.getByLabel('Text', { exact: true }).fill('')
  await page.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Fixed' }).click()
  const cap = page.getByLabel('Cap height')
  await cap.fill('7')
  await cap.blur()
  await page.getByRole('button', { name: 'Use for new text' }).click()
  await expect(page.getByLabel('Size of new text')).toHaveValue('pt')
  const pt = Number(/([\d.]+) pt/.exec((await page.getByLabel('Size of new text').locator('option:checked').textContent()) ?? '')?.[1])
  expect(pt).toBeGreaterThan(20)
})

test.describe('iPhone 375 px', () => {
  const { userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ viewport: { width: 375, height: 812 }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the compact quick sizes fit without horizontal scrolling and are finger-sized', async ({ page }) => {
    await removeDeviceApis(page)
    await page.goto('./')
    await page.getByRole('button', { name: 'Start designing' }).click()
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await expect(near(page)).toBeVisible()
    for (const name of ['XS, extra small', 'S, small', 'M, medium', 'L, large', 'Fit tape']) {
      const box = await near(page).getByRole('button', { name, exact: true }).boundingBox()
      expect(box, name).not.toBeNull()
      expect(box!.height, name).toBeGreaterThanOrEqual(44)
      expect(box!.width, name).toBeGreaterThanOrEqual(44)
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(375)
    }
    // Right under the preview, on the first screen.
    const pv = await preview(page).boundingBox()
    const nb = await near(page).boundingBox()
    expect(nb!.y).toBeGreaterThanOrEqual(pv!.y + pv!.height - 1)
    expect(nb!.y + nb!.height).toBeLessThanOrEqual(812)
    // Every readout stays inside its button (it wraps instead of spilling over the border).
    for (const name of ['XS, extra small', 'S, small', 'M, medium', 'L, large', 'Fit tape']) {
      const spill = await near(page).getByRole('button', { name, exact: true }).evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(spill, name).toBeLessThanOrEqual(0)
    }
    // "Size of new text" shows its whole option.
    const sel = page.getByLabel('Size of new text')
    await sel.scrollIntoViewIfNeeded()
    expect(await sel.evaluate((el: HTMLSelectElement) => {
      const c = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      const cs = getComputedStyle(el)
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const text = c.measureText(el.options[el.selectedIndex]?.text ?? '').width
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - text
    })).toBeGreaterThanOrEqual(0)
    const before = await printedMm(page)
    await near(page).getByRole('button', { name: 'S, small', exact: true }).tap()
    await expect(near(page).getByRole('button', { name: 'S, small', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => printedMm(page)).toBeLessThan(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})
