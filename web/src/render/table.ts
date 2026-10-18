// Tables (docs/TABLE-PLAN.md §2) — sizing warnings and drawing on the crisp plane. Lazy chunk:
// render/table-set.ts loads it the first time a label with a table renders; renderer.ts measures
// with the table's font stack (`tableFont`) and passes it in, then treats the result like any
// flow block. Imports nothing at run time but table-layout.ts (see there).
import type { TableItem } from '../doc/schema'
import type { Ctx2D } from './canvas'
import { layoutTable, type TableLayout } from './table-layout'
import type { FaceMetrics, MeasureFn } from './text'
import type { RenderWarning, TextRenderInfo } from './types'

export { layoutTable, gridDots, evenEdges, type TableLayout, type Rect, type CellText } from './table-layout'

/** Below this text height (mm) a table prints poorly (the renderer's `small-text` rule). */
const SMALL_TEXT_MM = 2

export interface TableCtx {
  f: number
  dpi: number
  /** Face metrics, measuring and CSS `font` with the table's font stack (renderer `tableFont`). */
  face: FaceMetrics
  measure: MeasureFn
  font: (px: number) => string
  /** Pixel font grid (text.ts `pixelGrid`). */
  pixel: { emPx: number } | undefined
  warn: (w: RenderWarning) => void
  /** The renderer's `font-quality` rule for a cap height (dots). */
  quality: (capDots: number) => void
  /** The machine cuts between the columns (cutBetween, Cut each and a cutter). */
  cut: boolean
}

/** What the renderer needs of a table (its `Prepared`). */
export interface PreparedTable {
  id: string
  w: number
  h: number
  crisp?: (ctx: Ctx2D, w: number, h: number, f: number) => void
  text?: TextRenderInfo
  cuts?: number[]
  layout?: TableLayout
}

const MESSAGES = {
  rows: 'Table text is larger than its rows on this tape and was reduced to fit.',
  width: 'Text was made smaller to fit the column width.',
  band: 'Text was made smaller to fit across the tape.',
  piece: 'Text was made smaller to fit the piece length.',
} as const

/** Measures and lays out `item` in a band of `band` dots, with its draw callback. */
export function prepareTable(item: TableItem, band: number, c: TableCtx): PreparedTable {
  const { f, dpi } = c
  const L = layoutTable(item, c.face, c.measure, { band, f, dpi, pixel: c.pixel, cut: c.cut })
  if (!L) return { id: item.id, w: 0, h: 0 }
  const textMm = (L.boxDots * 25.4) / dpi
  if (textMm < SMALL_TEXT_MM) c.warn({ code: 'small-text', itemId: item.id, message: `Table text is only ${textMm.toFixed(1)} mm tall and may be hard to read. Use fewer rows or wider tape.` })
  if (L.reduced) c.warn({ code: 'content-overflow', itemId: item.id, message: MESSAGES[L.reduced] })
  c.quality(L.capDots)
  const font = c.font(L.emPx)
  return {
    id: item.id,
    w: L.w,
    h: L.h,
    layout: L,
    ...(L.cuts.length ? { cuts: L.cuts } : {}),
    text: { itemId: item.id, emDots: L.emPx / f, capDots: L.capDots, widthDots: L.w, ...(L.pixelScale !== undefined && !item.italic ? { pixelScale: L.pixelScale } : {}) },
    crisp: (ctx, _w, _h, pf) => {
      ctx.fillStyle = '#000'
      for (const r of [...L.lines, ...L.marks]) ctx.fillRect(r.x * pf, r.y * pf, r.w * pf, r.h * pf)
      ctx.font = font
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      if (!L.turn) {
        for (const t of L.cells) ctx.fillText(t.text, t.x, t.y)
        return
      }
      // Across: each piece's block turned a quarter with an exact matrix (whole-dot origin), so
      // every piece is the same up to a whole-dot translation.
      const P = L.piece ?? 0
      for (let col = 0; col < L.edges.length - 1; col++) {
        const x0 = L.edges[col] ?? 0
        ctx.save()
        if (L.turn === 90) ctx.transform(0, 1, -1, 0, (x0 + P) * pf, 0)
        else ctx.transform(0, -1, 1, 0, x0 * pf, L.h * pf)
        for (const t of L.cells) if (t.c === col) ctx.fillText(t.text, t.x, t.y)
        ctx.restore()
      }
    },
  }
}
