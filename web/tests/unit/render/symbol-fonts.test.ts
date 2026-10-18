// "Insert special character" (docs/TABLE-PLAN.md §12) — every symbol the menu offers is drawn by a
// bundled font, in every bundled family and weight, in text blocks and tables alike: the face
// itself when its woff2 has the glyph, else JetBrains Mono, else B612 (the order of the CSS font
// stack, render/fonts.ts `faceCss`), and `fontsUsed` loads that fallback face (at the weight CSS
// matching picks) so the browser never reaches a system font. Checked against the cmap of the
// woff2 files in web/public/fonts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDoc, createItem, type FontWeight, type Item, type TableItem, type TextItem } from '../../../src/doc/schema'
import { FONTS, SYMBOL_FONTS, faceCss, fontDef, fontsUsed } from '../../../src/render/fonts'
import { SYMBOL_GROUPS } from '../../../src/ui/editor/symbols'
import { codePoints, readWoff2 } from './font-library-woff2'

const FONT_DIR = fileURLToPath(new URL('../../../public/fonts/', import.meta.url))
const cmap = new Map<string, Set<number>>()
const covers = (file: string, ch: string): boolean => {
  let set = cmap.get(file)
  if (!set) cmap.set(file, (set = codePoints(readWoff2(readFileSync(`${FONT_DIR}${file}`)))))
  return set.has(ch.codePointAt(0) ?? 0)
}
const SYMBOLS = SYMBOL_GROUPS.flatMap((g) => g.symbols.map(([s]) => s))
const FALLBACKS = ['jetbrains-mono', 'b612'] as const
const fileOf = (id: string, w: FontWeight): string => fontDef(id as 'fira-sans').files[w] as string

describe('special characters: bundled-font coverage', () => {
  it('the menu: single code points, no duplicates, six groups', () => {
    expect(SYMBOL_GROUPS.map((g) => g.label)).toEqual(['Music', 'Arrows', 'Maths', 'Typography', 'Currency', 'Marks'])
    expect(new Set(SYMBOLS).size).toBe(SYMBOLS.length)
    for (const s of SYMBOLS) expect([...s], s).toHaveLength(1)
    for (const s of ['♯', '♭', '→', '±', '°', '½', '•', '€', '✓', '★']) expect(SYMBOLS).toContain(s)
  })

  it('the CSS font stack: the face, then the JetBrains Mono and B612 symbol faces, then the generic', () => {
    expect(faceCss(fontDef('fira-sans'), 600, 20)).toBe('600 20px "ptouch Fira Sans", "ptouch Symbols JetBrains Mono", "ptouch Symbols B612", sans-serif')
    expect(faceCss(fontDef('caveat'), 700, 10, true)).toBe('italic 700 10px "ptouch Caveat", "ptouch Symbols JetBrains Mono", "ptouch Symbols B612", cursive')
    // Not the JetBrains Mono / B612 families (the picker and barcode captions load those): the
    // symbol faces have their own family names and unicode-range.
    expect(SYMBOL_FONTS.map((f) => [f.id, f.family])).toEqual([
      ['jetbrains-mono', 'ptouch Symbols JetBrains Mono'],
      ['b612', 'ptouch Symbols B612'],
    ])
    for (const f of SYMBOL_FONTS) expect(f.family).not.toBe(fontDef(f.id).family)
  })

  it('each symbol face: its unicode-range is exactly the characters that make fontsUsed load it', () => {
    for (const f of SYMBOL_FONTS) {
      const ranges = f.range.split(', ').map((r) => {
        const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/.exec(r)
        expect(m, r).not.toBeNull()
        return [parseInt(m![1]!, 16), parseInt(m![2] ?? m![1]!, 16)] as const
      })
      for (let cp = 0x20; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue
        expect(f.chars.test(String.fromCodePoint(cp)), `${f.id} U+${cp.toString(16)}`).toBe(ranges.some(([a, b]) => cp >= a && cp <= b))
      }
    }
  })

  it('every symbol, in every family and weight: the face or a fallback has it, and fontsUsed loads that fallback (text and table)', () => {
    const gaps: string[] = []
    for (const def of FONTS) {
      for (const w of def.weights) {
        // The symbol faces CSS picks for this weight (both families have 400 and 700 only).
        const fw: FontWeight = w >= 600 ? 700 : 400
        for (const sym of SYMBOLS) {
          const chain = [def.files[w] as string, ...FALLBACKS.map((id) => fileOf(id, fw))]
          const at = chain.findIndex((f) => covers(f, sym))
          if (at < 0) {
            gaps.push(`${def.id}@${w} ${sym}`)
            continue
          }
          const text: TextItem = { ...(createItem('text') as TextItem), text: `A${sym}`, fontFamily: def.id, fontWeight: w }
          const table: TableItem = { ...(createItem('table') as TableItem), cells: [[`A${sym}`]], fontFamily: def.id, fontWeight: w }
          for (const item of [text, table] as Item[]) {
            const used = fontsUsed(createDoc({ items: [item] }))
            expect(used, `${item.kind} ${def.id}@${w}`).toContainEqual({ id: def.id, weight: w })
            // The face that draws it is loaded (when the face itself has it there is nothing more to load).
            if (at > 0) {
              expect(used, `${item.kind} ${def.id}@${w} ${sym} needs ${FALLBACKS[at - 1]}`).toContainEqual({ id: FALLBACKS[at - 1], weight: fw, symbols: true })
              // …and the symbol is inside that face's unicode-range (else CSS never uses it).
              expect(SYMBOL_FONTS.find((f) => f.id === FALLBACKS[at - 1])?.chars.test(sym), `${sym} in the ${FALLBACKS[at - 1]} range`).toBe(true)
            }
          }
        }
      }
    }
    expect(gaps).toEqual([])
  })

  it('every symbol is in JetBrains Mono or B612 (both weights), so a custom font that lacks it still falls back to a bundled one', () => {
    for (const sym of SYMBOLS) for (const fw of [400, 700] as const) expect(FALLBACKS.some((id) => covers(fileOf(id, fw), sym)), `${sym}@${fw}`).toBe(true)
  })

  it('the symbols left out of the menu are in no bundled font', () => {
    const files = FONTS.flatMap((d) => Object.values(d.files) as string[])
    for (const sym of ['♮', '♩', '♪', '♫', '♥', '⌀', '✔', '✘']) expect(files.filter((f) => covers(f, sym)), sym).toEqual([])
  })

  it('plain text loads no symbol font', () => {
    const text: TextItem = { ...(createItem('text') as TextItem), text: 'Pantry – 2 × 500 g, 20 °C … €3' }
    expect(fontsUsed(createDoc({ items: [text] })).map((u) => u.id)).toEqual([text.fontFamily])
  })
})
