// Font library registry contract (docs/FONTS-AND-SIZE-PLAN.md §2): shape of every entry, the
// core/lazy split the service worker relies on, and the lazy loader's dedupe.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FONT_FAMILY_IDS } from '../../../src/doc/schema'
import { FONT_CATEGORIES, FONTS, coreFontFiles, findFont } from '../../../src/render/font-catalog'
import { familyLoading, familyReady, fontDef, loadFamily } from '../../../src/render/fonts'
import { pwaOptions } from '../../../pwa.config'

const CORE = ['fira-sans', 'archivo-narrow', 'jetbrains-mono', 'atkinson-hyperlegible']

describe('font catalog', () => {
  it('has unique ids, all of them schema ids, and the four core families first', () => {
    const ids = FONTS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(FONT_FAMILY_IDS).toContain(id)
    expect(ids.slice(0, 4)).toEqual(CORE)
    expect(FONTS.filter((f) => f.core).map((f) => f.id)).toEqual(CORE)
  })

  it('every entry is well formed', () => {
    const cats = FONT_CATEGORIES.map((c) => c.id)
    for (const f of FONTS) {
      expect(f.family, f.id).toBe(`ptouch ${f.label}`)
      expect(cats, f.id).toContain(f.category)
      expect(Object.keys(f.files).map(Number).sort(), f.id).toEqual([...f.weights].sort())
      expect(f.preview.trim().length, f.id).toBeGreaterThan(0)
      expect(f.hint.trim().length, f.id).toBeGreaterThan(0)
      if (f.pixel) expect(Number.isInteger(f.pixel.emPx) && f.pixel.emPx > 0, f.id).toBe(true)
      for (const file of Object.values(f.files)) expect(file, f.id).toMatch(/^[A-Za-z0-9_-]+\.woff2$/)
    }
  })

  it('unknown ids fall back to the first family', () => {
    expect(findFont('nope')).toBeUndefined()
    expect(fontDef('nope' as never).id).toBe('fira-sans')
  })
})

describe('service worker: core fonts precached, library fonts cached on first use', () => {
  const wb = pwaOptions.workbox ?? {}
  const globs = wb.globPatterns ?? []

  it('the precache globs name exactly the core families’ files', () => {
    const fontGlobs = globs.filter((g) => g.includes('woff2'))
    expect(fontGlobs).toHaveLength(1)
    const re = globToRegExp(fontGlobs[0] as string)
    for (const file of coreFontFiles()) expect(re.test(`fonts/${file}`), file).toBe(true)
    for (const f of FONTS.filter((d) => !d.core)) for (const file of Object.values(f.files)) expect(re.test(`fonts/${file}`), file).toBe(false)
    // The other patterns never pick up woff2.
    for (const g of globs.filter((x) => x !== fontGlobs[0])) expect(g).not.toMatch(/woff2/)
  })

  it('a runtime rule caches every same-origin fonts/*.woff2 CacheFirst', () => {
    const rule = (wb.runtimeCaching ?? []).find((r) => r.urlPattern instanceof RegExp && r.urlPattern.test('https://example.github.io/ptouch/fonts/Oswald-Bold.woff2'))
    expect(rule).toBeDefined()
    expect(rule?.handler).toBe('CacheFirst')
    const re = rule?.urlPattern as RegExp
    expect(re.test('http://localhost:5173/fonts/Caveat-Regular.woff2')).toBe(true)
    expect(re.test('https://example.github.io/ptouch/fonts/OFL-Oswald.txt')).toBe(false)
    expect(re.test('https://example.github.io/ptouch/assets/index.js')).toBe(false)
  })
})

/** The brace/star subset of glob syntax pwa.config.ts uses. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') re += glob[i + 1] === '*' ? (i++, '.*') : '[^/]*'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',') re += '|'
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

describe('loadFamily (lazy loader)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shares one request between concurrent calls and caches the result', async () => {
    const added: unknown[] = []
    let loads = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let ready = false
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly desc: Record<string, string>,
      ) {}
      async load() {
        loads++
        await gate
        ready = true
        return this
      }
    }
    vi.stubGlobal('FontFace', FakeFace)
    vi.stubGlobal('fonts', { add: (f: unknown) => added.push(f), check: () => ready })
    // Lightest file of a core family that no other test loads in this worker.
    const a = loadFamily('jetbrains-mono', 700)
    const b = loadFamily('jetbrains-mono', 650)
    expect(familyLoading('jetbrains-mono', 700)).toBe(true)
    expect(familyReady('jetbrains-mono', 700)).toBe(false)
    release()
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(loads).toBe(1)
    expect(added).toHaveLength(1)
    expect((added[0] as FakeFace).source).toMatch(/fonts\/JetBrainsMono-Bold\.woff2/)
    expect(familyReady('jetbrains-mono', 700)).toBe(true)
    expect(familyLoading('jetbrains-mono', 700)).toBe(false)
    expect(await loadFamily('jetbrains-mono', 700)).toBe(true)
    expect(loads).toBe(1)
  })
})
