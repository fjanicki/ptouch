// Connect + print flows (W4) against the virtual printer (wasm VirtualPrinter behind
// MockTransport) and against a stubbed Web Serial PT-P710BT (W2 fixture) whose first open()
// fails with NetworkError, like the real Mac.
import { expect, test, type Page } from '@playwright/test'
import { stubSerial, type SerialStubWindow } from './fixtures/serial-stub'

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const printButton = (page: Page) => page.getByRole('button', { name: /^Print (label|\d+ labels)$/ })

/** Records every value of the chip's data-state (transient states like "waking" are short). */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __states: string[] }
    w.__states = []
    const el = document.querySelector('[data-state]')
    if (!el) return
    w.__states.push(el.getAttribute('data-state') ?? '')
    new MutationObserver(() => w.__states.push(el.getAttribute('data-state') ?? '')).observe(el, { attributes: true, attributeFilter: ['data-state'] })
  })
}

test('add text, preview updates, print to the virtual printer', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
  await page.getByLabel('Text', { exact: true }).fill('Hello ptouch')
  await expect(page.getByRole('region', { name: 'Blocks' })).toContainText('Hello ptouch')

  await chip(page).click()
  const dialog = page.getByRole('dialog', { name: /Connect your printer/ })
  await dialog.getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(dialog).toBeHidden() // closes itself after a successful connect

  await page.getByRole('button', { name: 'More copies' }).click()
  await expect(printButton(page)).toHaveText(/Print 2 labels/)
  await expect(printButton(page)).toBeEnabled()
  await printButton(page).click()
  await expect(page.getByRole('progressbar', { name: 'Print progress' })).toBeVisible()
  await expect(page.getByText(/(Sending|Printing) label \d of 2/)).toBeVisible()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: '2 labels printed' })).toBeVisible({ timeout: 20_000 })
  await expect(printButton(page)).toBeEnabled()
})

test('Bluetooth over stubbed Web Serial: waking retry, 24 mm, print ends with 0x1A', async ({ page }) => {
  await stubSerial(page, { openFailures: 1 })
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
  await recordStates(page)
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  const states = await page.evaluate(() => (window as unknown as { __states: string[] }).__states)
  expect(states).toContain('waking')
  expect(states.at(-1)).toBe('ready')
  expect(await page.evaluate(() => (window as unknown as SerialStubWindow).__ptouchOpenAttempts)).toBe(2)

  await printButton(page).click()
  await expect(page.getByRole('progressbar', { name: 'Print progress' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: 'Label printed' })).toBeVisible({ timeout: 20_000 })
  const writes = await page.evaluate(() => (window as unknown as SerialStubWindow).__ptouchWrites)
  const last = writes.flat().at(-1)
  expect(last).toBe(0x1a)
})

test('tape mismatch blocks printing until the one-click switch', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Text', { exact: true }).fill('Mismatch')
  await page.getByRole('radio', { name: '12' }).click() // an edit → doc is no longer pristine
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/24 mm/)
  await expect(page.getByText(/designed for 12 mm tape, but the printer has 24 mm loaded/)).toBeVisible()
  await expect(printButton(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Use loaded 24 mm tape' }).click()
  await expect(printButton(page)).toBeEnabled()
})

test('cancel stops a running print and the printer stays usable', async ({ page }) => {
  await stubSerial(page, { openFailures: 0, printMs: 4000 })
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
  await chip(page).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await page.getByRole('button', { name: 'More copies' }).click()
  await page.getByRole('button', { name: 'More copies' }).click()
  await printButton(page).click()
  await expect(page.getByText(/Printing label 1 of 3/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('log', { name: 'Notifications' }).filter({ hasText: 'Printing cancelled' })).toBeVisible({ timeout: 20_000 })
  await expect(printButton(page)).toBeEnabled({ timeout: 10_000 })
})
