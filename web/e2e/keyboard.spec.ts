// Keyboard and screen-reader behaviour (review fixes): focus never falls to <body> when the
// connect dialog, the print bar or the block list swap their content; a silent handshake can be
// cancelled; single-key shortcuts do not fire on controls; the studio has an h1.
import { expect, test, type Page } from '@playwright/test'
import { stubSerial } from './fixtures/serial-stub'

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })
const activeTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? '')

async function ready(page: Page): Promise<void> {
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
}

test('connect dialog keeps focus inside while connecting, and can be cancelled', async ({ page }) => {
  await stubSerial(page, { silent: true, openFailures: 0 })
  await ready(page)
  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^Bluetooth/ }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog.getByText('Talking to the printer…')).toBeVisible()
  expect(await activeTag(page)).not.toBe('BODY')
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(chip(page)).toHaveAccessibleName(/Connect printer/)
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
})

test('print moves focus to Cancel and back to Print', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, printMs: 2500 })
  await ready(page)
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(page.getByRole('dialog')).toBeHidden()
  await printButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 20_000 })
  await expect(printButton(page)).toBeFocused()
})

test('deleting a block keeps the keyboard place; single keys do not act on a switch', async ({ page }) => {
  await ready(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  const blocks = page.getByRole('region', { name: 'Blocks' })
  await blocks.getByRole('button', { name: /^Duplicate/ }).first().click()
  await blocks.getByRole('button', { name: /^Delete/ }).first().focus()
  await page.keyboard.press('Enter')
  expect(await activeTag(page)).not.toBe('BODY')
  await blocks.getByRole('button', { name: /^Delete/ }).first().focus()
  await page.keyboard.press('Enter')
  expect(await activeTag(page)).not.toBe('BODY')

  const zoom = page.getByRole('button', { name: /^Zoom \d+ %/ })
  const before = await zoom.getAttribute('aria-label')
  await page.getByRole('switch').first().focus()
  await page.keyboard.press('1')
  expect(await zoom.getAttribute('aria-label')).toBe(before)
  // On the preview the same key works.
  await page.getByRole('group', { name: /Label preview/ }).focus()
  await page.keyboard.press('1')
  await expect(zoom).toHaveAccessibleName(/Zoom 100 %/)
})
