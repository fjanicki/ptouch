// Font picker list model (docs/FONTS-AND-SIZE-PLAN.md §3.2): entries, search (accent- and
// case-insensitive, best match first), chips, grouping order, favourites / recent (fonts that are
// gone are skipped), keyboard moves, previews and print-quality notes. Uses fake FontDefs, so it
// does not depend on which library families have landed.
import { describe, expect, it } from 'vitest'
import type { FontFamilyId } from '../../../src/doc/schema'
import { FONT_CATEGORIES, MIN_QUALITY_CAP_MM, type FontCategory, type FontDef } from '../../../src/render/font-catalog'
import {
  GROUP_LABELS,
  PAGE_ROWS,
  availableFilters,
  buildGroups,
  flatOptions,
  fold,
  fontEntries,
  matchScore,
  missingEntry,
  moveActive,
  previewText,
  qualityNote,
  qualityTag,
  type FontEntry,
} from '../../../src/ui/fonts/font-list'

function def(id: string, label: string, category: FontCategory, extra: Partial<FontDef> = {}): FontDef {
  return {
    id: id as FontFamilyId,
    family: `ptouch ${label}`,
    label,
    category,
    weights: [400, 700],
    files: { 400: `${label}-Regular.woff2` },
    license: 'OFL-1.1',
    licenseFile: `OFL-${label}.txt`,
    hint: '',
    preview: 'Label 123',
    generic: 'sans-serif',
    core: false,
    ...extra,
  }
}

const FONTS: FontDef[] = [
  def('fira-sans', 'Fira Sans', 'sans', { hint: 'Clear, sturdy sans-serif', core: true }),
  def('jetbrains-mono', 'JetBrains Mono', 'mono', { hint: 'Monospaced: serial numbers, codes', generic: 'monospace' }),
  def('courier-prime', 'Courier Prime', 'typewriter', { hint: 'Typewriter, monospaced', generic: 'monospace' }),
  def('oswald', 'Oswald', 'condensed', { condensed: true, hint: 'Tall and narrow' }),
  def('caveat', 'Caveat', 'handwritten', { quality: 'script', hint: 'Casual handwriting' }),
  def('quicksand', 'Quicksand', 'rounded', { quality: 'thin', hint: 'Light and round' }),
  def('silkscreen', 'Silkscreen', 'pixel', { pixel: { emPx: 8 }, hint: 'Blocky' }),
  def('fredoka', 'Fredoka', 'rounded', { hint: 'Soft and friendly' }),
]
const USER = [{ ref: 'sha256-0123456789abcdef0123456789abcdef', family: 'Café Grotesk' }]
const LOCAL = [{ postscriptName: 'Menlo-Regular', name: 'Menlo Regular' }]

const labels = (es: readonly FontEntry[]) => es.map((e) => e.label)

describe('fold', () => {
  it('lower-cases, removes accents and collapses punctuation', () => {
    expect(fold('  Café   GROTESK! ')).toBe('cafe grotesk')
    expect(fold('Ärger-Über')).toBe('arger uber')
    expect(fold('')).toBe('')
  })
})

describe('fontEntries', () => {
  it('lists bundled fonts in category order, then uploaded, then local fonts', () => {
    const es = fontEntries(FONTS, USER, LOCAL)
    const order = FONT_CATEGORIES.map((c) => c.id)
    const bundled = es.filter((e) => e.kind === 'bundled')
    const cats = bundled.map((e) => order.indexOf(e.def?.category as FontCategory))
    expect(cats).toEqual([...cats].sort((a, b) => a - b))
    // Registry order inside a category.
    expect(labels(bundled.filter((e) => e.def?.category === 'rounded'))).toEqual(['Quicksand', 'Fredoka'])
    expect(es.slice(-2).map((e) => [e.kind, e.key])).toEqual([
      ['user', 'u:sha256-0123456789abcdef0123456789abcdef'],
      ['local', 'l:Menlo-Regular'],
    ])
    expect(es.at(-2)?.source).toEqual({ kind: 'user', ref: USER[0]?.ref, family: 'Café Grotesk' })
    expect(es.at(-1)?.source).toEqual({ kind: 'local', postscriptName: 'Menlo-Regular', family: 'Menlo Regular' })
  })

  it('adds a missing entry only for a custom font that is not listed', () => {
    const es = fontEntries(FONTS, USER, [])
    expect(missingEntry({}, es)).toBeUndefined()
    expect(missingEntry({ customFont: { kind: 'user', ref: USER[0]?.ref as string, family: 'X' } }, es)).toBeUndefined()
    const m = missingEntry({ customFont: { kind: 'local', postscriptName: 'Gone-Bold', family: 'Gone Bold' } }, es)
    expect(m).toMatchObject({ key: 'l:Gone-Bold', kind: 'local', label: 'Gone Bold', missing: true })
  })
})

describe('search', () => {
  const es = fontEntries(FONTS, USER, LOCAL)
  const find = (label: string) => es.find((e) => e.label === label) as FontEntry

  it('is case- and accent-insensitive', () => {
    expect(matchScore(find('Café Grotesk'), 'cafe')).toBeGreaterThan(0)
    expect(matchScore(find('Café Grotesk'), 'CAFÉ gro')).toBeGreaterThan(0)
    expect(matchScore(find('Oswald'), 'ÖSWALD')).toBe(100)
  })

  it('ranks name matches above category / hint matches', () => {
    const s = (l: string, q: string) => matchScore(find(l), q)
    expect(s('JetBrains Mono', 'mono')).toBeGreaterThan(s('Courier Prime', 'mono'))
    expect(s('Oswald', 'osw')).toBeGreaterThan(s('Oswald', 'ald'))
    expect(s('Oswald', 'narrow')).toBeGreaterThan(0) // the condensed flag
    expect(s('Silkscreen', 'pixel')).toBeGreaterThan(0)
    expect(s('Menlo Regular', 'computer')).toBeGreaterThan(0)
    expect(s('Oswald', 'xyz')).toBe(0)
  })

  it('needs every word of the query', () => {
    expect(matchScore(find('JetBrains Mono'), 'jet mono')).toBeGreaterThan(0)
    expect(matchScore(find('JetBrains Mono'), 'jet sans')).toBe(0)
  })

  it('search results are one group, best match first', () => {
    const groups = buildGroups({ entries: es, favorites: ['b:oswald'], recent: ['b:caveat'], query: 'mono' })
    expect(groups.map((g) => g.id)).toEqual(['results'])
    expect(groups[0]?.label).toBe(GROUP_LABELS.results)
    expect(labels(groups[0]?.entries ?? [])[0]).toBe('JetBrains Mono')
    expect(labels(groups[0]?.entries ?? [])).toContain('Courier Prime')
    expect(buildGroups({ entries: es, query: 'zzzz' })).toEqual([])
  })
})

describe('grouping', () => {
  const es = fontEntries(FONTS, USER, LOCAL)

  it('browsing: favourites, recent, categories in order, your fonts, this computer', () => {
    const groups = buildGroups({ entries: es, favorites: ['b:caveat', 'l:Menlo-Regular'], recent: ['b:oswald', 'b:fira-sans'] })
    const order = FONT_CATEGORIES.map((c) => c.id as string)
    const ids = groups.map((g) => g.id as string)
    expect(ids.slice(0, 2)).toEqual(['favorites', 'recent'])
    expect(ids.slice(-2)).toEqual(['user', 'local'])
    const cats = ids.slice(2, -2)
    expect(cats).toEqual(order.filter((c) => cats.includes(c)))
    expect(cats).not.toContain('stencil') // empty groups are left out
    expect(labels(groups[0]?.entries ?? [])).toEqual(['Caveat', 'Menlo Regular']) // starring order
    expect(labels(groups[1]?.entries ?? [])).toEqual(['Oswald', 'Fira Sans']) // most recent first
    expect(groups.find((g) => g.id === 'local')?.label).toBe(GROUP_LABELS.local)
  })

  it('skips favourites and recent fonts that are gone', () => {
    const gone = ['u:sha256-ffffffffffffffffffffffffffffffff', 'l:Gone-Bold', 'b:anton']
    const groups = buildGroups({ entries: es, favorites: gone, recent: [...gone, 'b:oswald', 'b:oswald'] })
    expect(groups.find((g) => g.id === 'favorites')).toBeUndefined()
    expect(labels(groups.find((g) => g.id === 'recent')?.entries ?? [])).toEqual(['Oswald'])
  })

  it('chips filter by category or your fonts, and hide favourites / recent', () => {
    const filters = availableFilters(es)
    expect(filters.map((f) => f.id)).toEqual([...FONT_CATEGORIES.map((c) => c.id).filter((c) => FONTS.some((f) => f.category === c)), 'yours'])
    expect(availableFilters(fontEntries(FONTS)).map((f) => f.id)).not.toContain('yours')
    const rounded = buildGroups({ entries: es, favorites: ['b:caveat'], filters: new Set(['rounded']) })
    expect(rounded.map((g) => g.id)).toEqual(['rounded'])
    expect(labels(rounded[0]?.entries ?? [])).toEqual(['Quicksand', 'Fredoka'])
    const yours = buildGroups({ entries: es, filters: new Set(['yours', 'pixel']) })
    expect(yours.map((g) => g.id)).toEqual(['pixel', 'user', 'local'])
    // Chips and search combine.
    expect(labels(buildGroups({ entries: es, query: 'mono', filters: new Set(['typewriter']) })[0]?.entries ?? [])).toEqual(['Courier Prime'])
  })

  it('flatOptions numbers the options in listbox order (an entry can appear twice)', () => {
    const groups = buildGroups({ entries: es, favorites: ['b:oswald'] })
    const opts = flatOptions(groups)
    expect(opts.map((o) => o.index)).toEqual(opts.map((_, i) => i))
    expect(opts[0]).toMatchObject({ group: 'favorites', entry: { key: 'b:oswald' } })
    expect(opts.filter((o) => o.entry.key === 'b:oswald')).toHaveLength(2)
  })
})

describe('keyboard', () => {
  it('moveActive walks, clamps and jumps', () => {
    expect(moveActive(-1, 'ArrowDown', 5)).toBe(0)
    expect(moveActive(-1, 'ArrowUp', 5)).toBe(4)
    expect(moveActive(4, 'ArrowDown', 5)).toBe(4)
    expect(moveActive(0, 'ArrowUp', 5)).toBe(0)
    expect(moveActive(2, 'Home', 5)).toBe(0)
    expect(moveActive(2, 'End', 5)).toBe(4)
    expect(moveActive(0, 'PageDown', 30)).toBe(PAGE_ROWS)
    expect(moveActive(-1, 'PageDown', 30)).toBe(PAGE_ROWS)
    expect(moveActive(3, 'PageUp', 30)).toBe(0)
    expect(moveActive(1, 'x', 5)).toBeUndefined()
    expect(moveActive(0, 'ArrowDown', 0)).toBe(-1)
    expect(moveActive(0, 'PageDown', 0)).toBeUndefined()
  })
})

describe('previews and hints', () => {
  it('previewText: first non-empty line, trimmed', () => {
    expect(previewText('\n  Hello  \nWorld')).toBe('Hello')
    expect(previewText('')).toBe('')
    expect(previewText('   \n ')).toBe('')
    const long = previewText('A label text that is far too long for a row')
    expect([...long]).toHaveLength(24)
    expect(long.endsWith('…')).toBe(true)
  })

  it('quality notes and row tags for thin and script fonts below the readable cap height', () => {
    const quick = FONTS.find((f) => f.id === 'quicksand') as FontDef
    const caveat = FONTS.find((f) => f.id === 'caveat') as FontDef
    const fira = FONTS[0] as FontDef
    expect(qualityNote(quick)).toMatch(/thin strokes.*below 3 mm; try M or larger/)
    expect(qualityNote(caveat)).toMatch(/script.*try M or larger/)
    expect(qualityNote(fira)).toBeUndefined()
    expect(qualityTag(quick, MIN_QUALITY_CAP_MM - 0.5)).toBe('Thin at this size')
    expect(qualityTag(caveat, 1)).toBe('Hard to read at this size')
    expect(qualityTag(quick, MIN_QUALITY_CAP_MM)).toBeUndefined()
    expect(qualityTag(quick, undefined)).toBeUndefined()
    expect(qualityTag(fira, 1)).toBeUndefined()
    expect(qualityTag(undefined, 1)).toBeUndefined()
  })
})
