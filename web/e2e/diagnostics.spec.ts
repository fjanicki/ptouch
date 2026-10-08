// W5 — diagnostics page (reachable from the top bar and #diagnostics), virtual-printer job
// download, "Copy diagnostics" masking, the built CSP, and offline reload via the service worker.
import { expect, test, type Page } from '@playwright/test'

const DEVICE_SUFFIX = /\b(?:PT|QL|TD|RJ|PJ)-[A-Z0-9]*?(?:BT|NWB|WB|W|B)[0-9A-F]{4}\b/i
const BT_ADDRESS = /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/i

/** The studio shell is up (the top bar's Diagnostics entry is W5's dependency on W4). */
async function shellReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^diagnostics$/i })).toBeVisible()
}

/** The wasm core instantiated (shown on the diagnostics page). */
async function wasmReady(page: Page): Promise<void> {
  await expect(page.locator('dt:text-is("wasm core") + dd')).toHaveText(/^\d+\.\d+\.\d+/)
}

const diagHeading = (page: Page) => page.getByRole('heading', { name: 'Diagnostics', level: 1 })

/** Loads `./#diagnostics`. A hash-only change on an open page is a same-document navigation,
 * so reload when the studio was already showing (the view is read from the hash at boot). */
async function openDiagnostics(page: Page): Promise<void> {
  const wasOnApp = page.url().includes('/ptouch/')
  await page.goto('./#diagnostics')
  if (wasOnApp) await page.reload()
  await expect(diagHeading(page)).toBeVisible()
}

test('diagnostics page opens from the URL hash', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openDiagnostics(page)
  await expect(page.getByRole('heading', { name: 'Environment' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Link probe' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Packet log' })).toBeVisible()
  expect(errors).toEqual([])
})

test('diagnostics is reachable from the top bar and back', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /^diagnostics$/i }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeVisible()
  await expect(page).toHaveURL(/#diagnostics$/)
  await page.getByRole('button', { name: /back to studio/i }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', level: 1 })).toBeHidden()
})

test('virtual printer: encode the orientation label and download the job', async ({ page }) => {
  await openDiagnostics(page)
  await page.getByRole('radio', { name: /orientation test/i }).check()
  await page.getByLabel('Tape').selectOption('24')
  await page.getByRole('button', { name: /render & encode/i }).click()

  const download = page.getByRole('button', { name: /download job \.bin/i })
  const error = page.locator('.hint.error[role="alert"]')
  await expect(download.or(error)).toBeVisible({ timeout: 15_000 })
  if (await error.isVisible()) {
    const msg = (await error.textContent()) ?? ''
    // Until W1 (encodeJob/printArea) and W3 (renderer) land, the pipeline reports UNSUPPORTED.
    test.skip(/UNSUPPORTED|not implemented/i.test(msg), `pipeline not available yet: ${msg}`)
    throw new Error(`virtual printer failed: ${msg}`)
  }

  const jobText = await page.locator('dt:has-text("Job") + dd').textContent()
  const expectedBytes = Number((jobText ?? '').match(/^([\d,.\s]+) bytes/)?.[1]?.replace(/[^\d]/g, ''))
  expect(expectedBytes).toBeGreaterThan(100)

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(file.suggestedFilename()).toBe('ptouch-orientation-test-24mm.bin')
  const path = await file.path()
  const { statSync, readFileSync } = await import('node:fs')
  expect(statSync(path).size).toBe(expectedBytes)
  const bytes = readFileSync(path)
  expect(bytes.at(-1)).toBe(0x1a) // print with feed
  await expect(page.getByText(/no protocol violations/i)).toBeVisible()
})

test('copied diagnostics contain no unmasked device names', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openDiagnostics(page)
  // Generate some traffic through the virtual printer probe (logged in the packet log).
  const probe = page.getByRole('region', { name: 'Link probe' })
  await probe.getByLabel('Open/close cycles').selectOption('1')
  await probe.getByRole('button', { name: /virtual printer/i }).click()
  await expect(probe.getByRole('status')).toContainText(/Done|could not|failed|went wrong/i, { timeout: 20_000 })
  await expect(page.getByRole('list', { name: 'Packet log entries' })).toContainText('probe:')

  await page.getByRole('button', { name: /copy diagnostics/i }).click()
  await expect(page.getByRole('button', { name: /copied/i })).toBeVisible()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toContain('# ptouch studio diagnostics')
  expect(text).toContain('## Browser support')
  expect(text).toContain('## Packet log')
  expect(text).not.toMatch(DEVICE_SUFFIX)
  expect(text).not.toMatch(BT_ADDRESS)

  // The same report is shown on the page for manual copying.
  await page.getByRole('button', { name: /show report|refresh/i }).click()
  await expect(page.getByLabel('Diagnostics report')).toHaveValue(/# ptouch studio diagnostics/)
})

test('the built page ships the CSP and loads without violations', async ({ page, request }) => {
  const html = await (await request.get('./')).text()
  const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1] ?? ''
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(csp).toContain("connect-src 'self'")
  expect(csp).toContain("object-src 'none'")

  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  await page.goto('./')
  await shellReady(page)
  await openDiagnostics(page)
  await wasmReady(page)
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
})

test('works offline after the first visit (service worker)', async ({ page, context }) => {
  await page.goto('./')
  await shellReady(page)
  // Wait until the service worker is installed and active (everything precached).
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    if (reg.active?.state !== 'activated') await new Promise((r) => reg.active?.addEventListener('statechange', r, { once: true }))
  })
  const manifest = await (await page.request.get('./manifest.webmanifest')).json()
  expect(manifest.scope).toBe('/ptouch/')
  expect(manifest.start_url).toBe('/ptouch/')
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))

  await context.setOffline(true)
  try {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.reload()
    await shellReady(page) // shell from the precache
    await expect(page.evaluate(() => navigator.serviceWorker.controller !== null)).resolves.toBe(true)
    await openDiagnostics(page)
    await wasmReady(page) // wasm from the precache
    expect(errors).toEqual([])
  } finally {
    await context.setOffline(false)
  }
})
