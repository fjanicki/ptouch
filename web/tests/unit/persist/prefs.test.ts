// W5 — preferences survive throwing / corrupt / missing localStorage.
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, MAX_FAVORITE_FONTS, MAX_RECENT_FONTS, PREFS_KEY, isFontKey, loadPrefs, sanitizePrefs, savePrefs, type PrefsStorage } from '../../../src/doc/persist-prefs'

function memory(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const throwing: PrefsStorage = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError')
  },
}

describe('prefs', () => {
  it('returns defaults when nothing is stored or storage is missing', () => {
    expect(loadPrefs(memory())).toEqual(DEFAULT_PREFS)
    expect(loadPrefs(undefined)).toEqual(DEFAULT_PREFS)
  })

  it('saves and merges patches', () => {
    const s = memory()
    savePrefs({ theme: 'dark' }, s)
    const p = savePrefs({ lastPath: 'bluetooth', lastTransport: { kind: 'serial-rfcomm', label: 'Bluetooth printer' } }, s)
    expect(p.theme).toBe('dark')
    expect(loadPrefs(s)).toEqual(p)
    expect(loadPrefs(s).lastPath).toBe('bluetooth')
  })

  it('removes keys patched with undefined', () => {
    const s = memory()
    savePrefs({ lastLabelId: 'x' }, s)
    expect(savePrefs({ lastLabelId: undefined }, s).lastLabelId).toBeUndefined()
    expect(loadPrefs(s).lastLabelId).toBeUndefined()
  })

  it('never throws when storage throws', () => {
    expect(loadPrefs(throwing)).toEqual(DEFAULT_PREFS)
    expect(savePrefs({ theme: 'light' }, throwing).theme).toBe('light')
  })

  it('ignores corrupt JSON and wrong types field by field', () => {
    const s = memory()
    s.data.set(PREFS_KEY, '{not json')
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS)
    s.data.set(PREFS_KEY, JSON.stringify({ theme: 'neon', previewZoom: 'big', autoReconnect: false, lastPath: 'carrier-pigeon', previewMode: 'dots' }))
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, autoReconnect: false, previewMode: 'dots' })
  })

  it('clamps the preview zoom', () => {
    expect(sanitizePrefs({ previewZoom: 1000 }).previewZoom).toBe(16)
    expect(sanitizePrefs({ previewZoom: 0 }).previewZoom).toBe(0.1)
  })
})

describe('prefs: fonts and size (docs/FONTS-AND-SIZE-PLAN.md)', () => {
  it('defaults: Fira Sans semibold, automatic size, no favourites or recent fonts', () => {
    expect(DEFAULT_PREFS).toMatchObject({ defaultFont: { family: 'fira-sans', weight: 600 }, defaultTextSize: 'auto', favoriteFonts: [], recentFonts: [] })
  })

  it('keeps valid values', () => {
    const p = sanitizePrefs({
      defaultFont: { family: 'oswald', weight: 700 },
      defaultTextSize: { pt: 14 },
      favoriteFonts: ['b:caveat', 'u:sha256-0123456789abcdef0123456789abcdef', 'l:Helvetica-Bold'],
      recentFonts: ['b:vt323', 'b:fira-sans'],
    })
    expect(p.defaultFont).toEqual({ family: 'oswald', weight: 700 })
    expect(p.defaultTextSize).toEqual({ pt: 14 })
    expect(p.favoriteFonts).toEqual(['b:caveat', 'u:sha256-0123456789abcdef0123456789abcdef', 'l:Helvetica-Bold'])
    expect(p.recentFonts).toEqual(['b:vt323', 'b:fira-sans'])
    for (const size of ['auto', 'fit', 'half', 'third'] as const) expect(sanitizePrefs({ defaultTextSize: size }).defaultTextSize).toBe(size)
  })

  it('repairs bad values field by field', () => {
    const p = sanitizePrefs({
      defaultFont: { family: 'comic-sans', weight: 700 },
      defaultTextSize: 'huge',
      favoriteFonts: ['b:nope', 'u:../../x', 'l:Evil")', 42, 'b:anton', 'b:anton'],
      recentFonts: 'b:anton',
    })
    expect(p.defaultFont).toEqual(DEFAULT_PREFS.defaultFont)
    expect(p.defaultTextSize).toBe('auto')
    expect(p.favoriteFonts).toEqual(['b:anton'])
    expect(p.recentFonts).toEqual([])
    expect(sanitizePrefs({ defaultFont: { family: 'oswald', weight: 650 } }).defaultFont).toEqual(DEFAULT_PREFS.defaultFont)
    expect(sanitizePrefs({ defaultTextSize: { pt: 1000 } }).defaultTextSize).toEqual({ pt: 144 })
    expect(sanitizePrefs({ defaultTextSize: { pt: 'x' } }).defaultTextSize).toBe('auto')
  })

  it('caps the lists', () => {
    const many = Array.from({ length: 80 }, (_, i) => `l:Font-${i}`)
    const p = sanitizePrefs({ favoriteFonts: many, recentFonts: many })
    expect(p.favoriteFonts).toHaveLength(MAX_FAVORITE_FONTS)
    expect(p.recentFonts).toEqual(many.slice(0, MAX_RECENT_FONTS))
  })

  it('isFontKey', () => {
    expect(['b:lexend', 'u:sha256-ffffffffffffffffffffffffffffffff', 'l:Menlo-Regular'].every(isFontKey)).toBe(true)
    expect(['lexend', 'b:', 'x:lexend', 'u:sha256-xyz', "l:a'b", 'l:a\\b', `l:${'a'.repeat(101)}`, null].some(isFontKey)).toBe(false)
  })
})
