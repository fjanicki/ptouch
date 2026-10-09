// Font picker model (docs/FONTS-AND-SIZE-PLAN.md §2). The exported signatures are frozen by the
// lead; P-picker owns this file and adds what the picker needs (search, grouping…).
import type { FontFamilyId, FontSource, FontWeight, TextItem } from '../../doc/schema'
import { MAX_FAVORITE_FONTS, MAX_RECENT_FONTS, type FontKey } from '../../doc/persist-prefs'
import { fontDef, resolveWeight } from '../../render'

/** What choosing a font changes on a text block: a bundled family (custom font cleared, weight
 * moved to the nearest one the family has) or a custom font (the bundled family stays as the
 * fallback). Passed to `studio.updateItem`. */
export type FontPatch = { fontFamily: FontFamilyId; fontWeight: FontWeight; customFont: undefined } | { customFont: FontSource }

/** The picker key of the font a block draws with (`b:` bundled, `u:` uploaded, `l:` local). */
export function fontKeyOf(item: Pick<TextItem, 'fontFamily' | 'customFont'>): FontKey {
  const c = item.customFont
  if (!c) return `b:${item.fontFamily}`
  return c.kind === 'user' ? `u:${c.ref}` : `l:${c.postscriptName}`
}

/** Patch for choosing bundled family `id`: keeps the weight when the family has it, else the
 * nearest one (ties go to the lighter weight). */
export function familyPatch(item: Pick<TextItem, 'fontWeight'>, id: FontFamilyId): FontPatch {
  return { fontFamily: id, fontWeight: resolveWeight(fontDef(id), item.fontWeight), customFont: undefined }
}

/** Recent fonts after picking `key`: moved to the front, deduplicated, capped. */
export function pushRecent(recent: readonly FontKey[], key: FontKey): FontKey[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, MAX_RECENT_FONTS)
}

/** Favourites after starring / unstarring `key` (new stars go last; a full list stays as is). */
export function toggleFavorite(favorites: readonly FontKey[], key: FontKey): FontKey[] {
  if (favorites.includes(key)) return favorites.filter((k) => k !== key)
  return favorites.length >= MAX_FAVORITE_FONTS ? [...favorites] : [...favorites, key]
}
