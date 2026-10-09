// P-lib — the font library (docs/FONTS-AND-SIZE-PLAN.md §3.1): every schema id has a family, every
// library file decodes, is the family and weight the catalogue says, covers its preview text, and
// respects its licence (Reserved Font Names, licence texts, SOURCES.md, THIRD_PARTY.md and the
// published licences page). The files are read with a small WOFF2 reader (font-library-woff2.ts).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FONT_FAMILY_IDS } from '../../../src/doc/schema'
import { FONTS, findFont, type FontDef } from '../../../src/render/font-catalog'
import { familyLoading, familyReady, loadFamily } from '../../../src/render/fonts'
import { advances, axes, codePoints, names, numGlyphs, readWoff2, unitsPerEm, weightClass, type Woff2Font } from './font-library-woff2'

const WEB = fileURLToPath(new URL('../../../', import.meta.url))
const FONT_DIR = `${WEB}public/fonts/`
const CORE_PREFIXES = ['FiraSans', 'ArchivoNarrow', 'JetBrainsMono', 'AtkinsonHyperlegible']

/** Schema ids deliberately left without a family, with the reason (none this round). */
const DROPPED: Record<string, string> = {}

/**
 * Families with a Reserved Font Name that are shipped unmodified (OFL-FAQ 2.2): upstream glyph
 * count and variation axes, so a subset or instance of them can never slip in under the name.
 * `bytes`: the upstream WOFF2 file itself, so SOURCES.md records the same SHA-256 as upstream and
 * as bundled; otherwise the upstream font re-wrapped as WOFF2 without any table transform.
 */
const UNMODIFIED: Record<string, { glyphs: number; axes: string[]; bytes?: true }> = {
  'fira-sans': { glyphs: 2881, axes: [], bytes: true },
  quicksand: { glyphs: 812, axes: ['wght'] },
}

const library = FONTS.filter((f) => !f.core)
const fileCache = new Map<string, Woff2Font>()
const font = (file: string): Woff2Font => {
  let f = fileCache.get(file)
  if (!f) fileCache.set(file, (f = readWoff2(readFileSync(`${FONT_DIR}${file}`))))
  return f
}
const filesOf = (def: FontDef): string[] => [...new Set(Object.values(def.files).filter((v): v is string => typeof v === 'string'))]
const read = (rel: string): string => readFileSync(`${WEB}${rel}`, 'utf8')

/** The Reserved Font Names an OFL licence text declares ("with Reserved Font Name “X”"). */
function reservedNames(text: string): string[] {
  return [...text.matchAll(/with Reserved Font Names?\s*["“]([^"”]+)["”]/g)].map((m) => (m[1] as string).trim())
}

describe('font library: catalogue', () => {
  it('every schema font id has a family (or is listed as dropped with a reason)', () => {
    for (const id of FONT_FAMILY_IDS) expect(findFont(id) !== undefined || DROPPED[id] !== undefined, id).toBe(true)
    expect(library).toHaveLength(21)
    expect(FONTS).toHaveLength(FONT_FAMILY_IDS.length - Object.keys(DROPPED).length)
  })

  it('lists the families in schema order, by category', () => {
    expect(FONTS.map((f) => f.id)).toEqual(FONT_FAMILY_IDS.filter((id) => DROPPED[id] === undefined))
  })

  it('library files are lazy: not core, never named like a core file, at most 3 weights', () => {
    for (const def of library) {
      expect(def.core, def.id).toBe(false)
      expect(def.weights.length, def.id).toBeLessThanOrEqual(3)
      for (const file of filesOf(def)) for (const p of CORE_PREFIXES) expect(file.startsWith(p), file).toBe(false)
    }
  })

  it('stays small: ≤ 80 KB per file, ≤ 1.5 MB for the whole library', () => {
    let total = 0
    for (const file of new Set(library.flatMap(filesOf))) {
      const n = readFileSync(`${FONT_DIR}${file}`).length
      expect(n, file).toBeLessThanOrEqual(80 * 1024)
      total += n
    }
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024)
  })

  it('every font and licence file in public/fonts belongs to a family (no orphans)', () => {
    const used = new Set(FONTS.flatMap((d) => [...filesOf(d), d.licenseFile]))
    const onDisk = readdirSync(FONT_DIR).filter((n) => /\.(woff2|txt)$/.test(n))
    expect(onDisk.filter((n) => !used.has(n))).toEqual([])
  })

  it('only Silkscreen is snapped to a pixel grid (VT323 and Pixelify Sans are not on a whole grid)', () => {
    expect(FONTS.filter((f) => f.pixel).map((f) => [f.id, f.pixel?.emPx])).toEqual([['silkscreen', 8]])
    expect(FONTS.filter((f) => f.category === 'pixel').map((f) => f.id)).toEqual(['silkscreen', 'vt323', 'pixelify-sans'])
  })
})

describe('font library: the files', () => {
  it('every file is the family and weight the catalogue says', () => {
    for (const def of library) {
      for (const w of def.weights) {
        const f = font(def.files[w] as string)
        const family = [...names(f, 16), ...names(f, 1)]
        expect(family.some((n) => n.startsWith(def.label)), `${def.id}: ${family.join(' / ')}`).toBe(true)
        const wght = axes(f).find((a) => a.tag === 'wght')
        if (wght) {
          // A variable file (shipped unmodified): the browser sets the axis from the weight.
          expect(wght.min <= w && w <= wght.max, `${def.id} ${w}`).toBe(true)
        } else {
          expect(weightClass(f), `${def.id} ${w}`).toBe(w)
        }
      }
    }
  })

  it('covers printable ASCII and the picker preview text', () => {
    for (const def of library) {
      for (const file of filesOf(def)) {
        const cps = codePoints(font(file))
        for (let c = 0x20; c < 0x7f; c++) expect(cps.has(c), `${file} U+${c.toString(16)}`).toBe(true)
        for (const ch of def.preview) expect(cps.has(ch.codePointAt(0) as number), `${file} “${ch}”`).toBe(true)
      }
    }
  })

  it('keeps the copyright and licence name records', () => {
    for (const def of library) {
      for (const file of filesOf(def)) {
        const f = font(file)
        expect(names(f, 0).join(' '), file).toMatch(/Copyright/i)
        expect(names(f, 13).join(' '), file).toMatch(def.license === 'OFL-1.1' ? /Open Font License/ : /Apache License/)
      }
    }
  })

  it('a pixel font’s grid divides the em and every advance width', () => {
    for (const def of FONTS.filter((f) => f.pixel)) {
      for (const file of filesOf(def)) {
        const f = font(file)
        const em = unitsPerEm(f)
        const emPx = def.pixel?.emPx as number
        expect(em % emPx, file).toBe(0)
        const grid = em / emPx
        expect(advances(f).filter((a) => a % grid !== 0), file).toEqual([])
      }
    }
  })
})

describe('font library: licences', () => {
  it('Reserved Font Names: shipped unmodified, or never used by a modified file (core included)', () => {
    const sources = readFileSync(`${FONT_DIR}SOURCES.md`, 'utf8')
    const reservedIds: string[] = []
    for (const def of FONTS) {
      const rfn = [...new Set([...reservedNames(readFileSync(`${FONT_DIR}${def.licenseFile}`, 'utf8')), ...filesOf(def).flatMap((file) => reservedNames(names(font(file), 0).join(' ')))])]
      if (rfn.length === 0) continue
      reservedIds.push(def.id)
      const keep = UNMODIFIED[def.id]
      for (const file of filesOf(def)) {
        const f = font(file)
        if (keep) {
          // The whole upstream font: every glyph, every axis, no extra metadata.
          expect(numGlyphs(f), file).toBe(keep.glyphs)
          expect(axes(f).map((a) => a.tag), file).toEqual(keep.axes)
          expect(f.hasMetadata || f.hasPrivate, file).toBe(false)
          if (keep.bytes) {
            // Upstream's own WOFF2: its row in SOURCES.md lists the file's hash as upstream and bundled.
            const sha = createHash('sha256').update(readFileSync(`${FONT_DIR}${file}`)).digest('hex')
            const row = sources.split('\n').find((l) => l.startsWith(`| \`${file}\` |`)) ?? ''
            expect(row.split(sha).length - 1, `${file}: upstream SHA-256 = bundled SHA-256`).toBe(2)
          } else {
            // Re-wrapped: no WOFF2 table transform.
            expect([...f.tables.values()].filter((t) => t.transformed).map((t) => t.tag), file).toEqual([])
          }
        } else {
          const used = [def.label, ...[1, 4, 6, 16, 17, 21, 22].flatMap((id) => names(f, id))]
          for (const r of rfn) for (const n of used) expect(n.toLowerCase().includes(r.toLowerCase()), `${file}: “${n}” uses the Reserved Font Name “${r}”`).toBe(false)
        }
      }
    }
    // Fira Sans ("Fira", nameID 0 only) and Quicksand ("Quicksand"), kept unmodified, and Lexend
    // ("RevReading Lexend", not used).
    expect(reservedIds).toEqual(['fira-sans', 'quicksand', 'lexend'])
  })

  it('every licence text is upstream’s, matches the licence, and is hashed in SOURCES.md', () => {
    const sources = readFileSync(`${FONT_DIR}SOURCES.md`, 'utf8')
    for (const def of FONTS) {
      const bytes = readFileSync(`${FONT_DIR}${def.licenseFile}`)
      expect(sources, def.licenseFile).toContain(createHash('sha256').update(bytes).digest('hex'))
      expect(def.licenseFile.startsWith(def.license === 'OFL-1.1' ? 'OFL-' : 'Apache-'), def.licenseFile).toBe(true)
      if (def.license === 'Apache-2.0') expect(bytes.toString('utf8')).toContain('Version 2.0, January 2004')
    }
  })

  it('SOURCES.md records the pinned upstream commit and the RFN finding of every family', () => {
    const sources = readFileSync(`${FONT_DIR}SOURCES.md`, 'utf8')
    expect(sources).toContain('f2bd09badbc763d8757951d52deec29da27e85fb')
    for (const def of library) expect(sources, def.label).toMatch(new RegExp(`^\\| ${def.label} \\| (OFL-1\\.1|Apache-2\\.0)`, 'm'))

    // Every table has exactly one delimiter row, right under its header (GFM renders a second one as a row of "---").
    const lines = sources.split('\n')
    const delim = /^\|(\s*:?-{3,}:?\s*\|)+$/
    lines.forEach((l, i) => {
      if (delim.test(l)) expect(lines[i - 1]?.startsWith('|') && !delim.test(lines[i - 1] as string), `SOURCES.md line ${i + 1}`).toBe(true)
    })
  })

  it('THIRD_PARTY.md and the published licences page list every family and its licence text', () => {
    const third = read('THIRD_PARTY.md')
    const page = read('public/licenses/index.html')
    for (const def of FONTS) {
      expect(third, def.label).toContain(`| ${def.label} |`)
      expect(third, def.licenseFile).toContain(`\`${def.licenseFile}\``)
      expect(page, def.licenseFile).toContain(`<a href="../fonts/${def.licenseFile}">${def.label}</a>`)
    }
  })
})

describe('font library: lazy loader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a family is not ready until its file loaded (fonts.check() alone says yes for unknown families)', async () => {
    const set = new Set<unknown>()
    let fail = true
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly desc: Record<string, string>,
      ) {}
      async load() {
        if (fail) throw new Error('offline')
        return this
      }
    }
    vi.stubGlobal('FontFace', FakeFace)
    // Like the real FontFaceSet: check() is true when no registered face needs loading.
    vi.stubGlobal('fonts', { add: (f: unknown) => set.add(f), delete: (f: unknown) => set.delete(f), check: () => true })
    expect(familyReady('caveat', 700)).toBe(false)
    expect(familyLoading('caveat', 700)).toBe(false)

    // Offline before the font was ever cached: not ready, the failed face is unregistered.
    expect(await loadFamily('caveat', 700)).toBe(false)
    expect(familyReady('caveat', 700)).toBe(false)
    expect(familyLoading('caveat', 700)).toBe(false)
    expect(set.size).toBe(0)

    // The next use retries and succeeds.
    fail = false
    expect(await loadFamily('caveat', 700)).toBe(true)
    expect(familyReady('caveat', 700)).toBe(true)
    expect(familyReady('caveat', 400)).toBe(false)
    expect([...set].map((f) => (f as FakeFace).source)).toEqual([expect.stringMatching(/fonts\/Caveat-Bold\.woff2"\) format\("woff2"\)$/)])
  })

  it('weights that share one variable file get a face each, weighted for the browser’s axis', async () => {
    const added: { family: string; source: string; desc: Record<string, string> }[] = []
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly desc: Record<string, string>,
      ) {}
      async load() {
        return this
      }
    }
    vi.stubGlobal('FontFace', FakeFace)
    vi.stubGlobal('fonts', { add: (f: FakeFace) => added.push(f), delete: () => true, check: () => true })
    expect(await Promise.all([loadFamily('quicksand', 500), loadFamily('quicksand', 700), loadFamily('quicksand', 400)])).toEqual([true, true, true])
    expect(added.map((f) => [f.family, f.desc.weight, /Quicksand-Variable\.woff2/.test(f.source)])).toEqual([
      ['ptouch Quicksand', '500', true],
      ['ptouch Quicksand', '700', true],
    ])
  })
})
