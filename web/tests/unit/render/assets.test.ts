// W3 — bundled fonts (files, licences, SOURCES.md) and the icon set.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDoc, createItem, type TextItem } from '../../../src/doc/schema'
import { ensureFonts, FONTS, fontDef, fontsUsed, fontUrl, resolveWeight } from '../../../src/render/fonts'
import { ICON_CATEGORIES, ICONS, iconById, searchIcons } from '../../../src/render/icons'

const FONT_DIR = fileURLToPath(new URL('../../../public/fonts/', import.meta.url))

describe('bundled fonts', () => {
  const sources = readFileSync(`${FONT_DIR}SOURCES.md`, 'utf8')

  it('every face file exists, is woff2, and is recorded in SOURCES.md with its SHA-256', () => {
    for (const def of FONTS) {
      expect(def.weights.length).toBeGreaterThan(0)
      for (const w of def.weights) {
        const file = def.files[w]
        expect(file, `${def.id} ${w}`).toBeTruthy()
        const bytes = readFileSync(`${FONT_DIR}${file}`)
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2')
        const sha = createHash('sha256').update(bytes).digest('hex')
        expect(sources, `${file} hash`).toContain(sha)
        expect(sources).toContain(`\`${file}\``)
      }
      expect(existsSync(`${FONT_DIR}${def.licenseFile}`)).toBe(true)
      expect(readFileSync(`${FONT_DIR}${def.licenseFile}`, 'utf8')).toContain('SIL Open Font License')
    }
  })

  it('registers private family names (a locally installed copy can never stand in)', () => {
    for (const def of FONTS) expect(def.family.startsWith('ptouch ')).toBe(true)
  })

  it('resolves a missing weight to the nearest bundled one', () => {
    const atk = fontDef('atkinson-hyperlegible')
    expect(resolveWeight(atk, 400)).toBe(400)
    expect(resolveWeight(atk, 500)).toBe(400)
    expect(resolveWeight(atk, 600)).toBe(700)
    expect(resolveWeight(atk, 800)).toBe(700)
    expect(resolveWeight(fontDef('fira-sans'), 600)).toBe(600)
  })

  it('lists the faces a document uses (text + barcode captions), deduplicated', () => {
    const t1: TextItem = { ...createItem('text'), fontFamily: 'archivo-narrow', fontWeight: 800 }
    const t2: TextItem = { ...createItem('text'), fontFamily: 'archivo-narrow', fontWeight: 700 }
    const blank: TextItem = { ...createItem('text'), text: '   ', fontFamily: 'atkinson-hyperlegible' }
    const code = { ...createItem('code'), symbology: 'ean13' as const, data: '590123412345', showText: true }
    const used = fontsUsed(createDoc({ items: [t1, t2, blank, code] }))
    expect(used).toEqual([
      { id: 'archivo-narrow', weight: 700 },
      { id: 'jetbrains-mono', weight: 400 },
    ])
  })

  it('font URLs follow the Vite base path', () => {
    expect(fontUrl('FiraSans-Regular.woff2')).toMatch(/^\/(.*\/)?fonts\/FiraSans-Regular\.woff2$/)
  })

  it('reports fallbacks (never throws) where fonts cannot load (node)', async () => {
    const r = await ensureFonts(createDoc())
    expect(r.fallbacks).toEqual(['Fira Sans 600'])
  })
})

describe('icons', () => {
  it('has a useful set with unique ids and known categories', () => {
    expect(ICONS.length).toBeGreaterThanOrEqual(60)
    expect(new Set(ICONS.map((i) => i.id)).size).toBe(ICONS.length)
    const cats = new Set(ICON_CATEGORIES.map((c) => c.id))
    for (const i of ICONS) {
      expect(cats.has(i.category), i.id).toBe(true)
      expect(i.paths.length, i.id).toBeGreaterThan(0)
      for (const d of i.paths) expect(d, i.id).toMatch(/^[Mm][\d\s.,\-+MmLlHhVvCcSsQqTtAaZze]+$/)
      expect(i.keywords.length, i.id).toBeGreaterThan(0)
    }
    for (const c of ICON_CATEGORIES) expect(ICONS.some((i) => i.category === c.id), c.id).toBe(true)
  })

  it('the default icon item exists', () => {
    expect(iconById(createItem('icon').iconId)?.label).toBe('Lightning')
    expect(iconById('nope')).toBeUndefined()
  })

  it('searches labels and keywords', () => {
    expect(searchIcons('').length).toBe(ICONS.length)
    expect(searchIcons('fire').map((i) => i.id)).toContain('flame')
    expect(searchIcons('WATER').map((i) => i.id)).toContain('droplet')
    expect(searchIcons('power off').map((i) => i.id)).toContain('zap-off')
  })
})
