// W3 — pure layout (no DOM): items + measured sizes → positions in dots. Unit-tested in node.
//
// Coordinates are canvas coordinates of the printable band: x along the label (0 = left end of
// the label as read), y across the tape (0 = top edge of the printable band).
//
// Flow rules (layout.mode = 'flow'):
// - Items run left → right from the start margin, separated by `gapMm`.
// - A spacer *replaces* the gap on both sides: `A · spacer · B` is A, spacer width, B.
// - Items with zero width (empty text) take no space and no gap.
// - Cross-axis: each item is aligned in the band by `align` (start = top, end = bottom).
// - Length auto = start margin + content + end margin. Length fixed = that length; content is
//   centred between the margins, or starts at the start margin and overflows (`overflow`).
// - The length is clamped to the printer's [minLengthDots, maxLengthDots]; when padded up to
//   the minimum the content is centred, when cut to the maximum it overflows.
// - A label frame insets the content on all sides by `insetDots` (inset + thickness + padding).
import type { Align, LabelDoc } from '../doc/schema'
import { mmToDots } from './units'

export interface MeasuredItem {
  itemId: string
  /** Natural width along the label, dots. */
  w: number
  /** Height across the tape, dots (≤ band height). */
  h: number
  /** Spacer: replaces the gaps next to it. */
  spacer?: boolean
}

export interface Placement extends MeasuredItem {
  x: number
  y: number
}

export interface FlowLayout {
  placements: Placement[]
  /** Label length in dots (auto) or the fixed length, after clamping. */
  lengthDots: number
  /** Content exceeds a fixed length (or the printer maximum). */
  overflow: boolean
  /** Length was raised to the printer minimum or cut to the maximum. */
  clamped?: 'min' | 'max'
  /** Extent of the content along the label (items + gaps), dots. */
  contentDots: number
}

export interface LayoutLimits {
  /** Shortest page (PrintArea.minLengthDots). */
  minLengthDots: number
  /** Longest page (PrintArea.maxLengthDots), if limited. */
  maxLengthDots?: number
  /** Space reserved on every side for the label frame, dots. */
  insetDots?: number
}

export function alignOffset(align: Align, outer: number, inner: number): number {
  return align === 'start' ? 0 : align === 'end' ? outer - inner : Math.round((outer - inner) / 2)
}

/** Gap (dots) and cross-axis alignment of a document's layout. */
export function flowSettings(doc: LabelDoc, dpi: number): { gap: number; align: Align } {
  return doc.layout.mode === 'flow'
    ? { gap: Math.max(0, mmToDots(doc.layout.gapMm, dpi)), align: doc.layout.align }
    : { gap: 0, align: 'center' }
}

/** Sum of item widths and the gaps between them (spacer and empty-item rules above). */
export function contentLength(items: readonly MeasuredItem[], gap: number): number {
  let total = 0
  let prev: MeasuredItem | undefined
  for (const it of items) {
    if (it.w <= 0 && !it.spacer) continue
    if (prev && !prev.spacer && !it.spacer) total += gap
    total += Math.max(0, it.w)
    prev = it
  }
  return total
}

/** Applies the printer's length limits; returns the final length and the content shift. */
function clampLength(len: number, limits: LayoutLimits | undefined): { len: number; clamped?: 'min' | 'max' } {
  const min = Math.max(1, limits?.minLengthDots ?? 1)
  const max = limits?.maxLengthDots
  if (len < min) return { len: min, clamped: 'min' }
  if (max !== undefined && len > max) return { len: max, clamped: 'max' }
  return { len }
}

export function layoutFlow(doc: LabelDoc, items: MeasuredItem[], bandDots: number, dpi: number, limits?: LayoutLimits): FlowLayout {
  const inset = Math.max(0, Math.round(limits?.insetDots ?? 0))
  const { gap, align } = flowSettings(doc, dpi)
  const start = Math.max(0, mmToDots(doc.marginsMm.start, dpi)) + inset
  const end = Math.max(0, mmToDots(doc.marginsMm.end, dpi)) + inset
  const inner = Math.max(0, bandDots - 2 * inset)
  const content = contentLength(items, gap)

  let len: number
  let x0 = start
  let overflow = false
  if (doc.length.mode === 'fixed') {
    len = Math.max(1, mmToDots(doc.length.mm, dpi))
    const avail = len - start - end
    if (content > avail) overflow = true
    else x0 = start + Math.floor((avail - content) / 2)
  } else {
    len = start + content + end
  }

  const c = clampLength(len, limits)
  if (c.clamped === 'min') x0 += Math.floor((c.len - len) / 2)
  if (c.clamped === 'max') overflow = overflow || x0 + content + end > c.len

  const placements: Placement[] = []
  let x = x0
  let prev: MeasuredItem | undefined
  for (const it of items) {
    const h = Math.min(Math.max(0, it.h), inner)
    const visible = it.w > 0 || !!it.spacer
    if (visible && prev && !prev.spacer && !it.spacer) x += gap
    placements.push({ ...it, h, x, y: inset + alignOffset(align, inner, h) })
    if (visible) {
      x += Math.max(0, it.w)
      prev = it
    }
  }
  return { placements, lengthDots: c.len, overflow, ...(c.clamped ? { clamped: c.clamped } : {}), contentDots: content }
}

/** An item placed by its own `frame` (free layout), already converted to dots. */
export interface FramedItem extends MeasuredItem {
  x: number
  y: number
}

/**
 * Free layout (v1 editor; the MVP renders each item at its `frame`). Auto length = right-most
 * item edge + end margin; fixed = that length. Overflow when an item leaves the label or band.
 */
export function layoutFree(doc: LabelDoc, items: FramedItem[], bandDots: number, dpi: number, limits?: LayoutLimits): FlowLayout {
  const end = Math.max(0, mmToDots(doc.marginsMm.end, dpi))
  const right = items.reduce((m, it) => Math.max(m, it.x + it.w), 0)
  const len = doc.length.mode === 'fixed' ? Math.max(1, mmToDots(doc.length.mm, dpi)) : right + end
  const c = clampLength(len, limits)
  const overflow = items.some((it) => it.x < 0 || it.y < 0 || it.x + it.w > c.len || it.y + it.h > bandDots)
  return {
    placements: items.map((it) => ({ ...it })),
    lengthDots: c.len,
    overflow,
    ...(c.clamped ? { clamped: c.clamped } : {}),
    contentDots: right - items.reduce((m, it) => Math.min(m, it.x), right),
  }
}
