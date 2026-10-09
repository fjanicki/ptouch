// P-picker (docs/FONTS-AND-SIZE-PLAN.md §3.2) — the font picker: keyboard only (open, search,
// ↓, Enter, focus back on the trigger), favourites kept after a reload (pointer star and the f
// key), recent fonts in order, "Use for new text", uploaded fonts under "Your fonts", the
// spinner while a font loads, and the 375 px bottom sheet (no horizontal scroll, 44 px targets,
// Escape and a tap on the scrim close it).
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { makeTestFont } from '../tests/unit/persist/font-fixture'
import { removeDeviceApis } from './fixtures/serial-stub'

const preview = (page: Page) => page.getByRole('region', { name: 'Label preview' })
const trigger = (page: Page) => page.getByRole('button', { name: 'Font', exact: true })
const picker = (page: Page) => page.getByRole('dialog', { name: 'Choose a font' })
const search = (page: Page) => picker(page).getByRole('combobox', { name: 'Search fonts' })
const group = (page: Page, name: string) => picker(page).getByRole('group', { name, exact: true })

async function ready(page: Page): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-ready', 'true')
}

async function open(page: Page): Promise<void> {
  await trigger(page).click()
  await expect(picker(page)).toBeVisible()
}

/** Option names of a group, without the ", favourite" suffix. */
async function names(list: Locator): Promise<string[]> {
  return (await list.getByRole('option').locator('.name').allTextContents()).map((t) => t.replace(/, favourite$/, '').trim())
}

/** The option the search field / listbox points at with aria-activedescendant. */
async function activeOption(page: Page, owner: Locator): Promise<Locator> {
  const id = await owner.getAttribute('aria-activedescendant')
  expect(id).toBeTruthy()
  return page.locator(`[id="${id}"]`)
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./')
    await ready(page)
  })

  test('the trigger is the “Font” button and shows the current font', async ({ page }) => {
    await expect(trigger(page)).toHaveText('Fira Sans')
    await expect(trigger(page)).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  })

  test('keyboard only: open, search “mono”, ↓, Enter applies JetBrains Mono and focus returns', async ({ page }) => {
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    await expect(picker(page)).toBeVisible()
    await expect(search(page)).toBeFocused()
    await expect(search(page)).toHaveAttribute('aria-controls', /.+/)
    // Opening points at the current font.
    await expect(await activeOption(page, search(page))).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.type('mono')
    await expect(group(page, 'Search results')).toBeVisible()
    await expect(search(page)).not.toHaveAttribute('aria-activedescendant')
    await expect(picker(page).getByRole('status')).toHaveText(/\d+ fonts? match/)
    await page.keyboard.press('ArrowDown')
    await expect(await activeOption(page, search(page))).toContainText('JetBrains Mono')
    await page.keyboard.press('Enter')

    await expect(picker(page)).toBeHidden()
    await expect(trigger(page)).toBeFocused()
    await expect(trigger(page)).toHaveText('JetBrains Mono')
    // JetBrains Mono has 400 and 700: the default 600 moves to the nearest (700).
    await expect(page.getByLabel('Weight')).toHaveValue('700')
  })

  test('Escape closes without changing the font; a click outside closes too', async ({ page }) => {
    await open(page)
    await page.keyboard.type('caveat')
    await page.keyboard.press('Escape')
    await expect(picker(page)).toBeHidden()
    await expect(trigger(page)).toBeFocused()
    await expect(trigger(page)).toHaveText('Fira Sans')
    await open(page)
    await page.mouse.click(5, 5)
    await expect(picker(page)).toBeHidden()
  })

  test('favourites: star with the pointer and with f, listed first after a reload', async ({ page }) => {
    await open(page)
    // Pointer: the star in the row (it does not pick the font).
    await picker(page).getByRole('option', { name: 'Archivo Narrow' }).first().locator('.star').click()
    await expect(picker(page)).toBeVisible()
    await expect(trigger(page)).toHaveText('Fira Sans')
    await expect(await names(group(page, 'Favourites'))).toEqual(['Archivo Narrow'])
    await expect(group(page, 'Favourites').getByRole('option')).toHaveAccessibleName(/^Archivo Narrow ?, favourite$/)

    // Keyboard: search, Tab past the chips (one stop) to the listbox, f stars the active row.
    await search(page).fill('atkinson')
    await page.keyboard.press('Tab')
    await expect(picker(page).getByRole('button', { name: 'Sans', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(picker(page).getByRole('button', { name: 'Sans', exact: true })).not.toBeFocused()
    await page.keyboard.press('Tab')
    const list = picker(page).getByRole('listbox', { name: 'Fonts' })
    await expect(list).toBeFocused()
    await expect(await activeOption(page, list)).toContainText('Atkinson Hyperlegible')
    await page.keyboard.press('f')
    await expect(picker(page).getByRole('button', { name: /^Favourite/ })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')

    await page.reload()
    await ready(page)
    await open(page)
    await expect.poll(() => names(group(page, 'Favourites'))).toEqual(['Archivo Narrow', 'Atkinson Hyperlegible'])
    // The footer button un-stars the active row.
    await search(page).fill('archivo')
    await page.keyboard.press('ArrowDown')
    await picker(page).getByRole('button', { name: 'Favourite: Archivo Narrow' }).click()
    await search(page).fill('')
    await expect.poll(() => names(group(page, 'Favourites'))).toEqual(['Atkinson Hyperlegible'])
  })

  test('recent fonts: most recent first, no duplicates', async ({ page }) => {
    for (const name of ['JetBrains Mono', 'Atkinson Hyperlegible', 'JetBrains Mono', 'Archivo Narrow']) {
      await open(page)
      await search(page).fill(name)
      await page.keyboard.press('Enter') // with a search and no active row: the best match
      await expect(trigger(page)).toHaveText(name)
    }
    await open(page)
    await expect(await names(group(page, 'Recent'))).toEqual(['Archivo Narrow', 'JetBrains Mono', 'Atkinson Hyperlegible'])
  })

  test('“Use for new text” sets the font of new text blocks', async ({ page }) => {
    await open(page)
    await picker(page).getByRole('option', { name: 'JetBrains Mono' }).first().click()
    await expect(trigger(page)).toHaveText('JetBrains Mono')
    await open(page)
    const use = picker(page).getByRole('button', { name: 'Use for new text' })
    await expect(use).toHaveAttribute('aria-pressed', 'false')
    await use.click()
    await expect(use).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Insert Text' }).click()
    await expect(trigger(page)).toHaveText('JetBrains Mono')
    await expect(page.getByLabel('Weight')).toHaveValue('700')
  })

  test('chips filter the list by style', async ({ page }) => {
    await open(page)
    const chips = picker(page).getByRole('group', { name: 'Filter by style' })
    const mono = chips.getByRole('button', { name: 'Monospaced' })
    await mono.click()
    await expect(mono).toHaveAttribute('aria-pressed', 'true')
    await expect(group(page, 'Favourites')).toHaveCount(0)
    await expect(group(page, 'Monospaced')).toBeVisible()
    await expect(group(page, 'Sans')).toHaveCount(0)
    await mono.click()
    await expect(group(page, 'Sans')).toBeVisible()
  })

  test('print-quality hints: a script font at XS on 12 mm, a crisp pixel font', async ({ page }) => {
    await page.getByRole('radio', { name: '12' }).click()
    await open(page)
    await search(page).fill('caveat')
    await page.keyboard.press('Enter')
    await expect(trigger(page)).toHaveText('Caveat')
    await page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'Extra small' }).click()
    await ready(page)
    await open(page)
    // The block's own font-quality warning, in words, and a tag on other thin / script rows.
    await expect(picker(page).getByRole('note')).toContainText('try M or larger')
    await search(page).fill('quicksand')
    await expect(picker(page).getByRole('option', { name: /Quicksand/ })).toContainText('Thin at this size')
    await search(page).fill('silkscreen')
    await page.keyboard.press('Enter')
    await expect(trigger(page)).toContainText('Silkscreen')
    // A pixel font drawn at a whole multiple of its grid gets the "Crisp" badge.
    await page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'Fit tape' }).click()
    await expect(trigger(page)).toContainText('Crisp')
  })

  test('↑ keeps the active row visible below the sticky group label', async ({ page }) => {
    await open(page)
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown')
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('ArrowUp')
      const hidden = await page.evaluate((id) => {
        const opt = id ? document.getElementById(id) : null
        const name = opt?.querySelector('.name')
        if (!opt || !name) return 'no active option'
        const r = name.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + 4, r.top + r.height / 2)
        return opt.contains(hit) ? '' : `${name.textContent} is under ${hit?.textContent?.slice(0, 30)}`
      }, await search(page).getAttribute('aria-activedescendant'))
      expect(hidden, `step ${i}`).toBe('')
    }
  })

  test('hovering rows does not change what the footer’s Favourite button stars', async ({ page }) => {
    await open(page)
    const fav = picker(page).getByRole('button', { name: /^Favourite/ })
    await expect(fav).toHaveAccessibleName('Favourite: Fira Sans')
    await expect(fav).toContainText('Fira Sans')
    await picker(page).getByRole('option', { name: 'Oswald' }).first().hover()
    await picker(page).getByRole('option', { name: /Barlow Condensed/ }).first().hover()
    await fav.hover()
    await expect(fav).toHaveAccessibleName('Favourite: Fira Sans')
    await fav.click()
    await expect.poll(() => names(group(page, 'Favourites'))).toEqual(['Fira Sans'])
  })

  test('every style chip is visible in the desktop popover (they wrap, no hidden scroller)', async ({ page }) => {
    await open(page)
    const chips = picker(page).getByRole('group', { name: 'Filter by style' })
    const box = await picker(page).boundingBox()
    for (const name of ['Sans', 'Pixel', 'Stencil', 'Monospaced']) {
      const b = await chips.getByRole('button', { name, exact: true }).boundingBox()
      expect(b, name).not.toBeNull()
      expect(b!.x + b!.width, name).toBeLessThanOrEqual(box!.x + box!.width)
    }
    expect(await chips.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
  })

  test('an uploaded font is listed under “Your fonts” and applies', async ({ page }) => {
    await page.getByRole('button', { name: 'Labels' }).click()
    await page.getByRole('menuitem', { name: 'Fonts…' }).click()
    const fonts = page.getByRole('dialog', { name: 'Fonts' })
    await fonts.getByLabel('Font files').setInputFiles({ name: 'BoxSans.ttf', mimeType: 'font/ttf', buffer: Buffer.from(makeTestFont({ family: 'E2E Picker Sans' })) })
    await expect(fonts.getByText('E2E Picker Sans', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fonts).toBeHidden()

    await open(page)
    await expect(picker(page).getByRole('group', { name: 'Filter by style' }).getByRole('button', { name: 'Your fonts' })).toBeVisible()
    await group(page, 'Your fonts').getByRole('option', { name: 'E2E Picker Sans' }).click()
    await expect(trigger(page)).toHaveText('E2E Picker Sans')
    await expect(page.getByText('From the font file')).toBeVisible()
    // A custom font cannot be the default for new text (it may be missing on another device).
    await open(page)
    await expect(picker(page).getByRole('button', { name: 'Use for new text' })).toHaveCount(0)
    await expect(picker(page).getByRole('option', { selected: true }).first()).toContainText('E2E Picker Sans')
    // Manage fonts… opens the font manager.
    await picker(page).getByRole('button', { name: 'Manage fonts…' }).click()
    await expect(page.getByRole('dialog', { name: 'Fonts' })).toBeVisible()
  })
})

test.describe('loading previews', () => {
  // Font requests must reach page.route (a service worker would answer from its cache).
  test.use({ serviceWorkers: 'block' })

  test('a spinner shows while a font preview loads', async ({ page }) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    await page.route(/\/fonts\/JetBrainsMono-[A-Za-z]+\.woff2$/, async (route) => {
      await gate
      await route.continue()
    })
    await page.goto('./')
    await ready(page)
    await open(page)
    await search(page).fill('jetbrains') // the row scrolls into view: its preview starts loading
    const row = picker(page).getByRole('option', { name: 'JetBrains Mono' }).first()
    await expect(row).toHaveAttribute('data-state', 'loading')
    await expect(row.getByTestId('font-loading')).toBeVisible()
    release()
    await expect(row).toHaveAttribute('data-state', 'ready')
    await expect(row.getByTestId('font-loading')).toHaveCount(0)
  })
})

test.describe('loading previews: only rows that stay in view', () => {
  test.use({ serviceWorkers: 'block' })

  test('a flick through the list does not download every font, and closing stops the queue', async ({ page }) => {
    const requested: string[] = []
    await page.route(/\/fonts\/[A-Za-z0-9_-]+\.woff2$/, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (!/\/fonts\/(FiraSans|ArchivoNarrow|JetBrainsMono|AtkinsonHyperlegible)-/.test(path)) requested.push(path)
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    })
    await page.goto('./')
    await ready(page)
    await open(page)
    const list = picker(page).getByRole('listbox', { name: 'Fonts' })
    for (let i = 0; i < 30; i++) {
      await list.evaluate((el) => (el.scrollTop += 120))
      await page.waitForTimeout(16)
    }
    await page.keyboard.press('Escape')
    await expect(picker(page)).toBeHidden()
    await page.waitForTimeout(2500)
    // At most the rows visible when it opened and where the flick stopped (4 at a time), not 20+.
    expect(new Set(requested).size).toBeLessThanOrEqual(8)
  })
})

test.describe('iPhone (375 px)', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ viewport: { ...viewport, width: 375 }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test.beforeEach(async ({ page }) => {
    await removeDeviceApis(page)
    await page.goto('./')
    await page.getByRole('button', { name: 'Start designing' }).click()
    await ready(page)
  })

  test('bottom sheet: fits the width, 44 px targets, closes with Escape and on the scrim', async ({ page }) => {
    await trigger(page).scrollIntoViewIfNeeded()
    await trigger(page).tap()
    await expect(picker(page)).toBeVisible()
    // The sheet sits on the bottom edge (once it has slid in) and spans the width.
    const edges = async () => {
      const b = await picker(page).boundingBox()
      return b && { left: Math.round(b.x), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) }
    }
    const height = await page.evaluate(() => innerHeight)
    await expect.poll(edges).toEqual({ left: 0, right: 375, bottom: height })
    // The list opens focused (no on-screen keyboard over the sheet).
    await expect(picker(page).getByRole('listbox', { name: 'Fonts' })).toBeFocused()

    const overflow = await page.evaluate(() => {
      const d = document.querySelector('dialog[open]') as HTMLElement
      return { page: document.documentElement.scrollWidth - innerWidth, sheet: d.scrollWidth - d.clientWidth }
    })
    expect(overflow).toEqual({ page: 0, sheet: 0 })

    const targets = [
      ...(await picker(page).getByRole('option').all()).slice(0, 4),
      ...(await picker(page).locator('.star').all()).slice(0, 4),
      ...(await picker(page).getByRole('button').all()),
    ]
    for (const t of targets) {
      if (!(await t.isVisible())) continue
      const b = await t.boundingBox()
      expect(b?.height ?? 0, await t.evaluate((el) => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44)
    }
    for (const star of (await picker(page).locator('.star').all()).slice(0, 4)) {
      expect((await star.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
    }

    // Picking by tap applies and closes.
    await picker(page).getByRole('option', { name: 'Atkinson Hyperlegible' }).first().tap()
    await expect(picker(page)).toBeHidden()
    await expect(trigger(page)).toHaveText('Atkinson Hyperlegible')

    await trigger(page).tap()
    await expect(picker(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker(page)).toBeHidden()

    await trigger(page).tap()
    await expect(picker(page)).toBeVisible()
    await page.touchscreen.tap(187, 20) // the scrim above the sheet
    await expect(picker(page)).toBeHidden()
    await expect(trigger(page)).toHaveText('Atkinson Hyperlegible')
  })
})

for (const vp of [
  { name: 'desktop 1440 px', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'iPhone 375 px', use: { viewport: { width: 375, height: 812 }, userAgent: devices['iPhone 13'].userAgent, isMobile: true, hasTouch: true } },
]) {
  test.describe(`font trigger, ${vp.name}`, () => {
    test.use(vp.use)

    test('a long font name truncates inside its column; the Crisp badge stays visible beside it', async ({ page }) => {
      if (vp.use.isMobile) await removeDeviceApis(page)
      await page.goto('./')
      if (vp.use.isMobile) await page.getByRole('button', { name: 'Start designing' }).click()
      await ready(page)
      const weight = page.getByLabel('Weight')
      const check = async (font: string) => {
        await trigger(page).scrollIntoViewIfNeeded()
        await trigger(page).click()
        await search(page).fill(font)
        await page.keyboard.press('Enter')
        await expect(trigger(page)).toContainText(font)
        const t = await trigger(page).boundingBox()
        const w = await weight.boundingBox()
        expect(t!.x + t!.width, font).toBeLessThanOrEqual(w!.x)
      }
      await check('Atkinson Hyperlegible')
      await check('Saira Stencil One')
      await check('Silkscreen')
      await page.getByRole('group', { name: 'Quick text size' }).getByRole('button', { name: 'Fit tape' }).click()
      const badge = trigger(page).getByText('Crisp', { exact: true })
      await expect(badge).toBeVisible()
      const b = await badge.boundingBox()
      const t = await trigger(page).boundingBox()
      expect(b!.x + b!.width).toBeLessThanOrEqual(t!.x + t!.width)
      // Nothing is drawn over the badge.
      expect(await badge.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      })).toBe(true)
    })
  })
}
