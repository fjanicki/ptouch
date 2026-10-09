// P2 — "New from template": the gallery opens from the Labels menu, shows live thumbnails,
// is keyboard-navigable, marks templates that fit the loaded tape, works at 360 px, and opens
// the chosen template as a new label (fresh history, main block selected). P-size: each card
// shows the printed length its thumbnail measured.
import { expect, test, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const gallery = (page: Page) => page.getByRole('dialog', { name: 'New from template' })
const card = (page: Page, name: string) => gallery(page).getByRole('button', { name, exact: true })

async function openGallery(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: 'New from template…' }).click()
  await expect(gallery(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
})

test('pick “Wi-Fi sticker (12 mm)”: a new 12 mm label with a QR block and a text block', async ({ page }) => {
  await page.getByLabel('Text', { exact: true }).fill('My old label')
  await openGallery(page)
  for (const section of ['Wi-Fi', 'Cables', 'Shelves, bins & drawers', 'Office']) await expect(gallery(page).getByRole('heading', { name: section })).toBeVisible()
  await expect(gallery(page).getByRole('button')).toHaveCount(11) // 10 cards + Close
  // Thumbnails render lazily; the cards in view are drawn.
  await expect(gallery(page).locator('.thumb[data-state="ready"]').first()).toBeVisible()
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).toHaveAccessibleDescription(/12 mm tape.*iPhone Camera/)

  await card(page, 'Wi-Fi sticker (12 mm)').click()
  await expect(gallery(page)).toBeHidden()
  await expect(preview(page).getByText(/12 mm tape · printable/)).toBeVisible()
  await expect(blocks(page)).toHaveCount(2)
  await expect(blocks(page).nth(1)).toContainText('Wi-Fi') // "Wi-Fi" over {{ssid}}
  // The Wi-Fi code is selected so its network can be entered right away.
  await expect(page.getByRole('heading', { name: /Code block 1\/2/ })).toBeVisible()
  // A new label with its own (empty) history.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await expect(page.getByRole('region', { name: 'Blocks' })).not.toContainText('My old label')
  await expect(page.locator('[aria-live="polite"].visually-hidden')).toHaveText('New label: Wi-Fi sticker')
})

test('every card shows the label length the editor shows; the Wi-Fi stickers are small', async ({ page }) => {
  await openGallery(page)
  const lengthOf = async (name: string): Promise<number> => {
    const c = card(page, name)
    await c.scrollIntoViewIfNeeded()
    await expect(c).toHaveAccessibleDescription(/[\d.]+ mm label/)
    return Number(/([\d.]+) mm label/.exec((await c.locator('[data-length]').textContent()) ?? '')?.[1] ?? NaN)
  }
  // Label length = printed length + 2 × 2 mm feed (the 12 mm sticker prints ≤ 40 mm).
  const small = await lengthOf('Wi-Fi sticker (12 mm)')
  expect(small).toBeGreaterThanOrEqual(29)
  expect(small).toBeLessThanOrEqual(44)
  await expect(card(page, 'Wi-Fi sticker (12 mm)').locator('[data-length]')).toContainText('with a sample network')
  const large = await lengthOf('Wi-Fi sticker (24 mm)')
  expect(large).toBeLessThanOrEqual(84)
  for (const name of ['Cable flag', 'Shelf or bin label (24 mm)', 'Drawer label (12 mm)', 'Gridfinity bin (12 mm)', 'Asset tag', 'Folder spine', 'Name tag']) {
    expect(await lengthOf(name), name).toBeLessThanOrEqual(104)
    await expect(card(page, name).locator('[data-length]'), name).not.toContainText('sample')
  }
  // Gridfinity: 32 mm printed + feed, as its description says (≈ 36 mm piece) and as the editor shows.
  expect(await lengthOf('Gridfinity bin (12 mm)')).toBe(36)
  for (const name of ['Gridfinity bin (12 mm)', 'Name tag']) {
    if (!(await gallery(page).isVisible())) await openGallery(page)
    const onCard = await lengthOf(name)
    await card(page, name).click()
    await expect(gallery(page)).toBeHidden()
    await expect(preview(page)).toHaveAttribute('data-ready', 'true')
    await expect(preview(page).locator('.readout strong').first()).toHaveText(`${onCard} mm`)
  }
})

test('keyboard: arrows move between cards, Enter opens one', async ({ page }) => {
  await openGallery(page)
  // Without a printer the first card has focus.
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'Wi-Fi sticker (24 mm)')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).toBeFocused()
  await page.keyboard.press('ArrowDown') // next row: the Cables section
  await expect(card(page, 'Cable flag')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).toBeFocused()
  await page.keyboard.press('End')
  await expect(card(page, 'Name tag')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(gallery(page)).toBeHidden()
  await expect(preview(page).getByText(/24 mm tape · printable/)).toBeVisible()
  await expect(blocks(page).first()).toContainText('Your Name')
  await expect(page.getByRole('heading', { name: /Text block 1\/1/ })).toBeVisible()
})

test('with the virtual printer (24 mm loaded), 24 mm templates are marked as fitting', async ({ page }) => {
  await page.getByRole('button', { name: /^Connection:/ }).click()
  await page.getByRole('dialog', { name: /Connect your printer/ }).getByRole('button', { name: /^No printer/ }).click()
  await expect(page.getByRole('button', { name: /^Connection:/ })).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await openGallery(page)
  await expect(gallery(page).getByText(/24 mm tape is loaded/)).toBeVisible()
  const fits = gallery(page).getByText('Fits the loaded tape', { exact: true })
  await expect(fits).toHaveCount(4)
  await expect(card(page, 'Wi-Fi sticker (24 mm)')).toHaveAccessibleDescription(/Fits the loaded tape/)
  await expect(card(page, 'Wi-Fi sticker (12 mm)')).not.toHaveAccessibleDescription(/Fits the loaded tape/)
  // The first fitting card gets focus.
  await expect(card(page, 'Wi-Fi sticker (24 mm)')).toBeFocused()
})

test('asset tag opens as a numbered batch label', async ({ page }) => {
  await openGallery(page)
  await card(page, 'Asset tag').click()
  await expect(preview(page).getByText(/12 mm tape · printable/)).toBeVisible()
  await expect(blocks(page)).toHaveCount(2)
  await expect(blocks(page).nth(1)).toContainText('Asset')
  // The counter batch (P1) prints Asset 0001…0010 in one job.
  await expect(page.getByRole('button', { name: 'Print 10 labels' })).toBeVisible()
  // A small tag: each label (feed margins included) stays well under 4 cm.
  await expect.poll(async () => Number.parseFloat((await preview(page).locator('.readout strong').first().textContent()) ?? '')).toBeLessThan(40)
})

test('360 px: the gallery fits the phone without horizontal scrolling', async ({ page }) => {
  // Opened at desktop width: at 360 px the Labels trigger shows only icons and has no accessible
  // name yet (reported to the lead; LabelsMenu is lead-owned).
  await openGallery(page)
  await page.setViewportSize({ width: 360, height: 740 })
  const box = await gallery(page).boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true)
  const overflow = await gallery(page).evaluate((d) => {
    const body = d.querySelector('.body') as HTMLElement
    return body.scrollWidth - body.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(0)
  const first = await card(page, 'Wi-Fi sticker (12 mm)').boundingBox()
  expect(first && first.width >= 280 && first.height >= 44).toBe(true)
  await card(page, 'Gridfinity bin (12 mm)').scrollIntoViewIfNeeded()
  await card(page, 'Gridfinity bin (12 mm)').click()
  await expect(gallery(page)).toBeHidden()
  await expect(blocks(page)).toHaveCount(2)
})
