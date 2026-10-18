// P-render-templates (docs/MODELS-PLAN.md §3.9–§3.11) — rendering, templates and carry-through
// for other printer models: a 36 mm label designed for the PT-P910BT exports at 360 dpi; the
// template gallery hides the 36 mm templates on the PT-P710BT behind "other tape widths" (marked,
// still openable: the label opens on the stand-in with the "Fit to 24 mm" notice), shows them on
// the PT-P910BT with "M" of its band; the print history names the model a label was printed on
// and marks a width the active model lacks (Reprint is then blocked with the notice's message).
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Download, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const media = (page: Page) => page.getByRole('region', { name: 'Tape and length' })
const widths = (page: Page) => page.getByRole('radiogroup', { name: 'Tape width (mm)' })
const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const toasts = (page: Page) => page.getByRole('log', { name: 'Notifications' })
const gallery = (page: Page) => page.getByRole('dialog', { name: 'New from template' })
const card = (page: Page, name: string) => gallery(page).getByRole('button', { name, exact: true })
const quick = (page: Page) => page.getByRole('group', { name: 'Quick text size' })

async function settled(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
}

async function openFromLabels(page: Page, item: string, title: string) {
  await page.getByRole('button', { name: 'Labels' }).click()
  await page.getByRole('menuitem', { name: item }).click()
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  return dialog
}

async function designFor(page: Page, model: string): Promise<void> {
  await media(page).getByLabel('Printer model').selectOption(model)
  await expect(media(page).getByLabel('Printer model')).toHaveValue(model)
}

async function readDownload(d: Download): Promise<Buffer> {
  const stream = await d.createReadStream()
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(parts)
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await settled(page)
})

test('design a 36 mm label for the PT-P910BT: it exports at 360 dpi, 454 dots across', async ({ page }) => {
  await designFor(page, 'PT-P910BT')
  await widths(page).getByRole('radio', { name: '36' }).click()
  await page.getByLabel('Label name').fill('Archive box')
  await page.getByLabel('Text', { exact: true }).fill('Archive 2026')
  await settled(page)
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()

  const dialog = await openFromLabels(page, 'Export image (PNG, PDF)…', 'Export image')
  await expect(dialog.getByText(/360 dpi \(1 dot = 0\.071 mm\) · PT-P910BT/)).toBeVisible()
  await expect(dialog.getByText(/× 32 mm \(\d+ × 454 dots\)/)).toBeVisible()
  const [png] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Download PNG/ }).click()])
  const bytes = await readDownload(png)
  expect(bytes.readUInt32BE(20)).toBe(454) // IHDR height: the 36 mm band of a 360 dpi head
  const phys = bytes.indexOf(Buffer.from('pHYs'))
  expect(phys).toBeGreaterThan(0)
  expect([bytes.readUInt32BE(phys + 4), bytes.readUInt32BE(phys + 8), bytes[phys + 12]]).toEqual([14173, 14173, 1])

  const [pdf] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /Download PDF/ }).click()])
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec((await readDownload(pdf)).toString('latin1'))
  expect((Number(box?.[2]) * 25.4) / 72).toBeCloseTo(36, 0) // the whole tape width
})

test('PT-P710BT: 36 mm templates sit under "other tape widths", marked, and open on the stand-in with "Fit to 24 mm"', async ({ page }) => {
  await openFromLabels(page, 'New from template…', 'New from template')
  await expect(gallery(page).locator('[data-template]')).toHaveCount(13)
  await expect(card(page, 'Wi-Fi sticker (36 mm)')).toHaveCount(0)
  const toggle = gallery(page).getByRole('button', { name: 'Show templates for other tape widths (4)' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(gallery(page).locator('[data-template]')).toHaveCount(17)
  for (const name of ['Wi-Fi sticker (36 mm)', 'Shelf or bin label (36 mm)', 'Folder spine (36 mm)', 'Name tag (36 mm)']) {
    await expect(card(page, name), name).toHaveAccessibleDescription(/^Needs 36 mm tape · PT-P710BT takes up to 24 mm/)
  }
  // Thumbnails are drawn with a model that takes 36 mm (never a broken card).
  const thumb = card(page, 'Name tag (36 mm)').locator('.thumb')
  await thumb.scrollIntoViewIfNeeded()
  await expect(thumb).toHaveAttribute('data-state', 'ready')
  await expect(card(page, 'Name tag (36 mm)')).toHaveAccessibleDescription(/[\d.]+ mm label/)

  await card(page, 'Shelf or bin label (36 mm)').click()
  await expect(gallery(page)).toBeHidden()
  const notice = page.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })
  await expect(notice).toBeVisible()
  await settled(page)
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  // The text was sized on the stand-in's band: the editor shows it as "M".
  await page.getByRole('region', { name: 'Blocks' }).getByRole('listitem').nth(1).click()
  await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // The export says it is drawn for the stand-in.
  const dialog = await openFromLabels(page, 'Export image (PNG, PDF)…', 'Export image')
  await expect(dialog.getByText(/360 dpi .* · PT-P910BT/)).toBeVisible()
  await expect(dialog.getByText('This label is 36 mm; PT-P710BT takes up to 24 mm. The export shows the label as printed on a PT-P910BT.')).toBeVisible()
  await page.keyboard.press('Escape')

  // Fit to 24 mm: M stays M on the PT-P710BT's band.
  await notice.getByRole('button', { name: 'Fit to 24 mm' }).click()
  await expect(widths(page).getByRole('radio', { name: '24' })).toBeChecked()
  await settled(page)
  await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('PT-P910BT: 36 mm templates are in their sections and open with M of the 360 dpi band', async ({ page }) => {
  await designFor(page, 'PT-P910BT')
  await openFromLabels(page, 'New from template…', 'New from template')
  await expect(gallery(page).getByLabel('Printer model')).toHaveValue('PT-P910BT')
  await expect(gallery(page).locator('[data-template]')).toHaveCount(17)
  await expect(gallery(page).getByRole('button', { name: /Show templates for other tape widths/ })).toHaveCount(0)
  await expect(card(page, 'Wi-Fi sticker (36 mm)')).toHaveAccessibleDescription(/^36 mm tape/)

  // Switching the model in the gallery moves the 36 mm templates out again.
  await gallery(page).getByLabel('Printer model').selectOption('PT-P300BT')
  await expect(gallery(page).locator('[data-template]')).toHaveCount(6) // the 9 and 12 mm templates
  await gallery(page).getByRole('button', { name: /Show templates for other tape widths \(11\)/ }).click()
  await expect(card(page, 'Wi-Fi sticker (24 mm)')).toHaveAccessibleDescription(/^Needs 24 mm tape · PT-P300BT takes up to 12 mm/)
  await gallery(page).getByLabel('Printer model').selectOption('PT-P910BT')

  await card(page, 'Shelf or bin label (36 mm)').click()
  await expect(gallery(page)).toBeHidden()
  await settled(page)
  await expect(widths(page).getByRole('radio', { name: '36' })).toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: /This label is/ })).toHaveCount(0)
  await page.getByRole('region', { name: 'Blocks' }).getByRole('listitem').nth(1).click()
  await expect(quick(page).getByRole('button', { name: 'M, medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('print history names the model; on a PT-P710BT a 36 mm record is marked and Reprint is blocked', async ({ page }) => {
  await chip(page).click()
  const connect = page.getByRole('dialog', { name: /Connect your printer/ })
  await connect.getByLabel('Printer model').selectOption('PT-P910BT')
  await connect.getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P910BT · 36 mm/)
  await expect(page.locator('dialog[open]')).toHaveCount(0) // "Printer connected" closes by itself
  // The untouched new label followed the loaded 36 mm cassette.
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await page.getByLabel('Label name').fill('Crate 7')
  await page.getByLabel('Text', { exact: true }).fill('Crate 7')
  await settled(page)
  await expect(preview(page).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await page.getByRole('button', { name: 'Print label' }).click()
  await expect(toasts(page).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 20_000 })

  // While the PT-P910BT is the active model, the record does not repeat its name.
  let dialog = await openFromLabels(page, 'Print history…', 'Print history')
  let list = dialog.getByRole('list', { name: 'Printed labels' })
  await expect(list).toContainText('36 mm tape · 1 label')
  await expect(list).not.toContainText('PT-P910BT')
  await expect(list.locator('[data-needs]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Back to the PT-P710BT (virtual): the record names the PT-P910BT and is marked.
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('dialog').getByLabel('Printer model').selectOption('PT-P710BT')
  await page.getByRole('dialog').getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  dialog = await openFromLabels(page, 'Print history…', 'Print history')
  list = dialog.getByRole('list', { name: 'Printed labels' })
  await expect(list).toContainText('36 mm tape · PT-P910BT · 1 label')
  await expect(list.locator('[data-needs]')).toHaveText('Needs 36 mm tape · PT-P710BT takes up to 24 mm')

  // Reprint opens the label (36 mm, unchanged) and the print gate explains why it can't print.
  await dialog.getByRole('button', { name: 'Reprint Crate 7' }).click()
  await expect(dialog).toBeHidden()
  await expect(toasts(page).filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm. Fit it to 24 mm to print it.' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print label' })).toBeDisabled()
  dialog = await openFromLabels(page, 'Print history…', 'Print history')
  await expect(dialog.getByRole('list', { name: 'Printed labels' }).getByRole('listitem')).toHaveCount(1)
})

// A share link opens untouched (createdAt === updatedAt) but is not a new label: it must never
// follow the "Design for" model at boot.
test('a 36 mm share link carries width and model; on a PT-P710BT it opens unchanged, with the notice', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await designFor(page, 'PT-P910BT')
  await widths(page).getByRole('radio', { name: '36' }).click()
  await page.getByLabel('Text', { exact: true }).fill('Shared 36')
  await settled(page)
  await page.getByRole('button', { name: 'Labels', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('#d=')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  const json = inflateRawSync(Buffer.from(link.split('#d=')[1] ?? '', 'base64url')).toString('utf8')
  expect(json).toContain('"schema":5')
  expect(json).toMatch(/"tape":\{[^}]*"widthMm":36[^}]*\}/)
  expect(json).toMatch(/"tape":\{[^}]*"model":"PT-P910BT"[^}]*\}/)

  // Another browser (default "Design for": PT-P710BT) opens it as 36 mm, rendered on the stand-in.
  const other = await (await browser.newContext()).newPage()
  await other.goto(link)
  await settled(other)
  await expect(other.getByRole('alert').filter({ hasText: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })).toBeVisible()
  await expect(preview(other).getByRole('figure', { name: /on 36 mm tape/ })).toBeVisible()
  await expect(other.getByLabel('Text', { exact: true })).toHaveValue('Shared 36')
  await other.context().close()
})
