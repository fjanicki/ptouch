// W3 — text measurement, auto-fit and drawing (Canvas2D metrics at the crisp-plane scale).
//
// Size semantics (`TextItem.size`, schema.ts):
// - `{mode:'mm'}` is the cap-to-descender height of the text block, from font metrics: one
//   line of "Hxg" at 5 mm has its cap top to descender bottom 5 mm apart; extra lines add
//   `lineHeight × (cap + descender)` each. Stable while typing.
// - `{mode:'pt'}` (schema 3) is the em size of every line, as in a word processor: 1 pt = 1/72 in
//   (2.5 dots at 180 dpi). How tall a line prints depends on the font.
// - `{mode:'fit'}` is the largest size whose *ink* fits the available height. "LABEL" (no
//   descenders) therefore fills the band edge to edge, "Hello g" a bit less.
// Glyph metrics scale linearly with the font size, so fitting is a division, followed by a
// re-measure at the chosen size to absorb rounding/hinting.
//
// Fonts and size (docs/FONTS-AND-SIZE-PLAN.md §3.3, P-size):
// - A fixed size (mm or pt) taller than the band is reduced to the band (warning "was reduced"),
//   like icons, instead of being cut off: the tape may change after a size was chosen.
// - "Shrink to fit length" scales every flow text block by one common factor (`scale` < 1).
// - Pixel fonts (`FontDef.pixel`) are drawn at a whole number of dots per font pixel: the em is
//   `k × emPx` dots (the largest k that fits for Fit and any reduction, else the nearest k), and
//   glyph origins, baselines and the line pitch sit on whole dots, so every font pixel prints as
//   a k × k block of dots with no grey edges to threshold.
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

/**
 * Lays out `lines` at `px`: baselines, alignment and the block box. With `grid` (px per dot, for
 * pixel fonts) the first baseline, the line pitch, the bottom and every line's origin are snapped
 * to whole multiples of `grid`, so glyphs drawn at a grid-aligned block origin sit on whole dots.
 */
export function layoutLines(lines: string[], px: number, face: FaceMetrics, lineHeight: number, align: Align, measure: MeasureFn, metricHeight: boolean, grid?: number): TextBlock {
  const snap = grid && grid > 0 ? (v: number) => Math.round(v / grid) * grid : (v: number) => v
  const snapUp = grid && grid > 0 ? (v: number) => Math.ceil(v / grid - 1e-6) * grid : (v: number) => v
  const inks = lines.map((l) => (l.trim() === '' ? ZERO : measure(l, px)))
  const capPx = face.cap * px
  const lineBox = (face.cap + face.desc) * px
  const pitch = grid ? Math.max(grid, snap(lineBox * lineHeight)) : lineBox * lineHeight
  const first = inks[0] ?? ZERO
  const last = inks[inks.length - 1] ?? ZERO
  // Above the first baseline: at least the cap height (so "...." does not grow huge).
  const top = snapUp(Math.max(capPx, first.ascent))
  const bottom = snapUp(metricHeight ? Math.max(face.desc * px, last.descent) : Math.max(0, last.descent))
  // Horizontal extent = ink (not advance): margins and gaps are measured to the printed dots.
  const spans = inks.map((m) => (m.right + m.left > 0 ? { l: -m.left, w: m.right + m.left } : { l: 0, w: 0 }))
  const width = snapUp(Math.max(0, ...spans.map((s) => s.w)))
  const out: TextLine[] = lines.map((text, i) => {
    const s = spans[i] ?? { l: 0, w: 0 }
    return { text, x: snap(alignOffset(align, width, s.w) - s.l), baseline: top + i * pitch, width: s.w }
  })
  const height = top + (lines.length - 1) * pitch + bottom
  return { fontPx: px, lines: out, width, height, lineBox }
}

/** Em size in px of a point size (1 pt = 1/72 in) at `dpi`, on a crisp plane `f` px per dot. */
export function ptToPx(pt: number, dpi: number, f = 1): number {
  return (pt * dpi * f) / 72
}

/**
 * Font size (px) for `item` in an available height `availPx`: fit → largest whose ink fits;
 * mm → `targetPx` is the requested cap-to-descender block height; pt → `emPx` is the font size.
 */
export function fitTextBlock(
  lines: string[],
  face: FaceMetrics,
  lineHeight: number,
  align: Align,
  measure: MeasureFn,
  opts: { fit: true; availPx: number } | { fit: false; targetPx: number } | { fit: false; emPx: number; grid?: number; metricHeight?: boolean },
): TextBlock {
  const n = Math.max(1, lines.length)
  if ('emPx' in opts) return layoutLines(lines, Math.max(0, opts.emPx), face, lineHeight, align, measure, opts.metricHeight ?? true, opts.grid)
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

/** Line-height multiplier as the renderer applies it (0.5–3; 1.1 when not a number). */
export function lineHeightOf(item: Pick<TextItem, 'lineHeight'>): number {
  return Math.min(3, Math.max(0.5, Number.isFinite(item.lineHeight) ? item.lineHeight : 1.1))
}

/**
 * Dots per font pixel for a pixel font (`emPx` design pixels per em) whose em would be `emDots`:
 * the largest whole number that does not exceed it when the size is a limit (Fit, a reduction,
 * shrink to fit length, a frame), else the nearest one. Never below 1.
 */
export function pixelScaleFor(emDots: number, emPx: number, limit: boolean): number {
  if (!(emPx > 0) || !(emDots > 0)) return 1
  const r = emDots / emPx
  return Math.max(1, limit ? Math.floor(r + 1e-6) : Math.round(r))
}

/** Text is never shrunk below this fraction of its size to fit a fixed length. */
/** Default crisp-plane factor (px per dot) of the renderer (`RenderOptions.factor`); the quick
 * size readouts measure with it so they match the print. */
export const DEFAULT_CRISP_FACTOR = 3

export const MIN_SHRINK = 0.1

/**
 * "Shrink to fit length": the common factor (≤ 1) for text blocks that are `textDots` long in
 * total, when the label has `availDots` between its margins and the other content (codes, icons,
 * gaps…) takes `otherDots`. 1 when everything fits already; never below `MIN_SHRINK` (the text
 * then still overflows, and the layout says so); `undefined` when shrinking the text cannot help
 * (the rest alone is too long).
 */
export function shrinkFactor(availDots: number, otherDots: number, textDots: number): number | undefined {
  if (!(textDots > 0) || otherDots + textDots <= availDots) return 1
  const room = availDots - otherDots
  if (room <= 0) return undefined
  return Math.max(MIN_SHRINK, room / textDots)
}

/** What sizing needs of a text item. */
export type TextSizing = Pick<TextItem, 'size' | 'align' | 'invert' | 'clipTall'> & { lineHeight: number }

export interface SizeEnv {
  /** Height available across the tape (the item's band), px. */
  bandPx: number
  /** px per dot (the crisp-plane factor). */
  f: number
  dpi: number
  /** Design grid of a pixel font, when its bundled face is drawn. */
  pixel?: { emPx: number } | undefined
  /** Common "shrink to fit length" factor (< 1 shrinks; never grows). */
  scale?: number
  /** Width available along the label (free-layout frame), px. */
  maxWPx?: number | undefined
}

export interface SizedTextBlock {
  block: TextBlock
  /** Invert padding, px. */
  pad: { v: number; h: number }
  /** The item's box (block + invert padding), px. */
  wPx: number
  hPx: number
  /** A fixed size taller than the band was reduced to fit it. */
  reduced: boolean
  /** Pixel font drawn on its grid: dots per font pixel. */
  pixelScale?: number
}

/**
 * Sizes a text block in a band: fit / mm / pt, then a frame width (shrink only), then the band
 * for fixed sizes (reduce only), then pixel-grid snapping. Shared by the renderer and the quick
 * size length estimates, so both agree.
 */
export function sizeTextBlock(lines: string[], face: FaceMetrics, t: TextSizing, measure: MeasureFn, env: SizeEnv): SizedTextBlock {
  const { f, dpi, bandPx } = env
  const { size, align } = t
  const lh = t.lineHeight
  const fit = size.mode === 'fit'
  const padV = t.invert ? invertPadding(bandPx, 0, f).v : 0
  const availPx = Math.max(f, bandPx - 2 * padV)
  const fitIn = (s: number): TextBlock =>
    size.mode === 'fit'
      ? fitTextBlock(lines, face, lh, align, measure, { fit: true, availPx: availPx * s })
      : size.mode === 'pt'
        ? fitTextBlock(lines, face, lh, align, measure, { fit: false, emPx: ptToPx(size.pt, dpi, f) * s })
        : fitTextBlock(lines, face, lh, align, measure, { fit: false, targetPx: ((size.mm * dpi * f) / 25.4) * s })
  const padHOf = (b: TextBlock) => (t.invert ? invertPadding(bandPx, b.lineBox, f).h : 0)
  const heightOf = (b: TextBlock) => (t.invert ? (fit ? bandPx : b.height + 2 * padV) : b.height)
  const bandDots = Math.round(bandPx / f)
  const tooTall = (b: TextBlock) => Math.ceil(heightOf(b) / f - 1e-6) > bandDots
  const tooWide = (b: TextBlock) => env.maxWPx !== undefined && b.width + 2 * padHOf(b) > env.maxWPx

  let s = env.scale ?? 1
  let limit = fit || s < 1
  let block = fitIn(s)
  // Free layout: also fit the frame's other side (shrink only).
  if (env.maxWPx !== undefined && block.width > 0 && tooWide(block)) {
    s *= Math.max(0.01, (env.maxWPx - 2 * padHOf(block)) / block.width)
    block = fitIn(s)
    limit = true
  }
  // A fixed size taller than the band is reduced to it (never clipped), except v1 labels
  // (`clipTall`), which keep their size and are cut off.
  let reduced = false
  for (let i = 0; i < 6 && !fit && !t.clipTall && block.height > 0 && tooTall(block); i++) {
    s *= (availPx / block.height) * 0.999
    block = fitIn(s)
    reduced = true
    limit = true
  }
  let pixelScale: number | undefined
  if (env.pixel && env.pixel.emPx > 0 && block.fontPx > 0) {
    const emPx = env.pixel.emPx
    const at = (k: number) => layoutLines(lines, k * emPx * f, face, lh, align, measure, !fit, f)
    let k = pixelScaleFor(block.fontPx / f, emPx, limit)
    block = at(k)
    const over = (b: TextBlock) => (fit ? b.height > availPx + 1e-6 : tooTall(b)) || tooWide(b)
    while (k > 1 && over(block)) block = at(--k)
    pixelScale = k
  }
  const padH = padHOf(block)
  return { block, pad: { v: padV, h: padH }, wPx: block.width + 2 * padH, hPx: heightOf(block), reduced, ...(pixelScale !== undefined ? { pixelScale } : {}) }
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
      advance: quantize(m.width),
      left: quantize(m.actualBoundingBoxLeft),
      right: quantize(m.actualBoundingBoxRight),
      ascent: quantize(m.actualBoundingBoxAscent),
      descent: quantize(m.actualBoundingBoxDescent),
    }
  }
}

/** Rounds a canvas metric to 1/1024 px. Full Chromium on Linux reports 5.99992 for a 6 px advance;
 * without this the pixel-font grid (`snapUp`, whole-dot widths) drifts by a dot. */
function quantize(v: number): number {
  return Math.round(v * 1024) / 1024
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

/**
 * Draws a laid-out block with its top-left at (`x`, `y`) px. With `grid` (px per dot; pixel
 * fonts) the block origin is snapped to whole dots; the lines are already on the grid.
 */
export function drawTextBlock(ctx: Ctx2D, item: FontItem, block: TextBlock, x: number, y: number, color: string, grid?: number): void {
  const ox = grid ? Math.round(x / grid) * grid : x
  const oy = grid ? Math.round(y / grid) * grid : y
  ctx.save()
  ctx.font = cssFont(item, block.fontPx)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = color
  for (const l of block.lines) if (l.text.trim() !== '') ctx.fillText(l.text, ox + l.x, oy + l.baseline)
  ctx.restore()
}

/** The design grid of `item`'s pixel font, when its bundled face is drawn (not a custom font). */
export function pixelGrid(item: FontItem): { emPx: number } | undefined {
  if (activeCustomFamily(item)) return undefined
  return fontDef(item.fontFamily).pixel
}
