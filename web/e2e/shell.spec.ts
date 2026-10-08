// Shell smoke tests (W4): the production build loads under /ptouch/, wasm instantiates, the
// studio renders a preview; unsupported browsers get the friendly screen; theme toggle; the
// layout fits a phone without horizontal scrolling.
import { expect, test, type Page } from '@playwright/test'
import { removeDeviceApis } from './fixtures/serial-stub'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })

test('shell renders under the Pages base path', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('./')
  await expect(page).toHaveTitle(/ptouch studio/)
  await expect(page.getByRole('button', { name: /^Connection: Connect printer/ })).toBeVisible()
  await expect(preview(page)).toHaveAttribute('data-ready', 'true') // wasm loaded + first render
  await expect(page.getByRole('navigation', { name: 'Insert block' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print label' })).toBeDisabled()
  await expect(page.getByText('Connect a printer to print.')).toBeVisible()
  expect(errors).toEqual([])
})

test('browsers without Web Serial/WebUSB get the unsupported screen', async ({ page }) => {
  await removeDeviceApis(page)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: /can’t talk to label printers/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Get Chrome/ })).toBeVisible()
  await page.getByRole('button', { name: /design labels anyway/i }).click()
  await expect(page.getByRole('navigation', { name: /insert block/i })).toBeVisible()
  await expect(page.getByText(/Design mode: this browser can’t connect to printers/)).toBeVisible()
})

test('theme toggle cycles system → light → dark and persists', async ({ page }) => {
  await page.goto('./')
  const toggle = page.getByRole('button', { name: /theme \(click to change\)/ })
  await expect(toggle).toHaveAccessibleName(/System theme/)
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('phone layout: preview first, no horizontal scroll, print reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 })
  await page.goto('./')
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(page.getByRole('button', { name: 'Print label' })).toBeInViewport()
  const previewTop = (await preview(page).boundingBox())?.y ?? Infinity
  const mediaTop = (await page.getByRole('region', { name: 'Tape and length' }).boundingBox())?.y ?? 0
  expect(previewTop).toBeLessThan(mediaTop)
})
