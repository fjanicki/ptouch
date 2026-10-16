// P-web (docs/SETTINGS-PLAN.md §4) — "Printer settings" against the virtual printer (wasm
// VirtualPrinter behind MockTransport): opened from the connect dialog, read on open (30 min),
// choosing a duration only stages it (Apply asks), a change needs confirmation (Cancel keeps the
// value, Change writes + reads back → "Saved and verified"), focus comes back after each action,
// the toggle, the PT-P710BT timer rows named by power source with the information report's
// names underneath (PROTOCOL.md §8 #34), the Diagnostics card, hidden for a model without settings, a read-back that differs (Try again asks
// again), a write whose read-back gets no answer ("may have stored"), no settings while a print
// is being prepared, a printer that doesn't answer (stubbed Bluetooth: error + "Bluetooth:
// untested"), and the layout at 375 px.
// SETTINGS_SCREENS=<dir> also saves the desktop / phone screenshots there.
import { expect, test, type Page } from '@playwright/test'
import { stubSerial } from './fixtures/serial-stub'
import { stubVirtualSerial, type VirtualSerialWindow } from './fixtures/virtual-serial'

const chip = (page: Page) => page.getByRole('button', { name: /^Connection:/ })
const connectDialog = (page: Page) => page.getByRole('dialog', { name: /Connect your printer|Printer connected|Printer settings/ })
const settingsList = (page: Page) => page.getByRole('list', { name: 'Printer settings' })
// Every model's timer rows are named by the power source.
const powerOff = (page: Page) => settingsList(page).getByRole('combobox', { name: 'Auto power off: on external power' })
const battery = (page: Page) => settingsList(page).getByRole('combobox', { name: 'Auto power off: on battery' })
const powerOn = (page: Page) => settingsList(page).getByRole('switch', { name: 'Auto power on' })
const apply = (page: Page) => settingsList(page).getByRole('button', { name: /^Apply / })
const confirm = (page: Page) => page.getByRole('alertdialog')
const screens = process.env.SETTINGS_SCREENS

async function ready(page: Page): Promise<void> {
  await page.goto('./')
  await expect(page.getByRole('region', { name: 'Label preview' })).toHaveAttribute('data-ready', 'true')
}

/** Design for `model`, connect the virtual printer (of that model) and keep the dialog open. */
async function connectVirtual(page: Page, model = 'PT-P710BT'): Promise<void> {
  await ready(page)
  if (model !== 'PT-P710BT') await page.getByRole('region', { name: 'Tape and length' }).getByLabel('Printer model').selectOption(model)
  await chip(page).click()
  await connectDialog(page).getByRole('button', { name: /^No printer/ }).click()
  await expect(chip(page)).toHaveAccessibleName(new RegExp(model))
  // The dialog closes itself after a successful connect; open it again.
  await expect(connectDialog(page)).toBeHidden()
  await chip(page).click()
  await expect(page.getByRole('dialog', { name: 'Printer connected' })).toBeVisible()
}

async function openSettings(page: Page): Promise<void> {
  await connectDialog(page).getByRole('button', { name: 'Printer settings…' }).click()
  await expect(page.getByRole('dialog', { name: 'Printer settings' })).toBeVisible()
}

test('read on open, confirm a change, saved and verified', async ({ page }) => {
  await connectVirtual(page)
  await openSettings(page)
  await expect(page.getByRole('button', { name: 'Back' })).toBeFocused()
  await expect(powerOff(page)).toBeEnabled()
  await expect(powerOff(page)).toHaveValue('3')
  await expect(powerOff(page).locator('option:checked')).toHaveText('30 min')
  await expect(battery(page).locator('option:checked')).toHaveText('30 min')
  await expect(powerOn(page)).toHaveAttribute('aria-checked', 'false')
  // PT-P710BT timers: the printer's information report names, never Brother's Printer Setting
  // Tool labels (reversed on this model, PROTOCOL.md §8 #34).
  await expect(page.getByText('Shown as “AutoPowerOff(adp)” in the printer’s information report.', { exact: false })).toBeVisible()
  await expect(page.getByText('Shown as “AutoPowerOff(Bat)” in the printer’s information report.', { exact: false })).toBeVisible()
  await expect(page.getByText('Same as “Auto Power On” in Brother’s Printer Setting Tool.', { exact: false })).toBeVisible()
  await expect(settingsList(page).getByText(/Same as “Auto Power Off/)).toHaveCount(0)
  await expect(page.getByText(/^Virtual printer: the values are simulated/)).toBeVisible()
  await expect(page.getByText(/timers swapped|which timer/)).toHaveCount(0)

  // Choosing a value only stages it (arrow keys change a closed select at once on
  // Windows/Linux/ChromeOS): nothing is asked until Apply.
  await powerOff(page).selectOption({ label: '10 min' })
  await expect(confirm(page)).toBeHidden()
  await expect(apply(page)).toHaveAccessibleName('Apply auto power off (external power)')
  // Back to the stored value: nothing to apply.
  await powerOff(page).selectOption({ label: '30 min' })
  await expect(apply(page)).toHaveCount(0)

  // Cancel keeps the stored value; focus returns to the select.
  await powerOff(page).selectOption({ label: '10 min' })
  await apply(page).click()
  await expect(confirm(page)).toBeVisible()
  await expect(confirm(page)).toHaveAccessibleName('Change auto power off (external power) from 30 min to 10 min?')
  await expect(confirm(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toBeHidden()
  await expect(powerOff(page).locator('option:checked')).toHaveText('30 min')
  await expect(apply(page)).toHaveCount(0)
  await expect(powerOff(page)).toBeFocused()
  await expect(page.getByText(/Saved and verified/)).toHaveCount(0)

  // Change (keyboard) writes, reads back and says so; focus comes back to the select.
  await powerOff(page).selectOption({ label: '10 min' })
  await apply(page).focus()
  await page.keyboard.press('Enter')
  await expect(confirm(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(confirm(page).getByRole('button', { name: 'Change' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Saved and verified: auto power off (external power) is 10 min.')).toBeVisible()
  await expect(powerOff(page).locator('option:checked')).toHaveText('10 min')
  await expect(powerOff(page)).toBeFocused()
  // The other timer is untouched; a fresh read agrees, and focus stays on "Read again".
  const readAgain = page.getByRole('button', { name: 'Read again' })
  await readAgain.focus()
  await page.keyboard.press('Enter')
  await expect(readAgain).toBeEnabled()
  await expect(readAgain).toBeFocused()
  await expect(powerOff(page).locator('option:checked')).toHaveText('10 min')
  await expect(battery(page).locator('option:checked')).toHaveText('30 min')

  if (screens) await page.screenshot({ path: `${screens}/settings-desktop.png` })

  // Escape in the confirmation only closes the confirmation.
  await powerOn(page).click()
  await expect(confirm(page)).toHaveAccessibleName('Change auto power on from off to on?')
  await page.keyboard.press('Escape')
  await expect(confirm(page)).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Printer settings' })).toBeVisible()
  await expect(powerOn(page)).toHaveAttribute('aria-checked', 'false')
  await expect(powerOn(page)).toBeFocused()

  // The switch.
  await powerOn(page).click()
  await confirm(page).getByRole('button', { name: 'Change' }).click()
  await expect(page.getByText('Saved and verified: auto power on is on.')).toBeVisible()
  await expect(powerOn(page)).toHaveAttribute('aria-checked', 'true')
  await expect(powerOn(page)).toBeFocused()

  // Back to the connected printer; the chip is ready again and printing is possible.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('dialog', { name: 'Printer connected' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Printer settings…' })).toBeFocused()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
})

// Regression: on Windows/Linux/ChromeOS Chrome and Firefox an arrow key on a closed select
// changes its value and fires `change` at once; that must not open the confirmation.
test('arrow keys on a timer select do not ask', async ({ page }) => {
  await connectVirtual(page)
  await openSettings(page)
  await expect(powerOff(page)).toBeEnabled()
  await powerOff(page).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(confirm(page)).toBeHidden()
  if (process.platform !== 'darwin') {
    // Linux Chromium (CI): two steps from 30 min, still nothing asked.
    await expect(powerOff(page).locator('option:checked')).toHaveText('50 min')
    await expect(apply(page)).toBeVisible()
    await apply(page).click()
    await expect(confirm(page)).toHaveAccessibleName('Change auto power off (external power) from 30 min to 50 min?')
  }
})

test('other profile: PT-P900W lists hours', async ({ page }) => {
  await connectVirtual(page, 'PT-P900W')
  await openSettings(page)
  await expect(page.getByRole('dialog', { name: 'Printer settings' })).toContainText('PT-P900W')
  await expect(powerOff(page)).toBeEnabled()
  await expect(settingsList(page).getByRole('combobox', { name: 'Auto power off: on external power' })).toBeVisible()
  await expect(settingsList(page).getByRole('combobox', { name: 'Auto power off: on battery' })).toBeVisible()
  await expect(page.getByText('Same as “Auto Power Off (AC/DC)” in Brother’s Printer Setting Tool.', { exact: false })).toBeVisible()
  await expect(powerOff(page).locator('option')).toHaveText(['Never', '10 min', '20 min', '30 min', '40 min', '50 min', '1 h', '2 h', '4 h', '8 h', '12 h'])
  await powerOff(page).selectOption({ label: '2 h' })
  await apply(page).click()
  await confirm(page).getByRole('button', { name: 'Change' }).click()
  await expect(page.getByText('Saved and verified: auto power off (external power) is 2 h.')).toBeVisible()
})

test('hidden for a model without settings (PT-E560BT)', async ({ page }) => {
  await connectVirtual(page, 'PT-E560BT')
  await expect(page.getByRole('button', { name: 'Printer settings…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^diagnostics$/i }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Printer settings' })).toHaveCount(0)
})

test('Diagnostics card and the report', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await connectVirtual(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^diagnostics$/i }).click()
  const card = page.getByRole('region', { name: 'Printer settings' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('combobox', { name: 'Auto power off: on battery' })).toBeEnabled()
  await expect(card.getByRole('combobox', { name: 'Auto power off: on battery' }).locator('option:checked')).toHaveText('30 min')
  await page.getByRole('button', { name: 'Copy diagnostics' }).click()
  const report = await page.evaluate(() => navigator.clipboard.readText())
  expect(report).toContain('## Printer settings (last read)')
  expect(report).toMatch(/auto-power-off-battery:\s+30 min/)
})

test('a printer that doesn’t answer (stubbed Bluetooth): error, then usable', async ({ page }) => {
  await stubSerial(page, { openFailures: 0 })
  await ready(page)
  await chip(page).click()
  await connectDialog(page).getByRole('button', { name: /^Bluetooth/ }).click()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  await expect(connectDialog(page)).toBeHidden()
  await chip(page).click()
  await openSettings(page)
  await expect(page.getByText(/^Bluetooth: untested/)).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'The printer didn’t answer the settings request' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Read again' })).toBeEnabled()
  await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
  // No problem banner: the connection itself is fine.
  await expect(page.locator('[data-problem]')).toHaveCount(0)
})

test.describe('wasm virtual printer over (stubbed) Bluetooth', () => {
  test.use({ serviceWorkers: 'block' })

  async function connectBluetooth(page: Page): Promise<void> {
    await ready(page)
    await chip(page).click()
    await connectDialog(page).getByRole('button', { name: /^Bluetooth/ }).click()
    await expect(chip(page)).toHaveAccessibleName(/PT-P710BT · 24 mm/)
    await expect(connectDialog(page)).toBeHidden()
    await chip(page).click()
    await openSettings(page)
    await expect(powerOff(page)).toBeEnabled()
    await expect(powerOff(page).locator('option:checked')).toHaveText('30 min')
  }

  const setsSent = (page: Page) =>
    page.evaluate(() => (window as unknown as VirtualSerialWindow).__vsWrites.filter((b) => b.length >= 6 && b[0] === 0x1b && b[1] === 0x69 && b[2] === 0x55 && b[4] === 0x00).length)

  test('a read-back that differs: "still reports", Try again asks again', async ({ page }) => {
    await stubVirtualSerial(page, { openFailures: 0, behaviour: { kind: 'settings-writes-ignored' } })
    await connectBluetooth(page)
    await powerOff(page).selectOption({ label: '10 min' })
    await apply(page).click()
    await confirm(page).getByRole('button', { name: 'Change' }).click()
    const warn = page.getByRole('status').filter({ hasText: 'The printer still reports 30 min.' })
    await expect(warn).toBeVisible()
    await expect(page.getByText(/Saved and verified/)).toHaveCount(0)
    await expect(powerOff(page).locator('option:checked')).toHaveText('30 min')
    await expect(powerOff(page)).toBeFocused()
    expect(await setsSent(page)).toBe(1)

    // Try again is a new change: it asks again; Cancel sends nothing.
    await warn.getByRole('button', { name: 'Try again' }).click()
    await expect(confirm(page)).toHaveAccessibleName('Change auto power off (external power) from 30 min to 10 min?')
    await confirm(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm(page)).toBeHidden()
    expect(await setsSent(page)).toBe(1)
    // Confirmed, it writes once more (and the printer still ignores it).
    await warn.getByRole('button', { name: 'Try again' }).click()
    await confirm(page).getByRole('button', { name: 'Change' }).click()
    await expect(warn).toBeVisible()
    await expect.poll(() => setsSent(page)).toBe(2)
  })

  test('a write whose read-back gets no answer: "may have stored", Read again shows it', async ({ page }) => {
    await stubVirtualSerial(page, { openFailures: 0, muteAfterSetMs: 2_500 })
    await connectBluetooth(page)
    await powerOff(page).selectOption({ label: '10 min' })
    await apply(page).click()
    await confirm(page).getByRole('button', { name: 'Change' }).click()
    const alert = page.getByRole('alert').filter({ hasText: 'The printer didn’t answer the settings request' })
    await expect(alert).toBeVisible({ timeout: 10_000 })
    await expect(alert).toContainText('The printer may have stored the new value. Read again.')
    await expect(page.getByText(/Saved and verified/)).toHaveCount(0)
    // Once the printer answers again, a read shows what it stored.
    await page.waitForTimeout(2_500)
    await page.getByRole('button', { name: 'Read again' }).click()
    await expect(alert).toHaveCount(0)
    await expect(powerOff(page)).toBeEnabled()
    await expect(powerOff(page).locator('option:checked')).toHaveText('10 min')
  })
})

test('no settings while a print is being prepared', async ({ page }) => {
  test.setTimeout(120_000)
  await ready(page)
  await page.getByLabel('Text', { exact: true }).fill('{{n}}')
  const toggle = page.getByRole('button', { name: /Variables & batch/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  // A fresh page has no table yet: the paste box is shown (it may still be opening).
  const box = page.getByLabel('Paste from a spreadsheet or CSV (first row = column names)')
  await expect(box).toBeVisible()
  await box.fill(['n', ...Array.from({ length: 300 }, (_, i) => `Label ${i + 1}`)].join('\n'))
  await page.getByRole('button', { name: 'Use pasted data' }).click()
  await chip(page).click()
  await connectDialog(page).getByRole('button', { name: /^No printer/ }).click()
  await expect(connectDialog(page)).toBeHidden()
  const print = page.getByRole('button', { name: /^Print \d+ labels$/ })
  await expect(print).toBeEnabled({ timeout: 15_000 })
  await print.click()
  await expect(page.getByText(/^Preparing label \d+ of 300…$/)).toBeVisible()
  // The print asked for first comes first: no settings transaction can start meanwhile.
  await chip(page).click()
  await expect(page.getByRole('button', { name: 'Printer settings…' })).toBeDisabled()
})

test.describe('phone width (375 px)', () => {
  test.use({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

  test('fits without horizontal scroll; controls are reachable', async ({ page }) => {
    await connectVirtual(page)
    await openSettings(page)
    await expect(powerOff(page)).toBeEnabled()
    const dialog = page.getByRole('dialog', { name: 'Printer settings' })
    const overflow = await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    for (const control of [powerOn(page), powerOff(page), battery(page)]) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    await battery(page).selectOption({ label: 'Never' })
    const abox = await apply(page).boundingBox()
    expect(abox!.x + abox!.width).toBeLessThanOrEqual(375)
    expect(abox!.height).toBeGreaterThanOrEqual(44)
    await apply(page).click()
    await expect(confirm(page)).toBeVisible()
    const cbox = await confirm(page).boundingBox()
    expect(cbox!.x + cbox!.width).toBeLessThanOrEqual(375)
    await confirm(page).getByRole('button', { name: 'Change' }).click()
    await expect(page.getByText('Saved and verified: auto power off (battery) is never.')).toBeVisible()
    // The other rows keep the values read on open.
    await expect(powerOff(page).locator('option:checked')).toHaveText('30 min')
    await expect(powerOn(page)).toHaveAttribute('aria-checked', 'false')
    await expect(settingsList(page)).toContainText('Off')
    if (screens) await page.screenshot({ path: `${screens}/settings-iphone.png` })
  })
})
