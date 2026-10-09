// P3 — code blocks in the studio: the Wi-Fi QR builder (insert, fill, show/hide the password,
// the network-name label), share links without the password unless the user includes it
// (SecretsDialog), DataMatrix copy, and the quiet-zone and automatic module size readouts.
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const blocks = (page: Page) => page.getByRole('region', { name: 'Blocks' }).getByRole('listitem')
const group = (page: Page, name: string) => page.getByRole('radiogroup', { name })

async function ready(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  await expect(preview(page).getByText('Updating')).toHaveCount(0)
}

/** The label JSON inside a share link. */
function decodeLink(url: string): string {
  const payload = url.split('#d=')[1] ?? ''
  return inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8')
}

async function insertWifi(page: Page, ssid: string, password: string): Promise<void> {
  await page.getByRole('button', { name: 'Insert Wi-Fi QR' }).click()
  await expect(page.getByRole('heading', { name: /Code block/ })).toBeVisible()
  await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill(ssid)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await ready(page)
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await ready(page)
})

test('insert a Wi-Fi QR, fill it, show and hide the password, add the network name label', async ({ page }) => {
  await page.getByRole('button', { name: 'Insert Wi-Fi QR' }).click()
  await expect(group(page, 'What to encode').getByRole('radio', { name: 'Wi-Fi network' })).toHaveAttribute('aria-checked', 'true')
  // Incomplete: the editor says what is missing (and printing is blocked meanwhile).
  await expect(page.locator('p.hint', { hasText: 'Enter the network name (SSID).' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill('Guest')
  const pw = page.getByLabel('Password', { exact: true })
  await pw.fill('correct horse')
  await expect(pw).toHaveAttribute('type', 'password')
  const toggle = page.getByRole('button', { name: 'Show password' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(pw).toHaveAttribute('type', 'text')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(pw).toHaveAttribute('type', 'password')
  await expect(page.getByText('iPhone and Android cameras offer to join this network.')).toBeVisible()
  await expect(page.getByText('The password stays on this device.', { exact: false })).toBeVisible()

  // The block list shows the network name, never the password.
  await expect(blocks(page).nth(1)).toContainText('Guest')
  await expect(page.getByRole('region', { name: 'Blocks' })).not.toContainText('correct horse')

  // Physical size and readability readout (24 mm tape, automatic module size).
  await ready(page)
  await expect(page.getByText(/^\d+ dots per module · [\d.]+ × [\d.]+ mm \(\d+ × \d+ modules\)\.$/)).toBeVisible()
  await expect(page.getByText('Readability: good.')).toBeVisible()

  // Short WPA passwords only warn.
  await pw.fill('short')
  await expect(page.locator('p.hint.warn', { hasText: '8 to 63 characters' })).toBeVisible()

  await page.getByRole('button', { name: 'Add network name label' }).click()
  await expect(blocks(page)).toHaveCount(3)
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('{{ssid}}')
})

test('share links leave the Wi-Fi password out unless the user includes it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await insertWifi(page, 'Guest', 'correct horse')
  const share = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Labels' }).click()
    await page.getByRole('menuitem', { name: 'Copy share link' }).click()
  }
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  const dialog = page.getByRole('dialog', { name: 'Share without the Wi-Fi password?' })

  // Cancel shares nothing.
  await page.evaluate(() => navigator.clipboard.writeText('untouched'))
  await share()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(await clipboard()).toBe('untouched')

  // Default: the box is unticked and the password is left out, with a notice.
  await share()
  const include = dialog.getByRole('checkbox', { name: 'Include Wi-Fi password' })
  await expect(include).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Continue without password' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('The Wi-Fi password was left out.')).toBeVisible()
  await expect.poll(clipboard).toContain('#d=')
  const without = decodeLink(await clipboard())
  expect(without).toContain('"ssid":"Guest"')
  expect(without).not.toContain('correct horse')

  // Opt in: a warning, then the password is in the link. The choice is not remembered.
  await share()
  await include.check()
  await expect(dialog.getByRole('alert')).toHaveText('Anyone with the link can read the password and join your network.')
  await dialog.getByRole('button', { name: 'Continue with password' }).click()
  await expect.poll(async () => decodeLink(await clipboard())).toContain('correct horse')
  await share()
  await expect(include).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('quiet-zone modes and automatic size: compact makes a QR bigger on 12 mm tape', async ({ page }) => {
  await page.getByRole('radio', { name: '12' }).click()
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await page.getByLabel('Content').fill('HELLO') // 21 × 21 modules
  await ready(page)
  const quiet = group(page, 'Quiet zone')
  await expect(quiet.getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/^2 dots per module · 5\.9 × 5\.9 mm/)).toBeVisible()
  await expect(page.getByText('Readability: OK.')).toBeVisible()

  await quiet.getByRole('radio', { name: 'Compact' }).click()
  await ready(page)
  await expect(page.getByText(/^3 dots per module · 8\.9 × 8\.9 mm/)).toBeVisible()
  await expect(page.getByText('Readability: good.')).toBeVisible()
  await expect(page.getByText(/may fill the tape height/)).toBeVisible()

  await quiet.getByRole('radio', { name: 'None' }).click()
  await expect(page.getByText(/^No blank margin/)).toBeVisible()
  await quiet.getByRole('radio', { name: 'Compact' }).click()

  // A fixed size larger than the tape allows is reported and printed at the maximum.
  const size = group(page, 'Module size')
  await size.getByRole('radio', { name: 'Fixed' }).click()
  const dots = page.getByLabel('Dots per module')
  await expect(dots).toHaveValue('3')
  await dots.fill('5')
  await expect(page.getByText('Only 3 fit this tape, so it prints at 3.')).toBeVisible()
  await size.getByRole('radio', { name: 'Auto' }).click()
  await expect(dots).toHaveCount(0)
  await expect(page.getByText('The largest size that fits the tape.')).toBeVisible()
})

test('DataMatrix: scanner-app copy, module readout, no Wi-Fi option', async ({ page }) => {
  await page.getByRole('button', { name: 'Insert QR code' }).click()
  await expect(page.getByText('QR: best for phone cameras (the iPhone Camera app reads it).')).toBeVisible()
  await page.getByRole('radio', { name: 'DataMatrix' }).click()
  await expect(page.getByText(/^DataMatrix: smaller, but needs a scanner app\./)).toBeVisible()
  await expect(group(page, 'What to encode')).toHaveCount(0)
  await page.getByLabel('Content').fill('A-0001')
  await ready(page)
  await expect(page.getByText(/dots per module · [\d.]+ × [\d.]+ mm \(12 × 12 modules\)/)).toBeVisible()
  await expect(page.getByText('1 module of blank space all round (the DataMatrix standard).')).toBeVisible()
  await expect(preview(page).getByRole('alert')).toHaveCount(0)
})

test('the code editor fits a 360 px phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('button', { name: 'Insert Wi-Fi QR' }).click()
  await expect(page.getByRole('textbox', { name: 'Network name (SSID)' })).toBeVisible()
  for (const name of ['QR', 'DataMatrix', 'Code 128', 'EAN-13']) await expect(group(page, 'Code type').getByRole('radio', { name })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
