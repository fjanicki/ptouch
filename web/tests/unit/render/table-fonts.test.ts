// Tables (docs/TABLE-PLAN.md T12) — ♯ / ♭ in table cells are drawn with the bundled JetBrains
// Mono: it is the only bundled family that has them, `fontsUsed` loads it (the weight CSS picks),
// and every character of the Music templates is covered by its font or JetBrains Mono (woff2 cmap).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDoc, createItem, type TableItem } from '../../../src/doc/schema'
import { FONTS, customFontsUsed, fontDef, fontsUsed, resolveWeight } from '../../../src/render/fonts'
import { TEMPLATES } from '../../../src/ui/templates/templates'
import { codePoints, readWoff2 } from './font-library-woff2'

const FONT_DIR = fileURLToPath(new URL('../../../public/fonts/', import.meta.url))
const cmap = new Map<string, Set<number>>()
const covers = (file: string, cp: number): boolean => {
  let set = cmap.get(file)
  if (!set) cmap.set(file, (set = codePoints(readWoff2(readFileSync(`${FONT_DIR}${file}`)))))
  return set.has(cp)
}
const table = (cells: string[][], patch: Partial<TableItem> = {}): TableItem => ({ ...createItem('table'), cells, ...patch })

describe('table fonts', () => {
  it('only JetBrains Mono has ♯ and ♭ among the bundled faces', () => {
    const withBoth = FONTS.filter((def) => Object.values(def.files).some((f) => typeof f === 'string' && covers(f, 0x266f) && covers(f, 0x266d))).map((d) => d.id)
    expect(withBoth).toEqual(['jetbrains-mono'])
    for (const f of Object.values(fontDef('jetbrains-mono').files)) expect(covers(f as string, 0x266f) && covers(f as string, 0x266d)).toBe(true)
  })

  it('fontsUsed: the table face, plus JetBrains Mono at the weight CSS picks when a cell has ♭ ♮ ♯', () => {
    expect(fontsUsed(createDoc({ items: [table([['DO', 'RE']])] }))).toEqual([{ id: 'fira-sans', weight: 600 }])
    expect(fontsUsed(createDoc({ items: [table([['DO♯']], { fontWeight: 700 })] }))).toEqual([
      { id: 'fira-sans', weight: 700 },
      { id: 'jetbrains-mono', weight: 700, symbols: true },
    ])
    expect(fontsUsed(createDoc({ items: [table([['MI♭']], { fontWeight: 500, fontFamily: 'oswald' })] }))).toEqual([
      { id: 'oswald', weight: resolveWeight(fontDef('oswald'), 500) },
      { id: 'jetbrains-mono', weight: 400, symbols: true },
    ])
    expect(fontsUsed(createDoc({ items: [table([['', ' ']])] }))).toEqual([])
  })

  it('fontsUsed: the JetBrains weight follows the weight CSS asks for (the family\'s resolved weight), not the raw one', () => {
    // Off-family weights only come from imported docs (readFont snaps to FONT_WEIGHTS only).
    // anton has 400 only: CSS asks for 400, so JetBrains 400 (not 700).
    expect(resolveWeight(fontDef('anton'), 600)).toBe(400)
    expect(fontsUsed(createDoc({ items: [table([['DO♯']], { fontFamily: 'anton', fontWeight: 600 })] }))).toEqual([
      { id: 'anton', weight: 400 },
      { id: 'jetbrains-mono', weight: 400, symbols: true },
    ])
    // quicksand@600 → its nearest weight; JetBrains follows that weight.
    const q = resolveWeight(fontDef('quicksand'), 600)
    expect(fontsUsed(createDoc({ items: [table([['DO♯']], { fontFamily: 'quicksand', fontWeight: 600 })] }))).toEqual([
      { id: 'quicksand', weight: q },
      { id: 'jetbrains-mono', weight: q >= 600 ? 700 : 400, symbols: true },
    ])
  })

  it('customFontsUsed includes tables', () => {
    const customFont = { kind: 'local', postscriptName: 'Foo-Bold', family: 'Foo' } as const
    expect(customFontsUsed(createDoc({ items: [table([['A']], { customFont })] }))).toEqual([customFont])
  })

  it('every character of the Music templates is in its font or in JetBrains Mono', () => {
    const music = TEMPLATES.filter((t) => t.category === 'music')
    expect(music.map((t) => t.id)).toEqual(['piano-white-24', 'piano-12-24', 'piano-12-flats-24'])
    const jbm = fontDef('jetbrains-mono')
    for (const t of music) {
      for (const item of t.build().items) {
        if (item.kind !== 'table') continue
        const def = fontDef(item.fontFamily)
        const own = def.files[resolveWeight(def, item.fontWeight)] as string
        const fallback = jbm.files[item.fontWeight >= 600 ? 700 : 400] as string
        for (const ch of new Set(item.cells.flat().join(''))) {
          const cp = ch.codePointAt(0) ?? 0
          expect(covers(own, cp) || covers(fallback, cp), `${t.id}: ${ch}`).toBe(true)
        }
      }
    }
  })
})
