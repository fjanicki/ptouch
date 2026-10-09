// Quick text sizes (docs/FONTS-AND-SIZE-PLAN.md §3). Signatures are frozen by the lead; P-size
// owns the bodies and may tune the fractions and the readable minimum (with tests).
//
// A quick size is a fraction of the printable band (the band the item is sized in, see
// `itemSizingBand`) for the whole text block's cap-to-descender height, snapped to whole dots
// and stored as an ordinary `{mode:'mm'}` size. It is therefore font-independent and always fits.
// When the tape width changes, the studio maps a quick size to the same quick size of the new band
// (ui/state/text-defaults.ts `retapeTextSize`: M stays M).
import type { TextItem, TextSize } from '../doc/schema'
import { context2d, createCanvas, type Ctx2D } from './canvas'
import { textFaceReady } from './fonts'
import { DEFAULT_CRISP_FACTOR, canvasMeasure, faceMetrics, lineHeightOf, pixelGrid, sizeTextBlock, splitLines } from './text'
import type { RenderResult } from './types'
import { dotsToMm, mmToDots } from './units'

export type QuickSizeId = 'xs' | 's' | 'm' | 'l' | 'fit'

export interface QuickTextSize {
  id: QuickSizeId
  /** Button text: "XS", "S", "M", "L", "Fit". */
  label: string
  /** Accessible name, starting with the button text: "XS, extra small", …, "Fit tape". */
  name: string
  /** What the button stores in `TextItem.size`. */
  size: TextSize
  /** Cap-to-descender height of the block in dots (the band for 'fit'). */
  dots: number
  /** Below the readable minimum (`MIN_READABLE_DOTS`) on this band: offered but flagged. */
  tooSmall: boolean
}

/** Fraction of the band per quick size (block height). */
export const QUICK_FRACTIONS: Readonly<Record<Exclude<QuickSizeId, 'fit'>, number>> = { xs: 1 / 4, s: 1 / 3, m: 1 / 2, l: 3 / 4 }

/** Cap-to-descender height below which one line prints poorly at 180 dpi (2 mm ≈ 14 dots;
 * the renderer's `small-text` warning uses the same 2 mm). */
export const MIN_READABLE_DOTS = 14

/** [button text, accessible name]. The name starts with the visible text (WCAG 2.5.3 Label in
 * Name: "tap XS" works with voice control) and spells it out. */
const LABELS: Record<QuickSizeId, [string, string]> = {
  xs: ['XS', 'XS, extra small'],
  s: ['S', 'S, small'],
  m: ['M', 'M, medium'],
  l: ['L', 'L, large'],
  fit: ['Fit', 'Fit tape'],
}

/** mm of `dots`, rounded to 0.01 mm (round-trips through `mmToDots`). */
function dotsMm(dots: number, dpi: number): number {
  return Math.round(dotsToMm(dots, dpi) * 100) / 100
}

/** The quick sizes for a band of `bandDots` (XS → L, then Fit). */
export function quickTextSizes(bandDots: number, dpi: number): QuickTextSize[] {
  const band = Math.max(1, Math.round(bandDots))
  const out: QuickTextSize[] = (['xs', 's', 'm', 'l'] as const).map((id) => {
    const dots = Math.max(1, Math.round(band * QUICK_FRACTIONS[id]))
    const [label, name] = LABELS[id]
    return { id, label, name, size: { mode: 'mm', mm: dotsMm(dots, dpi) }, dots, tooSmall: dots < MIN_READABLE_DOTS }
  })
  out.push({ id: 'fit', label: LABELS.fit[0], name: LABELS.fit[1], size: { mode: 'fit' }, dots: band, tooSmall: false })
  return out
}

/** The quick size `size` equals on this band (same mode and dot height), if any. */
export function matchQuickSize(size: TextSize, bandDots: number, dpi: number): QuickSizeId | undefined {
  if (size.mode === 'fit') return 'fit'
  if (size.mode !== 'mm') return undefined
  const dots = mmToDots(size.mm, dpi)
  return quickTextSizes(bandDots, dpi).find((q) => q.id !== 'fit' && q.dots === dots)?.id
}

/** What a default-size preference can hold (structurally `DefaultTextSize` of persist-prefs,
 * which the render layer may not import), minus 'auto'. */
export type DefaultSizeChoice = 'fit' | 'half' | 'third' | { pt: number }

/** Point size of an em of `emDots` at `dpi` (1 pt = 1/72 in), to the nearest half point and
 * within the schema limits (4–144 pt). */
export function emDotsToPt(emDots: number, dpi: number): number {
  const pt = Math.round(((emDots * 72) / dpi) * 2) / 2
  return Math.min(144, Math.max(4, Number.isFinite(pt) ? pt : 12))
}

/**
 * "Use for new text": the preference that gives new text blocks the size of this one. Fit and
 * the quick sizes M / S are stored as words, so they follow the tape of the next label (half /
 * a third of its band); any other size becomes its point size (`emDots`, measured), which is a
 * fixed physical size on every tape.
 */
export function defaultSizeOf(size: TextSize, bandDots: number, dpi: number, emDots: number): DefaultSizeChoice {
  if (size.mode === 'fit') return 'fit'
  if (size.mode === 'pt') return { pt: size.pt }
  const q = matchQuickSize(size, bandDots, dpi)
  if (q === 'm') return 'half'
  if (q === 's') return 'third'
  return { pt: emDotsToPt(emDots, dpi) }
}

/**
 * Estimated label length (mm) if a text block that is `fromDots` long became `toDots` long: the
 * other content does not move, so the length changes by the difference, but never below the
 * printer's minimum (`minMm`). Fixed-length labels do not change length (`fixedMm`).
 */
export function estimateLabelMm(labelMm: number, fromDots: number, toDots: number, dpi: number, minMm = 0, fixedMm?: number): number {
  if (fixedMm !== undefined) return fixedMm
  return Math.max(minMm, labelMm + dotsToMm(toDots - fromDots, dpi))
}

// ------------------------------------------------------------------------------------------
// Length readouts (TextSizeQuick) and the measured em of "Use for new text" (TextProps). A block
// is measured with the renderer's own sizing (`sizeTextBlock`, same crisp factor), so the readout
// of the current size equals what is printed. "Shrink to fit length" is not applied: on a
// fixed-length label the readouts are the text's own length.
// ------------------------------------------------------------------------------------------


let ctx: Ctx2D | undefined

function sameSize(a: TextSize, b: TextSize): boolean {
  return a.mode === b.mode && (a.mode !== 'mm' || a.mm === (b as { mm: number }).mm) && (a.mode !== 'pt' || a.pt === (b as { pt: number }).pt)
}

/** Measured instead of a blank block for its em (a fixed size's em does not depend on the text). */
const EM_SAMPLE = 'Hxg'

/** How long (dots along the label) and how large (em, dots) `item` would print at `size` in a band
 * of `bandDots`. A blank block is 0 dots long; its em is that of a one-line sample, so "Use for new
 * text" on an empty block still stores the size the user chose. */
export function measureTextAt(item: TextItem, size: TextSize, bandDots: number, dpi: number): { widthDots: number; emDots: number } {
  const blank = splitLines(item.text).every((l) => l.trim() === '')
  if (blank) return { widthDots: 0, emDots: measureTextAt({ ...item, text: EM_SAMPLE }, size, bandDots, dpi).emDots }
  const lines = splitLines(item.text)
  ctx ??= context2d(createCanvas(16, 16), false)
  const f = DEFAULT_CRISP_FACTOR
  const face = faceMetrics(ctx, item, textFaceReady(item))
  // v1 clipping (`clipTall`) only applies to the item's own size: choosing another drops it.
  const clipTall = item.clipTall && sameSize(size, item.size)
  const sized = sizeTextBlock(lines, face, { size, align: item.align, invert: item.invert, lineHeight: lineHeightOf(item), ...(clipTall ? { clipTall } : {}) }, canvasMeasure(ctx, item), {
    bandPx: Math.max(1, bandDots) * f,
    f,
    dpi,
    pixel: pixelGrid(item),
  })
  return { widthDots: Math.ceil(sized.wPx / f - 1e-6), emDots: sized.block.fontPx / f }
}

export interface ReadoutInput {
  /** The block as the preview shows it (placeholders filled). */
  shown: TextItem
  /** Its stored size and the quick size it matches, if any. */
  size: TextSize
  current: string | undefined
  sizes: readonly QuickTextSize[]
  band: { dots: number; dpi: number; minMm: number }
  render: Pick<RenderResult, 'lengthMm' | 'texts'>
  /** The label grows with the text (auto length, flow); else the readouts are text lengths. */
  grows: boolean
}

/** "≈ 31 mm" per quick size (the current one exact, "31 mm"); empty before the block rendered. */
export function quickReadouts(o: ReadoutInput): string[] {
  const info = o.render.texts?.find((t) => t.itemId === o.shown.id)
  if (!info) return []
  const { dots, dpi, minMm } = o.band
  const from = measureTextAt(o.shown, o.size, dots, dpi).widthDots
  return o.sizes.map((q) => {
    const now = q.id === o.current
    const to = now ? from : measureTextAt(o.shown, q.size, dots, dpi).widthDots
    const mm = o.grows ? estimateLabelMm(o.render.lengthMm, from, to, dpi, minMm) : dotsToMm(now ? info.widthDots : to, dpi)
    return `${now ? '' : '≈ '}${Math.round(mm)} mm`
  })
}
