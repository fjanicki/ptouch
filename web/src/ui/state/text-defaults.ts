// Lead-owned (docs/FONTS-AND-SIZE-PLAN.md §3): the font and size of a NEW text block, from the
// user's preferences and the tape. Existing blocks and documents never change. Pure; the Studio
// applies it in `insert('text')` and to the text block of a new label.
//
// Default size 'auto': on 3.5–9 mm tape the printable band is only 3.4–7 mm, so "Fit" is already
// a normal reading size and anything smaller trips the 2 mm legibility limit. From 12 mm up, Fit
// makes text 10–18 mm tall: "Hello" took 4 cm of 12 mm tape. Half the band (M: 5 mm on 12 mm,
// 9 mm on 24 mm) is still easy to read and roughly halves the length of short words.
import type { TapeWidthMm, TextItem, TextSize } from '../../doc/schema'
import type { DefaultTextSize, Prefs } from '../../doc/persist-prefs'
import { fontDef, resolveWeight } from '../../render'
import { matchQuickSize, quickTextSizes } from '../../render/text-size'

/** Narrowest tape on which 'auto' picks half height instead of fit. */
export const AUTO_HALF_MIN_TAPE_MM = 12

/** Printable band in dots per tape width on the PT-P710BT (180 dpi), for when the wasm core (and
 * so the exact print area) is not loaded yet. */
export const FALLBACK_BAND_DOTS: Readonly<Record<TapeWidthMm, number>> = { 3.5: 24, 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 }

/** The `TextSize` a preference stands for on this tape / band. */
export function resolveDefaultTextSize(pref: DefaultTextSize, tapeWidthMm: TapeWidthMm, bandDots: number, dpi: number): TextSize {
  if (typeof pref === 'object') return { mode: 'pt', pt: pref.pt }
  const word = pref === 'auto' ? (tapeWidthMm >= AUTO_HALF_MIN_TAPE_MM ? 'half' : 'fit') : pref
  if (word === 'fit') return { mode: 'fit' }
  const q = quickTextSizes(bandDots, dpi).find((s) => s.id === (word === 'half' ? 'm' : 's'))
  return q ? q.size : { mode: 'fit' }
}

/** Font and size fields of a new text block. */
export function newTextDefaults(prefs: Pick<Prefs, 'defaultFont' | 'defaultTextSize'>, tapeWidthMm: TapeWidthMm, bandDots: number, dpi: number): Pick<TextItem, 'fontFamily' | 'fontWeight' | 'size'> {
  const def = fontDef(prefs.defaultFont.family)
  return {
    fontFamily: def.id,
    fontWeight: resolveWeight(def, prefs.defaultFont.weight),
    size: resolveDefaultTextSize(prefs.defaultTextSize, tapeWidthMm, bandDots, dpi),
  }
}

function sameTextSize(a: TextSize, b: TextSize): boolean {
  if (a.mode === 'fit' || b.mode === 'fit') return a.mode === b.mode
  if (a.mode === 'mm') return b.mode === 'mm' && a.mm === b.mm
  return b.mode === 'pt' && a.pt === b.pt
}

/**
 * A text block's size after the tape width changes (tape picker, "Use loaded tape", an untouched
 * label following the cassette). A quick size of the old band (XS–L, which is also how the M / S
 * default of new text is stored) becomes the same quick size of the new band: M stays M instead
 * of filling a narrower tape (or being reduced to it). `fresh` (an untouched label): its text
 * still has `from`, the default of the old tape, so it gets `to`, the default of the new one
 * ('auto' is Fit below 12 mm). Fit, point sizes and other fixed sizes are kept.
 */
export function retapeTextSize(size: TextSize, oldBandDots: number, newBandDots: number, dpi: number, fresh?: { from: TextSize; to: TextSize }): TextSize {
  if (fresh && sameTextSize(size, fresh.from)) return fresh.to
  const q = matchQuickSize(size, oldBandDots, dpi)
  if (q === undefined || q === 'fit') return size
  return quickTextSizes(newBandDots, dpi).find((s) => s.id === q)?.size ?? size
}
