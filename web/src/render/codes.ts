// W3 — CodeItem → module matrix (wasm encodeCode, fast_qr / barcoders in ptouch-wasm) with a
// small cache, plus the size preflight. Codes are painted by the core (`Raster.blitCode`) at an
// integer module size and are never drawn on a canvas.
//
// Quiet zones (4 modules on every side of a 2-D symbol, 10 modules left and right of a linear
// barcode) are the core's rule: the renderer reserves them in the layout and passes
// `quietZone` to `Raster.blitCode`, so the core clears and protects them in the raster. Across
// the tape a 2-D symbol's quiet zone may use blank band plus the unprinted tape margin; the
// module size is chosen so both together give 4 modules (maxModuleDots).
import { encodeCode, type ModuleMatrix } from '../wasm'
import type { CodeItem } from '../doc/schema'

type CodeKey = Pick<CodeItem, 'symbology' | 'data' | 'ecc'>

const CACHE_SIZE = 64
const cache = new Map<string, { m: ModuleMatrix } | { err: unknown }>()

function key(item: CodeKey): string {
  return `${item.symbology}\u0000${item.symbology === 'qr' ? item.ecc : ''}\u0000${item.data}`
}

/** Encodes (cached by symbology+data+ecc). Throws PtouchError on invalid data. */
export function codeMatrix(item: CodeKey): ModuleMatrix {
  const k = key(item)
  let hit = cache.get(k)
  if (hit) {
    // LRU: move to the end.
    cache.delete(k)
    cache.set(k, hit)
  } else {
    try {
      hit = { m: encodeCode(item.symbology === 'qr' ? { symbology: 'qr', data: item.data, ecc: item.ecc } : { symbology: item.symbology, data: item.data }) }
    } catch (err) {
      // Only cache genuine data errors; a missing implementation / wasm hiccup may recover.
      const code = (err as { code?: unknown } | null)?.code
      if (code !== 'INVALID_INPUT') throw err
      hit = { err }
    }
    cache.set(k, hit)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  }
  if ('err' in hit) throw hit.err
  return hit.m
}

/** A linear (1-D) code: one row, or every row identical (same rule as the core). */
export function isLinear(m: ModuleMatrix): boolean {
  if (m.height <= 1 || m.width === 0) return true
  const w = m.width
  for (let y = 1; y < m.height; y++) {
    for (let x = 0; x < w; x++) if (m.modules[y * w + x] !== m.modules[x]) return false
  }
  return true
}

/** Quiet zone in modules: [along the label, across the tape]. */
export function quietModules(m: ModuleMatrix, quietZone: boolean): [number, number] {
  if (!quietZone) return [0, 0]
  return isLinear(m) ? [10, 0] : [4, 4]
}

export interface CodeSize {
  /** Along the label incl. quiet zones, dots. */
  w: number
  /** Across the tape incl. quiet zones (linear codes: band height), dots. */
  h: number
}

/** Footprint of a code at `moduleDots`. Linear codes take the whole band height. */
export function codeSizeDots(m: ModuleMatrix, moduleDots: number, quietZone: boolean, bandDots: number): CodeSize {
  const md = Math.max(0, Math.floor(moduleDots))
  const [qx, qy] = quietModules(m, quietZone)
  const w = (m.width + 2 * qx) * md
  return isLinear(m) ? { w, h: bandDots } : { w, h: (m.height + 2 * qy) * md }
}

/**
 * Largest integer module size whose symbol fits `bandDots` across the tape; 0 if impossible.
 * A 2-D symbol must fit the band, and with `quietZone` its 4-module vertical quiet zone must fit
 * in the blank band plus `marginDots` of unprinted tape on each side (0 when a frame line or a
 * neighbour borders the band). A linear code has no vertical limit (its bars stretch to the
 * band), so the result is capped at `min(bandDots, 255)`.
 */
export function maxModuleDots(m: ModuleMatrix, bandDots: number, quietZone: boolean, marginDots = 0): number {
  if (isLinear(m)) return Math.max(0, Math.min(255, bandDots))
  if (m.height <= 0) return 0
  const fit = Math.floor(bandDots / m.height)
  if (!quietZone) return Math.min(255, fit)
  const [, qy] = quietModules(m, true)
  const withQuiet = Math.floor((bandDots + 2 * Math.max(0, marginDots)) / (m.height + 2 * qy))
  return Math.max(0, Math.min(255, fit, withQuiet))
}

/** Unprinted tape on each side of the printable band, in dots (part of a code's quiet zone). */
export function tapeMarginDots(area: { tapeWidthDots: number; heightDots: number }): number {
  return Math.max(0, Math.floor((area.tapeWidthDots - area.heightDots) / 2))
}

/** EAN-13 check digit for 12 digits. */
export function ean13CheckDigit(digits12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

/** Human-readable line under a linear code ("5 901234 123457" for EAN-13). */
export function humanReadable(item: Pick<CodeItem, 'symbology' | 'data'>): string {
  const d = item.data.trim()
  if (item.symbology === 'ean13' && /^\d{12,13}$/.test(d)) {
    const full = d.length === 12 ? d + String(ean13CheckDigit(d)) : d
    return `${full[0]} ${full.slice(1, 7)} ${full.slice(7)}`
  }
  return d
}

/** A copy of a linear code's single row repeated `rows` times (bar height = rows × module). */
export function repeatRow(m: ModuleMatrix, rows: number): ModuleMatrix {
  const row = m.modules.slice(0, m.width)
  const n = Math.max(1, rows)
  const modules = new Array<number>(m.width * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < m.width; x++) modules[y * m.width + x] = row[x] ?? 0
  return { width: m.width, height: n, modules }
}

/** The matrix rotated by 90° steps clockwise (free-layout rotation). */
export function rotateMatrix(m: ModuleMatrix, rotation: 0 | 90 | 180 | 270): ModuleMatrix {
  if (rotation === 0) return m
  const { width: w, height: h } = m
  const at = (x: number, y: number): number => m.modules[y * w + x] ?? 0
  if (rotation === 180) return { width: w, height: h, modules: Array.from({ length: w * h }, (_, i) => at(w - 1 - (i % w), h - 1 - Math.floor(i / w))) }
  // 90° cw: new (x, y) ← old (y, h − 1 − x); new width = h.
  const nw = h
  const nh = w
  return {
    width: nw,
    height: nh,
    modules: Array.from({ length: nw * nh }, (_, i) => {
      const x = i % nw
      const y = Math.floor(i / nw)
      return rotation === 90 ? at(y, h - 1 - x) : at(w - 1 - y, x)
    }),
  }
}
