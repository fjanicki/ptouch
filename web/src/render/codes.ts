// W3 — CodeItem → module matrix (wasm encodeCode, fast_qr / barcoders / datamatrix in
// ptouch-wasm) with a small cache, plus the size preflight. Codes are painted by the core
// (`Raster.blitCode`) at an integer module size and are never drawn on a canvas.
//
// Quiet zones (P3, docs/STUDIO-V1-PLAN.md §2.4) come in three modes:
//
// | Mode     | QR                       | DataMatrix               | Linear              |
// |----------|--------------------------|--------------------------|---------------------|
// | standard | 4 modules all round      | 1 module (ISO/IEC 16022) | 10 modules L/R      |
// | compact  | 2 modules along the label| 1 module along the label | 5 modules L/R       |
// | none     | –                        | –                        | –                   |
//
// Across the tape a 2-D symbol's zone may use blank band plus the unprinted tape margin
// (maxModuleDots). In 'compact' the margin alone is enough, so the symbol may fill the whole
// band; only when a frame line borders the band (margin 0) is the zone kept inside it. The
// renderer pads the matrix with light modules (padMatrix) and blits it with `quietZone = false`:
// the core paints light modules as cleared and protected dots, so the zone stays blank whatever
// the mode (the core's own `true` only knows the standard QR/linear sizes).
import { encodeCode, type ModuleMatrix } from '../wasm'
import type { CodeItem, ModuleSize, QuietZone, Symbology } from '../doc/schema'
import { wifiPayload } from './wifi'

type CodeKey = Pick<CodeItem, 'symbology' | 'data' | 'ecc'> & Partial<Pick<CodeItem, 'content' | 'wifi'>>

/**
 * The text a code item encodes: `data`, or the `WIFI:` string for content 'wifi' (QR only).
 * Throws an Error with a user-facing message when the Wi-Fi settings are incomplete.
 */
export function codePayload(item: CodeKey): string {
  if (item.content === 'wifi' && item.symbology === 'qr') return wifiPayload(item.wifi ?? { ssid: '', password: '', security: 'wpa', hidden: false })
  return item.data
}

const CACHE_SIZE = 64
const cache = new Map<string, { m: ModuleMatrix } | { err: unknown }>()

function key(item: CodeKey, data: string): string {
  return `${item.symbology}\u0000${item.symbology === 'qr' ? item.ecc : ''}\u0000${data}`
}

/** Encodes `codePayload(item)` (cached by symbology+payload+ecc). Throws PtouchError on invalid
 * data, or an Error for incomplete Wi-Fi settings. */
export function codeMatrix(item: CodeKey): ModuleMatrix {
  const data = codePayload(item)
  const k = key(item, data)
  let hit = cache.get(k)
  if (hit) {
    // LRU: move to the end.
    cache.delete(k)
    cache.set(k, hit)
  } else {
    try {
      hit = { m: encodeCode(item.symbology === 'qr' ? { symbology: 'qr', data, ecc: item.ecc } : { symbology: item.symbology, data }) }
    } catch (err) {
      // Only cache genuine data errors; a wasm hiccup may recover.
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

/** `QuietZone` mode or a schema-1 style boolean (true = 'standard'). */
export type QuietZoneArg = QuietZone | boolean

function mode(quietZone: QuietZoneArg): QuietZone {
  return quietZone === true ? 'standard' : quietZone === false ? 'none' : quietZone
}

/**
 * Quiet zone in modules: [along the label, across the tape]. `symbology` tells a DataMatrix
 * (1 module) from a QR code (the default for 2-D matrices); linear codes are detected from the
 * matrix. The across value is what the zone needs when it has to fit inside the band.
 */
export function quietModules(m: ModuleMatrix, quietZone: QuietZoneArg, symbology?: Symbology): [number, number] {
  const q = mode(quietZone)
  if (q === 'none') return [0, 0]
  if (isLinear(m)) return [q === 'compact' ? 5 : 10, 0]
  if (symbology === 'datamatrix') return [1, 1]
  return q === 'compact' ? [2, 2] : [4, 4]
}

export interface CodeSize {
  /** Along the label incl. quiet zones, dots. */
  w: number
  /** Across the tape incl. quiet zones (linear codes: band height), dots. */
  h: number
}

/** Footprint of a code at `moduleDots`. Linear codes take the whole band height. */
export function codeSizeDots(m: ModuleMatrix, moduleDots: number, quietZone: QuietZoneArg, bandDots: number, symbology?: Symbology): CodeSize {
  const md = Math.max(0, Math.floor(moduleDots))
  const [qx, qy] = quietModules(m, quietZone, symbology)
  const w = (m.width + 2 * qx) * md
  return isLinear(m) ? { w, h: bandDots } : { w, h: (m.height + 2 * qy) * md }
}

/**
 * Largest integer module size whose symbol fits `bandDots` across the tape; 0 if impossible.
 * A 2-D symbol must fit the band, and its vertical quiet zone must fit in the blank band plus
 * `marginDots` of unprinted tape on each side (0 when a frame line or a neighbour borders the
 * band). In 'compact' mode any unprinted margin is zone enough, so the symbol may fill the
 * band. A linear code has no vertical limit (its bars stretch to the band), so the result is
 * capped at `min(bandDots, 255)`.
 */
export function maxModuleDots(m: ModuleMatrix, bandDots: number, quietZone: QuietZoneArg, marginDots = 0, symbology?: Symbology): number {
  if (isLinear(m)) return Math.max(0, Math.min(255, bandDots))
  if (m.height <= 0) return 0
  const fit = Math.max(0, Math.min(255, Math.floor(bandDots / m.height)))
  const [, qy] = quietModules(m, quietZone, symbology)
  if (qy === 0 || (mode(quietZone) === 'compact' && marginDots > 0)) return fit
  const withQuiet = Math.floor((bandDots + 2 * Math.max(0, marginDots)) / (m.height + 2 * qy))
  return Math.max(0, Math.min(fit, withQuiet))
}

/** Largest module size `moduleDots: 'auto'` gives a linear code. */
export const AUTO_LINEAR_MAX_DOTS = 4
/** Linear `'auto'` module size when nothing limits the length (auto-length label). */
export const AUTO_LINEAR_DEFAULT_DOTS = 2

export interface ModuleChoice {
  /** Module size to print with, ≥ 1 (1 also when nothing fits: see `max`). */
  md: number
  /** Largest size that fits (0: does not fit at all). Linear codes without a length limit: 255. */
  max: number
  /** A fixed size was lowered to `max`. */
  reduced: boolean
}

/**
 * The module size the renderer prints a code with. 2-D: `'auto'` = the largest whole-dot size
 * that fits the band (maxModuleDots) and the frame width `limitW`; a fixed size is lowered to it.
 * Linear: `'auto'` = the largest size up to 4 whose symbol (with its zone) fits `limitW` (a
 * fixed label length or a frame), else 2; a fixed size is lowered only to fit `limitW`.
 */
export function chooseModuleDots(
  m: ModuleMatrix,
  o: { moduleDots: ModuleSize; quietZone: QuietZoneArg; symbology?: Symbology; bandDots: number; marginDots?: number; limitW?: number },
): ModuleChoice {
  const [qx] = quietModules(m, o.quietZone, o.symbology)
  const byW = o.limitW === undefined ? 255 : Math.floor(Math.max(0, o.limitW) / Math.max(1, m.width + 2 * qx))
  const fixed = o.moduleDots === 'auto' ? undefined : Math.max(1, Math.min(255, Math.floor(o.moduleDots)))
  if (isLinear(m)) {
    const max = Math.min(255, byW)
    if (fixed === undefined) {
      const md = o.limitW === undefined ? AUTO_LINEAR_DEFAULT_DOTS : Math.max(1, Math.min(AUTO_LINEAR_MAX_DOTS, max))
      return { md, max, reduced: false }
    }
    return { md: Math.max(1, Math.min(fixed, max)), max, reduced: fixed > max && max >= 1 }
  }
  const max = Math.min(maxModuleDots(m, o.bandDots, o.quietZone, o.marginDots ?? 0, o.symbology), byW)
  if (fixed === undefined) return { md: Math.max(1, max), max, reduced: false }
  return { md: Math.max(1, Math.min(fixed, max)), max, reduced: fixed > max && max >= 1 }
}

/**
 * `m` with `qx` light modules left and right and `qy` above and below. Blitted with
 * `quietZone = false`, the core clears and protects them like a built-in quiet zone.
 */
export function padMatrix(m: ModuleMatrix, qx: number, qy: number): ModuleMatrix {
  if (qx <= 0 && qy <= 0) return m
  const w = m.width + 2 * qx
  const h = m.height + 2 * qy
  const modules = new Array<number>(w * h).fill(0)
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) modules[(y + qy) * w + x + qx] = m.modules[y * m.width + x] ?? 0
  }
  return { width: w, height: h, modules }
}

export type Readability = 'good' | 'ok' | 'poor'

/** How well a code at `md` dots per module scans: ≥ 3 good for phones, 2 close up, 1 poor. */
export function readability(md: number): { level: Readability; text: string } {
  if (md >= 3) return { level: 'good', text: 'Good for phone cameras.' }
  if (md === 2) return { level: 'ok', text: 'OK close up: hold the phone near the label.' }
  return { level: 'poor', text: 'Unreliable: modules of 1 dot often do not scan. Use wider tape or less data.' }
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
