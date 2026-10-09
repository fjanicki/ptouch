// W3 — text measurement, auto-fit and drawing (Canvas2D metrics at the crisp-plane scale).
//
// Size semantics (`TextItem.size`, schema.ts):
// - `{mode:'mm'}` is the cap-to-descender height of the text block, from font metrics: one
//   line of "Hxg" at 5 mm has its cap top to descender bottom 5 mm apart; extra lines add
//   `lineHeight × (cap + descender)` each. Stable while typing.
// - `{mode:'fit'}` is the largest size whose *ink* fits the available height. "LABEL" (no
//   descenders) therefore fills the band edge to edge, "Hello g" a bit less.
// Glyph metrics scale linearly with the font size, so fitting is a division, followed by a
// re-measure at the chosen size to absorb rounding/hinting.
//
// Pure functions take a `measure` callback so they are unit-testable in node.
import type { Align, TextItem } from '../doc/schema'
import { activeCustomFamily, faceCss, fontDef, resolveWeight } from './fonts'
import type { Ctx2D } from './canvas'
import { alignOffset } from './layout'

/** Ink and advance of one line at some font size (canvas `TextMetrics` subset). */
export interface LineInk {
  advance: number
  /** Ink extent left of the origin (positive = left of it). */
  left: number
  /** Ink extent right of the origin. */
  right: number
  /** Ink above the baseline. */
  ascent: number
  /** Ink below the baseline. */
  descent: number
}

/** Font metrics per 1 px of font size. */
export interface FaceMetrics {
  /** Cap height ("H" ascent). */
  cap: number
  /** Descender depth ("gjpqy" descent). */
  desc: number
}

/** Measures `text` at `px` (canvas pixels). */
export type MeasureFn = (text: string, px: number) => LineInk

export interface TextLine {
  text: string
  /** Origin x relative to the block's left edge, px. */
  x: number
  /** Baseline relative to the block's top edge, px. */
  baseline: number
  width: number
}

export interface TextBlock {
  fontPx: number
  lines: TextLine[]
  /** Block width (ink) / height, px (no invert padding). */
  width: number
  height: number
  /** Cap-to-descender height of one line (font metrics), px. */
  lineBox: number
}

/** Splits into lines (`\n`, `\r\n`); trailing whitespace kept for advance, never empty array. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

const ZERO: LineInk = { advance: 0, left: 0, right: 0, ascent: 0, descent: 0 }

/** Lays out `lines` at `px`: baselines, alignment and the block box. */
export function layoutLines(lines: string[], px: number, face: FaceMetrics, lineHeight: number, align: Align, measure: MeasureFn, metricHeight: boolean): TextBlock {
  const inks = lines.map((l) => (l.trim() === '' ? ZERO : measure(l, px)))
  const capPx = face.cap * px
  const lineBox = (face.cap + face.desc) * px
  const pitch = lineBox * lineHeight
  const first = inks[0] ?? ZERO
  const last = inks[inks.length - 1] ?? ZERO
  // Above the first baseline: at least the cap height (so "...." does not grow huge).
  const top = Math.max(capPx, first.ascent)
  const bottom = metricHeight ? Math.max(face.desc * px, last.descent) : Math.max(0, last.descent)
  // Horizontal extent = ink (not advance): margins and gaps are measured to the printed dots.
  const spans = inks.map((m) => (m.right + m.left > 0 ? { l: -m.left, w: m.right + m.left } : { l: 0, w: 0 }))
  const width = Math.max(0, ...spans.map((s) => s.w))
  const out: TextLine[] = lines.map((text, i) => {
    const s = spans[i] ?? { l: 0, w: 0 }
    return { text, x: alignOffset(align, width, s.w) - s.l, baseline: top + i * pitch, width: s.w }
  })
  const height = top + (lines.length - 1) * pitch + bottom
  return { fontPx: px, lines: out, width, height, lineBox }
}

/**
 * Font size (px) for `item` in an available height `availPx`: fit → largest whose ink fits;
 * mm → `targetPx` is the requested cap-to-descender block height.
 */
export function fitTextBlock(lines: string[], face: FaceMetrics, lineHeight: number, align: Align, measure: MeasureFn, opts: { fit: true; availPx: number } | { fit: false; targetPx: number }): TextBlock {
  const n = Math.max(1, lines.length)
  if (!opts.fit) {
    // Cap-to-descender of the block = (cap + desc)·px·(1 + (n−1)·lineHeight).
    const per = (face.cap + face.desc) * (1 + (n - 1) * lineHeight)
    const px = per > 0 ? opts.targetPx / per : 0
    return layoutLines(lines, px, face, lineHeight, align, measure, true)
  }
  const ref = 100
  let block = layoutLines(lines, ref, face, lineHeight, align, measure, false)
  let px = block.height > 0 ? (ref * opts.availPx) / block.height : 0
  for (let i = 0; i < 4 && px > 0; i++) {
    block = layoutLines(lines, px, face, lineHeight, align, measure, false)
    if (block.height <= opts.availPx + 1e-6) break
    px *= (opts.availPx / block.height) * 0.999
  }
  return block
}

// ------------------------------------------------------------------------------------------
// Canvas-backed measuring
// ------------------------------------------------------------------------------------------

const faceCache = new Map<string, FaceMetrics>()

/** What text.ts needs of an item to pick its face (`customFont` wins once it has loaded, P4). */
export type FontItem = Pick<TextItem, 'fontFamily' | 'fontWeight' | 'italic'> & Partial<Pick<TextItem, 'customFont'>>

export function itemFont(item: FontItem): { family: string; weight: ReturnType<typeof resolveWeight>; italic: boolean } {
  const def = fontDef(item.fontFamily)
  return { family: activeCustomFamily(item) ?? def.family, weight: resolveWeight(def, item.fontWeight), italic: item.italic }
}

/**
 * CSS font shorthand for an item at `px`: its loaded custom font (one file for every weight,
 * so the weight only matters for the fallback), else the exact bundled face.
 */
export function cssFont(item: FontItem, px: number): string {
  const def = fontDef(item.fontFamily)
  const custom = activeCustomFamily(item)
  const bundled = faceCss(def, resolveWeight(def, item.fontWeight), px, item.italic)
  return custom ? bundled.replace(`"${def.family}"`, `"${custom}", "${def.family}"`) : bundled
}

/** A `MeasureFn` for `item`'s face on `ctx`. */
export function canvasMeasure(ctx: Ctx2D, item: FontItem): MeasureFn {
  return (text, px) => {
    ctx.font = cssFont(item, px)
    const m = ctx.measureText(text)
    return {
      advance: m.width,
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
    }
  }
}

/** Cap height and descender of `item`'s face (per px), cached per face. */
export function faceMetrics(ctx: Ctx2D, item: FontItem, fontReady: boolean): FaceMetrics {
  const key = `${cssFont(item, 100)}|${fontReady ? 1 : 0}`
  const hit = faceCache.get(key)
  if (hit) return hit
  const measure = canvasMeasure(ctx, item)
  const cap = measure('H', 100).ascent / 100
  const desc = measure('gjpqy', 100).descent / 100
  const fm: FaceMetrics = { cap: cap > 0 ? cap : 0.7, desc: desc > 0 ? desc : 0.2 }
  // Only cache real metrics: a fallback face measured before the font arrived must not stick.
  if (fontReady) faceCache.set(key, fm)
  return fm
}

/** Invert padding (px) around a text block of `lineBox` in a band of `bandPx`. */
export function invertPadding(bandPx: number, lineBoxPx: number, factor: number): { v: number; h: number } {
  const v = Math.max(factor, Math.round(Math.min(bandPx * 0.1, 10 * factor)))
  const h = Math.max(2 * factor, Math.round(lineBoxPx * 0.25))
  return { v, h }
}

/** Draws a laid-out block with its top-left at (`x`, `y`) px. */
export function drawTextBlock(ctx: Ctx2D, item: FontItem, block: TextBlock, x: number, y: number, color: string): void {
  ctx.save()
  ctx.font = cssFont(item, block.fontPx)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = color
  for (const l of block.lines) if (l.text.trim() !== '') ctx.fillText(l.text, x + l.x, y + l.baseline)
  ctx.restore()
}
