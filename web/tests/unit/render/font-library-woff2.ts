// A minimal WOFF2 reader for the font-library tests: the table directory, the decompressed
// tables (node's built-in Brotli), and the few fields the tests check (name, cmap, OS/2, head,
// maxp, hhea/hmtx, fvar). Test-only: the app never parses fonts itself, the browser does.
import { brotliDecompressSync } from 'node:zlib'

/** The 63 tags a WOFF2 directory entry can name by index (WOFF2 §5.1). */
const KNOWN_TAGS = 'cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'
  .match(/.{4}\s?/g)!
  .map((t) => t.slice(0, 4))

export interface Woff2Table {
  tag: string
  /** Transform version from the directory flags. */
  transform: number
  /** `true` if the stored data is a transformed form (glyf/loca version 0, hmtx version 1). */
  transformed: boolean
  data: Uint8Array
}

export interface Woff2Font {
  tables: Map<string, Woff2Table>
  /** WOFF metadata / private block present. */
  hasMetadata: boolean
  hasPrivate: boolean
}

export function readWoff2(bytes: Uint8Array): Woff2Font {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0) !== 0x774f4632) throw new Error('not WOFF2')
  if (v.getUint32(4) === 0x74746366) throw new Error('collections are not supported')
  const numTables = v.getUint16(12)
  const totalCompressedSize = v.getUint32(20)
  const metaLength = v.getUint32(32)
  const privLength = v.getUint32(44)
  let p = 48
  const base128 = (): number => {
    let n = 0
    for (let i = 0; i < 5; i++) {
      const b = v.getUint8(p++)
      n = n * 128 + (b & 0x7f)
      if (!(b & 0x80)) return n
    }
    throw new Error('bad UIntBase128')
  }
  const dir: { tag: string; transform: number; transformed: boolean; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const flags = v.getUint8(p++)
    let tag = KNOWN_TAGS[flags & 0x3f] as string
    if ((flags & 0x3f) === 63) {
      tag = String.fromCharCode(...bytes.subarray(p, p + 4))
      p += 4
    }
    const transform = flags >> 6
    const origLength = base128()
    const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0
    const length = transformed ? base128() : origLength
    dir.push({ tag, transform, transformed, length })
  }
  const stream = brotliDecompressSync(bytes.subarray(p, p + totalCompressedSize))
  const tables = new Map<string, Woff2Table>()
  let off = 0
  for (const d of dir) {
    tables.set(d.tag, { tag: d.tag, transform: d.transform, transformed: d.transformed, data: stream.subarray(off, off + d.length) })
    off += d.length
  }
  return { tables, hasMetadata: metaLength > 0, hasPrivate: privLength > 0 }
}

function table(font: Woff2Font, tag: string): DataView {
  const t = font.tables.get(tag)
  if (!t) throw new Error(`no ${tag} table`)
  if (t.transformed) throw new Error(`${tag} is transformed`)
  return new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength)
}

export const unitsPerEm = (f: Woff2Font): number => table(f, 'head').getUint16(18)
export const numGlyphs = (f: Woff2Font): number => table(f, 'maxp').getUint16(4)
export const weightClass = (f: Woff2Font): number => table(f, 'OS/2').getUint16(4)

/** Every string of name ID `id` (Windows Unicode and Mac Roman records). */
export function names(f: Woff2Font, id: number): string[] {
  const v = table(f, 'name')
  const count = v.getUint16(2)
  const strings = v.getUint16(4)
  const out = new Set<string>()
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12
    const platform = v.getUint16(r)
    if (v.getUint16(r + 6) !== id) continue
    const len = v.getUint16(r + 8)
    const at = strings + v.getUint16(r + 10)
    const raw = new Uint8Array(v.buffer, v.byteOffset + at, len)
    if (platform === 3 || platform === 0) out.add(new TextDecoder('utf-16be').decode(raw))
    else if (platform === 1) out.add(String.fromCharCode(...raw))
  }
  return [...out]
}

/** Code points mapped by the best Unicode cmap subtable (format 12, else format 4). */
export function codePoints(f: Woff2Font): Set<number> {
  const v = table(f, 'cmap')
  const n = v.getUint16(2)
  let fmt4 = -1
  let fmt12 = -1
  for (let i = 0; i < n; i++) {
    const platform = v.getUint16(4 + i * 8)
    const enc = v.getUint16(6 + i * 8)
    const off = v.getUint32(8 + i * 8)
    const format = v.getUint16(off)
    if (format === 12 && (platform === 3 || platform === 0)) fmt12 = off
    if (format === 4 && ((platform === 3 && enc === 1) || platform === 0)) fmt4 = off
  }
  const cps = new Set<number>()
  if (fmt12 >= 0) {
    const groups = v.getUint32(fmt12 + 12)
    for (let g = 0; g < groups; g++) {
      const r = fmt12 + 16 + g * 12
      for (let c = v.getUint32(r); c <= v.getUint32(r + 4); c++) cps.add(c)
    }
    return cps
  }
  if (fmt4 < 0) throw new Error('no Unicode cmap')
  const segX2 = v.getUint16(fmt4 + 6)
  const ends = fmt4 + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const ranges = deltas + segX2
  for (let s = 0; s < segX2 / 2; s++) {
    const end = v.getUint16(ends + s * 2)
    const start = v.getUint16(starts + s * 2)
    const delta = v.getUint16(deltas + s * 2)
    const rangeOff = v.getUint16(ranges + s * 2)
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid: number
      if (rangeOff === 0) gid = (c + delta) & 0xffff
      else {
        const at = ranges + s * 2 + rangeOff + (c - start) * 2
        gid = v.getUint16(at)
        if (gid !== 0) gid = (gid + delta) & 0xffff
      }
      if (gid !== 0) cps.add(c)
    }
  }
  return cps
}

/** Advance width of every glyph (hhea.numberOfHMetrics + hmtx; the last one repeats). */
export function advances(f: Woff2Font): number[] {
  const nh = table(f, 'hhea').getUint16(34)
  const h = table(f, 'hmtx')
  const out: number[] = []
  for (let i = 0; i < nh; i++) out.push(h.getUint16(i * 4))
  const last = out[out.length - 1] ?? 0
  while (out.length < numGlyphs(f)) out.push(last)
  return out
}

/** Variation axes (fvar), or [] for a static font. */
export function axes(f: Woff2Font): { tag: string; min: number; def: number; max: number }[] {
  if (!f.tables.has('fvar')) return []
  const v = table(f, 'fvar')
  const first = v.getUint16(4)
  const count = v.getUint16(8)
  const size = v.getUint16(10)
  const fixed = (at: number): number => v.getInt32(at) / 65536
  return Array.from({ length: count }, (_, i) => {
    const r = first + i * size
    return { tag: String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3)), min: fixed(r + 4), def: fixed(r + 8), max: fixed(r + 12) }
  })
}
