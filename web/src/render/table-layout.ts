// Tables (docs/TABLE-PLAN.md §2) — pure geometry and sizing, no DOM: a `TableItem` and a
// `measure` callback → the table's length, column/piece edges, grid lines, cut marks, the one em
// size of every cell and each cell's text origin. Unit-tested in node with a fake measure
// (tests/unit/render/table-layout.test.ts); drawn by render/table.ts. Part of the lazy "table"
// chunk (render/table-set.ts).
//
// Units: dots for geometry (whole dots everywhere: column edges, row edges, lines), canvas px
// (`f` px per dot) for the em and the text origins, which are snapped to whole dots so the same
// string prints with the same dots in every cell, row and piece.
//
// Along (rows across the tape, columns along it): row k spans [round(k·H/R), round((k+1)·H/R)).
// Across: every column is one piece of length P along the tape; inside it the column's cells are
// the lines of a small text block W = H wide (across the tape) and P long, and that block is
// turned a quarter: 'across-down' (+90°: reads from the top tape edge down, row 1 at the piece's
// right end), 'across-up' (270°: reads from the bottom edge up, row 1 at the left end). Every
// piece then has the same dots (a quarter turn maps the dot grid onto itself).
//
// The lazy chunk imports nothing at run time from the renderer's modules (their code stays in the
// entry chunk instead of being split into a shared one): the tiny unit helpers are repeated here
// and the renderer passes the measuring in.
import type { Align, TableItem } from '../doc/schema'
import type { FaceMetrics, LineInk, MeasureFn } from './text'

/** units.ts `mmToDots`. */
const mmToDots = (mm: number, dpi: number): number => Math.round((mm * dpi) / 25.4)

/** Dot rectangle in label space (x along, y across the band). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One non-empty cell: its text and its origin / baseline in px. Along: label space (the table's
 * box). Across: the block space of its piece (x across the tape, y along the piece). */
export interface CellText {
  r: number
  c: number
  text: string
  x: number
  y: number
}

export interface TableEnv {
  /** Height across the tape the table gets (dots). */
  band: number
  /** px per dot. */
  f: number
  dpi: number
  /** Pixel font grid (bundled pixel family). */
  pixel?: { emPx: number } | undefined
  /** The machine cuts between columns: every piece gets its own box, no cut marks. */
  cut?: boolean
}

export type TableReduced = 'rows' | 'width' | 'band' | 'piece'

export interface TableLayout {
  /** Length along the tape (dots). */
  w: number
  /** = the band (dots). */
  h: number
  /** Column (along) / piece (across) edges along the tape: 0 … w, C + 1 entries. */
  edges: number[]
  /** Row edges: across the band (along) / along each piece from its row-1 end (across). */
  rows: number[]
  /** Em size of every cell, px. */
  emPx: number
  /** Cap-to-descender ink box of a line (the text height), dots. */
  boxDots: number
  /** Cap height, dots. */
  capDots: number
  lines: Rect[]
  marks: Rect[]
  cells: CellText[]
  /** Internal piece edges the printer cuts at (only with `env.cut`). */
  cuts: number[]
  /** Quarter turn of every piece (across). */
  turn?: 90 | 270
  /** Piece length (across), dots. */
  piece?: number
  /** A fixed size or the table's font was reduced to fit (which constraint). */
  reduced?: TableReduced
  /** Dots per font pixel when a pixel font was snapped. */
  pixelScale?: number
}

/** Where row `k` of piece `c` is along the tape (across tables), `[start, end)` in dots: row 1 at
 * the piece's right end for 'across-down' (90°), at its left end for 'across-up' (270°). */
export function acrossRowSpan(L: Pick<TableLayout, 'edges' | 'rows' | 'turn' | 'piece'>, c: number, k: number): [number, number] {
  const p0 = L.edges[c] ?? 0
  const a = L.rows[k] ?? 0
  const b = L.rows[k + 1] ?? a
  const P = L.piece ?? 0
  return L.turn === 90 ? [p0 + P - b, p0 + P - a] : [p0 + a, p0 + b]
}

/** Grid line thickness: 0.25 mm, at least one dot (2 at 180 dpi, 4 at 360). */
export function gridDots(dpi: number): number {
  return Math.max(1, mmToDots(0.25, dpi))
}

/** Offset of `inner` in `outer` (px, unrounded). */
function alignIn(align: Align, outer: number, inner: number): number {
  return align === 'start' ? 0 : align === 'end' ? outer - inner : (outer - inner) / 2
}

/** Even split of `len` into `n` parts at whole dots. */
export function evenEdges(len: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, k) => Math.round((k * len) / n))
}

/** Space a line of thickness `t` takes inside segment k of n (top / bottom), dots: the outer
 * lines are inside the table, inner lines are centred on the edge (`[e − ⌊t/2⌋, … + t)`). With
 * `own`, every segment is boxed on its own (both sides get `t`). */
function losses(k: number, n: number, t: number, own: boolean): [number, number] {
  const half = Math.floor(t / 2)
  if (own) return [t, t]
  return [k === 0 ? t : t - half, k === n - 1 ? t : half]
}

interface Metrics {
  inks: Map<string, LineInk>
  asc: number
  desc: number
}

/**
 * Lays out `item` (cells already rectangular, as validated). Returns undefined when every cell is
 * empty (nothing to print: the table takes no space, like an empty text block).
 */
export function layoutTable(item: Pick<TableItem, 'cells' | 'size' | 'align' | 'direction' | 'columns' | 'paddingMm' | 'grid' | 'cutMarks'>, face: FaceMetrics, measure: MeasureFn, env: TableEnv): TableLayout | undefined {
  const { f, dpi } = env
  const H = Math.max(1, Math.round(env.band))
  const cells = item.cells.length ? item.cells : [['']]
  const R = cells.length
  const C = Math.max(1, ...cells.map((r) => r.length))
  const texts = [...new Set(cells.flat().filter((s) => s.trim() !== ''))]
  if (!texts.length) return undefined
  const across = item.direction !== 'along'
  const own = !!env.cut
  const t = item.grid ? gridDots(dpi) : 0
  const padH = Math.max(0, mmToDots(item.paddingMm, dpi))
  const fixedLen = item.columns.mode === 'mm' ? Math.max(1, mmToDots(item.columns.mm, dpi)) : undefined

  const metricsAt = (em: number): Metrics => {
    const inks = new Map<string, LineInk>()
    let asc = face.cap * em
    let desc = 0
    for (const s of texts) {
      const m = measure(s, em)
      inks.set(s, m)
      asc = Math.max(asc, m.ascent)
      desc = Math.max(desc, m.descent)
    }
    return { inks, asc, desc }
  }
  const inkW = (m: Metrics, s: string): number => {
    const i = m.inks.get(s)
    return i ? Math.max(0, i.left + i.right) : 0
  }
  /** Widest ink per column (px). */
  const colInk = (m: Metrics): number[] => Array.from({ length: C }, (_, c) => Math.max(0, ...cells.map((row) => inkW(m, row[c] ?? ''))))

  // Rows: along they split the band; across they split the piece (P), fixed or from the text.
  const rowPad = (len: number): number => Math.max(1, Math.round(0.08 * len))
  const rowAvail = (edges: number[]): { avail: number[]; pad: number } => {
    const heights = edges.slice(1).map((e, k) => e - (edges[k] ?? 0))
    const pad = rowPad(Math.min(...heights))
    return { avail: heights.map((h, k) => h - losses(k, R, t, false).reduce((a, b) => a + b, 0) - 2 * pad), pad }
  }
  const alongRows = across ? undefined : rowAvail(evenEdges(H, R))
  const pieceRows = across && fixedLen !== undefined ? rowAvail(evenEdges(fixedLen, R)) : undefined
  const heightCap = (alongRows ?? pieceRows) ? Math.max(1, Math.min(...(alongRows ?? pieceRows)!.avail)) * f : undefined

  // Width caps (px): across, every cell reads across the band; along with fixed columns, every
  // column is the fixed width.
  const colLoss = (c: number): number => losses(c, C, t, own).reduce((a, b) => a + b, 0)
  const widthCaps: (number | undefined)[] = Array.from({ length: C }, (_, c) => {
    if (across) return Math.max(1, H - 2 * t - 2 * padH) * f
    if (fixedLen !== undefined) return Math.max(1, fixedLen - colLoss(c) - 2 * padH) * f
    return undefined
  })

  const boxOf = (m: Metrics): number => m.asc + m.desc
  const over = (m: Metrics): number => {
    // The largest factor (≤ 1) that brings the text within every cap; 1 when it fits.
    let s = 1
    if (heightCap !== undefined && boxOf(m) > heightCap + 1e-6) s = Math.min(s, heightCap / boxOf(m))
    colInk(m).forEach((w, c) => {
      const cap = widthCaps[c]
      if (cap !== undefined && w > cap + 1e-6) s = Math.min(s, cap / w)
    })
    return s
  }

  // Em: fit = the largest that fits every cap; pt / mm = the given size, reduced to fit.
  const ref = 100
  const refM = metricsAt(ref)
  const size = item.size
  const fit = size.mode === 'fit'
  let em: number
  if (fit) {
    const caps: number[] = []
    if (heightCap !== undefined && boxOf(refM) > 0) caps.push((ref * heightCap) / boxOf(refM))
    colInk(refM).forEach((w, c) => {
      const cap = widthCaps[c]
      if (cap !== undefined && w > 0) caps.push((ref * cap) / w)
    })
    em = caps.length ? Math.min(...caps) : ref
  } else {
    em = size.mode === 'pt' ? (size.pt * dpi * f) / 72 : (size.mm * dpi * f) / 25.4 / Math.max(0.01, face.cap + face.desc)
  }
  /** Which cap a too-large size is reduced for (the warning). */
  const reason = (x: Metrics): TableReduced => (heightCap !== undefined && boxOf(x) > heightCap + 1e-6 ? (across ? 'piece' : 'rows') : across ? 'band' : 'width')
  let m = metricsAt(em)
  // Fit along with fixed columns: the row height would make a cell wider than its column.
  let reducedBy: TableReduced | undefined = fit && fixedLen !== undefined && !across && heightCap !== undefined && over(metricsAt((ref * heightCap) / Math.max(1e-6, boxOf(refM)))) < 1 ? 'width' : undefined
  for (let i = 0; i < 6; i++) {
    const s = over(m)
    if (s >= 1) break
    if (!fit) reducedBy ??= reason(m)
    em *= s * (i === 0 ? 1 : 0.995)
    m = metricsAt(em)
  }

  // Pixel fonts: a whole number of dots per font pixel (never larger than what fits).
  let pixelScale: number | undefined
  if (env.pixel && env.pixel.emPx > 0 && em > 0) {
    const emPx = env.pixel.emPx
    // text.ts `pixelScaleFor`: the largest whole scale that fits when the size is a limit.
    const ratio = em / f / emPx
    let k = Math.max(1, fit || reducedBy !== undefined ? Math.floor(ratio + 1e-6) : Math.round(ratio))
    m = metricsAt(k * emPx * f)
    while (k > 1 && over(m) < 1) m = metricsAt(--k * emPx * f)
    em = k * emPx * f
    pixelScale = k
  }

  const snap = (px: number): number => Math.round(px / f) * f
  const box = boxOf(m)
  const boxDots = box / f
  const cellsOut: CellText[] = []
  /** Origin x (px) of `s` in a span [x0, x0 + w) px, its ink kept inside when there is room. */
  const originX = (s: string, x0: number, w: number): number => {
    const ink = m.inks.get(s)
    if (!ink) return x0
    const iw = ink.left + ink.right
    const want = snap(x0 + alignIn(item.align, w, iw) + ink.left)
    const lo = Math.ceil((x0 + ink.left) / f - 1e-6) * f
    const hi = Math.floor((x0 + w - iw + ink.left) / f + 1e-6) * f
    return lo <= hi ? Math.min(hi, Math.max(lo, want)) : want
  }
  /** Baselines (px) of the R rows between `edges` (dots). */
  const baselines = (edges: number[], pad: number): number[] =>
    edges.slice(0, R).map((e, k) => {
      const [top, bot] = losses(k, R, t, false)
      const avail = ((edges[k + 1] ?? e) - e - top - bot - 2 * pad) * f
      return snap((e + top + pad) * f + (avail - box) / 2 + m.asc)
    })

  const lines: Rect[] = []
  const vline = (x: number, w: number): void => void lines.push({ x, y: 0, w, h: H })
  let edges: number[]
  let rows: number[]
  let piece: number | undefined
  const half = Math.floor(t / 2)

  if (!across) {
    // Column widths: widest ink + padding + the lines inside the column.
    const inkDots = colInk(m).map((w) => Math.ceil(w / f - 1e-6))
    const need = inkDots.map((w, c) => (w > 0 ? w + 2 * padH : Math.max(2 * padH, Math.round(em / f / 2))) + colLoss(c))
    const widths = fixedLen !== undefined ? need.map(() => fixedLen) : item.columns.mode === 'equal' ? need.map(() => Math.max(...need)) : need
    edges = [0]
    for (const w of widths) edges.push((edges[edges.length - 1] ?? 0) + w)
    rows = evenEdges(H, R)
    const base = baselines(rows, alongRows?.pad ?? 1)
    cells.forEach((row, r) =>
      row.forEach((s, c) => {
        if (s.trim() === '') return
        const [l, rr] = losses(c, C, t, own)
        const x0 = ((edges[c] ?? 0) + l + padH) * f
        const w = ((edges[c + 1] ?? 0) - (edges[c] ?? 0) - l - rr - 2 * padH) * f
        cellsOut.push({ r, c, text: s, x: originX(s, x0, w), y: base[r] ?? 0 })
      }),
    )
    if (t > 0) for (const y of rows.slice(1, -1)) lines.push({ x: 0, y: y - half, w: edges[C] ?? 0, h: t })
  } else {
    // Pieces: fixed length, or R rows of (text + padding + the worst-case lines).
    const pad = pieceRows?.pad ?? Math.max(1, Math.round((0.12 * box) / f))
    piece = fixedLen ?? R * (Math.ceil(boxDots - 1e-6) + 2 * pad + 2 * t)
    edges = evenEdges(piece * C, C)
    rows = evenEdges(piece, R)
    const base = baselines(rows, pad)
    const x0 = (t + padH) * f
    const w = (H - 2 * t - 2 * padH) * f
    cells.forEach((row, r) =>
      row.forEach((s, c) => {
        if (s.trim() !== '') cellsOut.push({ r, c, text: s, x: originX(s, x0, w), y: base[r] ?? 0 })
      }),
    )
    // Row separators inside every piece (block rows [r − ⌊t/2⌋, … + t) turned a quarter).
    if (t > 0) {
      for (let c = 0; c < C; c++) {
        for (const r of rows.slice(1, -1)) {
          const p0 = edges[c] ?? 0
          vline(item.direction === 'across-down' ? p0 + piece - (r - half + t) : p0 + r - half, t)
        }
      }
    }
  }

  const len = edges[C] ?? 0
  if (t > 0) {
    lines.push({ x: 0, y: 0, w: len, h: t }, { x: 0, y: H - t, w: len, h: t })
    vline(0, t)
    vline(len - t, t)
    // Piece edges: doubled (a box per piece) when the printer cuts there, and across the tape
    // too, where a single line would look like the row lines inside the pieces.
    for (const e of edges.slice(1, -1)) {
      if (own || across) {
        vline(e - t, t)
        vline(e, t)
      } else vline(e - half, t)
    }
  }
  const marks: Rect[] = []
  if (item.cutMarks && !own) {
    const mw = gridDots(dpi)
    const ml = Math.max(1, Math.min(mmToDots(1.5, dpi), Math.round(H / 4)))
    for (const e of edges) {
      const x = e === 0 ? 0 : e === len ? len - mw : e - Math.floor(mw / 2)
      marks.push({ x, y: 0, w: mw, h: ml }, { x, y: H - ml, w: mw, h: ml })
    }
  }
  return {
    w: len,
    h: H,
    edges,
    rows,
    emPx: em,
    boxDots,
    capDots: (face.cap * em) / f,
    lines,
    marks,
    cells: cellsOut,
    cuts: own ? edges.slice(1, -1) : [],
    ...(across ? { turn: item.direction === 'across-down' ? 90 : 270, piece } : {}),
    ...(reducedBy ? { reduced: reducedBy } : {}),
    ...(pixelScale !== undefined ? { pixelScale } : {}),
  }
}
