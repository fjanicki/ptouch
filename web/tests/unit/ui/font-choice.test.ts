// Font picker model (docs/FONTS-AND-SIZE-PLAN.md §2): keys, family switch, recent, favourites.
import { describe, expect, it } from 'vitest'
import { MAX_FAVORITE_FONTS, MAX_RECENT_FONTS, isFontKey } from '../../../src/doc/persist-prefs'
import { createItem } from '../../../src/doc/schema'
import { familyPatch, fontKeyOf, pushRecent, toggleFavorite } from '../../../src/ui/fonts/font-choice'

describe('font choice', () => {
  it('fontKeyOf: bundled, uploaded and local fonts', () => {
    const t = createItem('text')
    expect(fontKeyOf(t)).toBe('b:fira-sans')
    expect(fontKeyOf({ ...t, customFont: { kind: 'user', ref: 'sha256-0123456789abcdef0123456789abcdef', family: 'X' } })).toBe('u:sha256-0123456789abcdef0123456789abcdef')
    expect(fontKeyOf({ ...t, customFont: { kind: 'local', postscriptName: 'Menlo-Bold', family: 'Menlo' } })).toBe('l:Menlo-Bold')
    expect(isFontKey(fontKeyOf(t))).toBe(true)
  })

  it('familyPatch keeps the weight when the family has it, else the nearest, and clears a custom font', () => {
    expect(familyPatch({ fontWeight: 600 }, 'archivo-narrow')).toEqual({ fontFamily: 'archivo-narrow', fontWeight: 600, customFont: undefined })
    expect(familyPatch({ fontWeight: 600 }, 'jetbrains-mono')).toEqual({ fontFamily: 'jetbrains-mono', fontWeight: 700, customFont: undefined })
    expect(familyPatch({ fontWeight: 500 }, 'jetbrains-mono')).toMatchObject({ fontWeight: 400 })
  })

  it('pushRecent moves to the front, dedupes and caps', () => {
    expect(pushRecent(['b:a', 'b:b'], 'b:b')).toEqual(['b:b', 'b:a'])
    const many = Array.from({ length: 20 }, (_, i) => `l:F${i}`)
    expect(pushRecent(many, 'l:new')).toHaveLength(MAX_RECENT_FONTS)
    expect(pushRecent(many, 'l:new')[0]).toBe('l:new')
  })

  it('toggleFavorite adds last, removes, and never grows past the cap', () => {
    expect(toggleFavorite(['b:a'], 'b:b')).toEqual(['b:a', 'b:b'])
    expect(toggleFavorite(['b:a', 'b:b'], 'b:a')).toEqual(['b:b'])
    const full = Array.from({ length: MAX_FAVORITE_FONTS }, (_, i) => `l:F${i}`)
    expect(toggleFavorite(full, 'l:new')).toEqual(full)
  })
})
