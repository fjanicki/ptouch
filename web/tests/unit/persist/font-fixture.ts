// P4 — a tiny, self-made TrueType font for the font tests (unit, browser and e2e). Source: this
// file (written for ptouch, MIT OR Apache-2.0; no third-party outlines). Every printable ASCII
// character except the space is one filled box, so text drawn with it looks nothing like the
// bundled fallback. The tables are the minimum a browser's font sanitiser (OTS) accepts:
// OS/2, cmap (format 4), glyf, head, hhea, hmtx, loca (short), maxp, name, post (3.0).

export interface FontFixtureOptions {
  /** Typographic family (name IDs 1 and 16). */
  family?: string
  /** Subfamily (name IDs 2 and 17). */
  subfamily?: string
  /** Box width in font units (1000 per em); changes the file's content (and its ref). */
  boxWidth?: number
}

class Writer {
  bytes: number[] = []
  u8(v: number): this {
    this.bytes.push(v & 255)
    return this
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 65536 : v)
  }
  u32(v: number): this {
    return this.u16((v >>> 16) & 65535).u16(v & 65535)
  }
  tag(t: string): this {
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i))
    return this
  }
  pad4(): this {
    while (this.bytes.length % 4) this.u8(0)
    return this
  }
  get out(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

function checksum(b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0
  return sum
}

function utf16be(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 255)
  return out
}

function nameTable(family: string, subfamily: string): Uint8Array {
  const full = subfamily === 'Regular' ? family : `${family} ${subfamily}`
  const ps = full.replace(/[^A-Za-z0-9-]/g, '')
  const names: [number, string][] = [
    [1, family],
    [2, subfamily],
    [4, full],
    [6, ps],
    [16, family],
    [17, subfamily],
  ]
  const records = new Writer()
  const storage: number[] = []
  for (const [id, text] of names) {
    const enc = utf16be(text)
    records.u16(3).u16(1).u16(0x409).u16(id).u16(enc.length).u16(storage.length)
    storage.push(...enc)
  }
  const w = new Writer().u16(0).u16(names.length).u16(6 + names.length * 12)
  w.bytes.push(...records.bytes, ...storage)
  return w.out
}

/** A valid TrueType font (sfnt version 1.0). */
export function makeTestFont(opts: FontFixtureOptions = {}): Uint8Array {
  const family = opts.family ?? 'Ptouch Test Box'
  const subfamily = opts.subfamily ?? 'Regular'
  const bw = opts.boxWidth ?? 500
  const adv = bw + 100
  const first = 0x21
  const last = 0x7e

  // glyph 1: a box from (50, 0) to (50 + bw, 700), clockwise; glyph 0 (.notdef) is empty.
  const glyph = new Writer().i16(1).i16(50).i16(0).i16(50 + bw).i16(700)
  glyph.u16(3).u16(0) // endPtsOfContours[0] = 3, no instructions
  for (let i = 0; i < 4; i++) glyph.u8(1) // on-curve, x and y as int16 deltas
  for (const dx of [50, 0, bw, 0]) glyph.i16(dx)
  for (const dy of [0, 700, 0, -700]) glyph.i16(dy)
  const glyf = glyph.pad4().out
  const loca = new Writer().u16(0).u16(0).u16(glyf.length / 2).out

  const head = new Writer()
    .u32(0x00010000)
    .u32(0x00010000) // fontRevision 1.0
    .u32(0) // checkSumAdjustment (patched below)
    .u32(0x5f0f3cf5)
    .u16(0x000b) // baseline at y=0, lsb at x=0, integer ppem
    .u16(1000)
    .u32(0)
    .u32(0) // created
    .u32(0)
    .u32(0) // modified
    .i16(0)
    .i16(0)
    .i16(50 + bw)
    .i16(700)
    .u16(0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2)
    .i16(0) // indexToLocFormat: short
    .i16(0).out

  const hhea = new Writer()
    .u32(0x00010000)
    .i16(800) // ascender
    .i16(-200) // descender
    .i16(0)
    .u16(adv)
    .i16(0)
    .i16(0)
    .i16(50 + bw)
    .i16(1)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .u16(2).out // numberOfHMetrics

  const maxp = new Writer().u32(0x00010000).u16(2).u16(4).u16(1).u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).out

  const os2 = new Writer()
    .u16(4)
    .i16(adv) // xAvgCharWidth
    .u16(400)
    .u16(5)
    .u16(0) // fsType: installable
  for (let i = 0; i < 10; i++) os2.i16(i < 8 ? 100 : 0) // sub/superscript sizes+offsets, strikeout
  os2.i16(0) // sFamilyClass
  for (let i = 0; i < 10; i++) os2.u8(0) // panose
  os2.u32(1).u32(0).u32(0).u32(0) // Basic Latin
  os2.tag('NONE')
  os2.u16(0x40) // fsSelection: REGULAR
  os2.u16(first).u16(last)
  os2.i16(800).i16(-200).i16(0).u16(800).u16(200)
  os2.u32(1).u32(0) // Latin 1 code page
  os2.i16(500).i16(700).u16(0).u16(0x20).u16(1)

  const hmtx = new Writer().u16(adv).i16(0).u16(adv).i16(50).out

  // cmap format 4: [0x21, 0x7e] → glyph 1 through glyphIdArray (idRangeOffset), then the
  // 0xFFFF terminator (idDelta 1 → glyph 0).
  const count = last - first + 1
  const cmap = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12)
  cmap.u16(4).u16(32 + 2 * count).u16(0).u16(4).u16(4).u16(1).u16(0)
  cmap.u16(last).u16(0xffff).u16(0)
  cmap.u16(first).u16(0xffff)
  cmap.u16(0).u16(1)
  cmap.u16(4).u16(0) // segment 0: glyphIdArray starts 4 bytes after its idRangeOffset
  for (let i = 0; i < count; i++) cmap.u16(1)

  const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).out

  const tables: [string, Uint8Array][] = (
    [
      ['OS/2', os2.out],
      ['cmap', cmap.out],
      ['glyf', glyf],
      ['head', head],
      ['hhea', hhea],
      ['hmtx', hmtx],
      ['loca', loca],
      ['maxp', maxp],
      ['name', nameTable(family, subfamily)],
      ['post', post],
    ] as [string, Uint8Array][]
  ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const n = tables.length
  const entrySelector = Math.floor(Math.log2(n))
  const searchRange = 2 ** entrySelector * 16
  const dir = new Writer().u32(0x00010000).u16(n).u16(searchRange).u16(entrySelector).u16(n * 16 - searchRange)
  let offset = 12 + n * 16
  const body = new Writer()
  let headOffset = 0
  for (const [t, data] of tables) {
    dir.tag(t).u32(checksum(data)).u32(offset).u32(data.length)
    if (t === 'head') headOffset = offset
    body.bytes.push(...data)
    body.pad4()
    offset = 12 + n * 16 + body.bytes.length
  }
  const font = Uint8Array.from([...dir.bytes, ...body.bytes])
  const adjust = (0xb1b0afba - checksum(font)) >>> 0
  new DataView(font.buffer).setUint32(headOffset + 8, adjust)
  return font
}

/** Wraps an sfnt in WOFF 1.0 (tables zlib-compressed when that is smaller). */
export async function toWoff(sfnt: Uint8Array): Promise<Uint8Array> {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)
  const n = v.getUint16(4)
  const entries: { tag: string; data: Uint8Array; orig: number; checksum: number }[] = []
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    const tag = String.fromCharCode(...sfnt.subarray(rec, rec + 4))
    const off = v.getUint32(rec + 8)
    const len = v.getUint32(rec + 12)
    const raw = sfnt.subarray(off, off + len)
    const stream = new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream('deflate'))
    const comp = new Uint8Array(await new Response(stream).arrayBuffer())
    entries.push({ tag, data: comp.length < raw.length ? comp : raw, orig: len, checksum: v.getUint32(rec + 4) })
  }
  const head = new Writer()
  const dir = new Writer()
  const body = new Writer()
  let offset = 44 + n * 20
  for (const e of entries) {
    dir.tag(e.tag).u32(offset).u32(e.data.length).u32(e.orig).u32(e.checksum)
    body.bytes.push(...e.data)
    body.pad4()
    offset = 44 + n * 20 + body.bytes.length
  }
  const total = 44 + n * 20 + body.bytes.length
  head.tag('wOFF').u32(0x00010000).u32(total).u16(n).u16(0).u32(sfnt.length).u16(1).u16(0).u32(0).u32(0).u32(0).u32(0).u32(0)
  return Uint8Array.from([...head.bytes, ...dir.bytes, ...body.bytes])
}
