// P4 (docs/STUDIO-V1-PLAN.md) — uploaded fonts (TTF/OTF/WOFF/WOFF2) as Blobs in IndexedDB, in
// their OWN database `ptouch-fonts` (the label blob store's GC would delete them: no label
// references a font through `blobRef`). Keyed by content ref (`sha256-…`, persist-codec.ts), the
// value `TextItem.customFont.ref` points at. Validated by signature and size before storing.
// Font files never leave the browser (not in share links or exported labels: licences).
//
// The display name comes from the font's `name` table (typographic family/subfamily, IDs 16/17,
// else 1/2), read from TTF/OTF directly and from WOFF after inflating the table
// (DecompressionStream 'deflate' = zlib). WOFF2 tables are Brotli-compressed, which browsers do
// not expose: those are named after the file.
import { hasIndexedDb, idbArea, memoryArea, type KeyValueArea } from './persist'
import { contentRef } from './persist-codec'
import { LIMITS } from './schema'

/** Largest font file accepted. */
export const MAX_FONT_BYTES = 10 * 1024 * 1024
/** Fonts kept per browser. */
export const MAX_FONTS = 50

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2'

export interface UserFontInfo {
  /** Content ref (`sha256-<32 hex>`); `FontSource.ref`. */
  ref: string
  /** Display / CSS family name (from the file's name table, else the file name). */
  family: string
  fileName: string
  format: FontFormat
  size: number
  /** ISO 8601. */
  addedAt: string
}

export interface FontStore {
  /** Newest first. */
  list(): Promise<UserFontInfo[]>
  /** Validates and stores a font file (same content → same ref, no duplicate). Throws an Error
   * with a user-facing message for a bad, unsupported or oversized file. */
  add(file: File): Promise<UserFontInfo>
  get(ref: string): Promise<Blob | undefined>
  remove(ref: string): Promise<void>
}

export interface FontStoreOptions {
  /** Injectable area (unit tests: memoryBackend().blobs); default IndexedDB `ptouch-fonts`. */
  area?: KeyValueArea
  /** Checks that the browser can actually use the font (default: `new FontFace(…).load()`
   * where FontFace exists). Rejects for a file the browser's font sanitiser refuses. */
  verify?: (bytes: ArrayBuffer, format: FontFormat) => Promise<void>
  now?: () => number
}

export const FONT_MIME: Record<FontFormat, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }

/** File picker `accept` list. */
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

interface StoredFont {
  info: UserFontInfo
  blob: Blob
}

// ------------------------------------------------------------------------------------------
// Validation and names (pure; unit-tested)
// ------------------------------------------------------------------------------------------

const tag = (b: Uint8Array, at = 0): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0)

/** Font format from the first bytes, or undefined (`00 01 00 00`/`true` = TrueType, `OTTO` = CFF). */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | undefined {
  if (bytes.length < 12) return undefined
  const t = tag(bytes)
  if ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || t === 'true') return 'ttf'
  if (t === 'OTTO') return 'otf'
  if (t === 'wOFF') return 'woff'
  if (t === 'wOF2') return 'woff2'
  return undefined
}

/** A display name from a file name: "Inter-Bold_v4.ttf" → "Inter Bold v4". */
export function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(ttf|otf|woff2?|ttc)$/i, '')
  return cleanName(base.replace(/[-_]+/g, ' ')) || 'Uploaded font'
}

/** Printable, single-line, trimmed, capped at LIMITS.fontNameChars. */
function cleanName(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.fontNameChars)
    .trim()
}

const u16 = (v: DataView, at: number): number => (at + 2 <= v.byteLength ? v.getUint16(at) : 0)
const u32 = (v: DataView, at: number): number => (at + 4 <= v.byteLength ? v.getUint32(at) : 0)

/** Byte range of a table in an sfnt (TTF/OTF), or undefined. */
function sfntTable(b: Uint8Array, want: string): Uint8Array | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = u16(v, 4)
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    if (rec + 16 > b.length) return undefined
    if (tag(b, rec) !== want) continue
    const off = u32(v, rec + 8)
    const len = u32(v, rec + 12)
    return off + len <= b.length ? b.subarray(off, off + len) : undefined
  }
  return undefined
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A table of a WOFF 1.0 file (inflated when compressed), or undefined. */
async function woffTable(b: Uint8Array, want: string): Promise<Uint8Array | undefined> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = u16(v, 12)
  for (let i = 0; i < n; i++) {
    const rec = 44 + i * 20
    if (rec + 20 > b.length) return undefined
    if (tag(b, rec) !== want) continue
    const off = u32(v, rec + 4)
    const comp = u32(v, rec + 8)
    const orig = u32(v, rec + 12)
    if (off + comp > b.length || orig > 1024 * 1024) return undefined
    const data = b.subarray(off, off + comp)
    return comp < orig ? inflate(data) : data
  }
  return undefined
}

function decodeUtf16be(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(((b[i] ?? 0) << 8) | (b[i + 1] ?? 0))
  return s
}

/** Mac Roman is close enough to Latin-1 for family names (ASCII in practice). */
function decodeLatin1(b: Uint8Array): string {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return s
}

/**
 * Family and subfamily from a `name` table: typographic IDs 16/17 win over 1/2; Windows
 * (platform 3) or Unicode (0) records, US English preferred, before Mac Roman (platform 1).
 */
export function parseNameTable(t: Uint8Array): { family?: string; subfamily?: string } {
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength)
  const count = u16(v, 2)
  const storage = u16(v, 4)
  const found = new Map<number, { score: number; text: string }>()
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (rec + 12 > t.length) break
    const platform = u16(v, rec)
    const encoding = u16(v, rec + 2)
    const language = u16(v, rec + 4)
    const id = u16(v, rec + 6)
    const len = u16(v, rec + 8)
    const off = storage + u16(v, rec + 10)
    if (![1, 2, 16, 17].includes(id) || off + len > t.length) continue
    const raw = t.subarray(off, off + len)
    let text: string
    let score: number
    if (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0)) {
      text = decodeUtf16be(raw)
      score = language === 0x409 ? 4 : 3
    } else if (platform === 0) {
      text = decodeUtf16be(raw)
      score = 2
    } else if (platform === 1 && encoding === 0) {
      text = decodeLatin1(raw)
      score = language === 0 ? 1 : 0
    } else continue
    text = cleanName(text)
    const prev = found.get(id)
    if (text && (!prev || score > prev.score)) found.set(id, { score, text })
  }
  const family = found.get(16)?.text ?? found.get(1)?.text
  const subfamily = found.get(16) ? (found.get(17)?.text ?? found.get(2)?.text) : found.get(2)?.text
  return { ...(family ? { family } : {}), ...(subfamily ? { subfamily } : {}) }
}

/** Display name of a font file: "Family Subfamily" (subfamily omitted when Regular), or undefined. */
export async function fontDisplayName(bytes: Uint8Array, format: FontFormat): Promise<string | undefined> {
  try {
    const table = format === 'ttf' || format === 'otf' ? sfntTable(bytes, 'name') : format === 'woff' ? await woffTable(bytes, 'name') : undefined
    if (!table) return undefined
    const { family, subfamily } = parseNameTable(table)
    if (!family) return undefined
    const sub = subfamily && !/^(regular|normal|book|roman)$/i.test(subfamily) && !family.toLowerCase().endsWith(subfamily.toLowerCase()) ? ` ${subfamily}` : ''
    return cleanName(`${family}${sub}`) || undefined
  } catch {
    return undefined // a broken name table is not fatal: the file name is used
  }
}

/** Format of a font file, or an Error with a user-facing message. */
export function checkFontFile(bytes: Uint8Array, size = bytes.length): FontFormat {
  if (size === 0) throw new Error('This file is empty.')
  if (size > MAX_FONT_BYTES) throw new Error(`This font is too large (${(size / 1024 / 1024).toFixed(1)} MB). Fonts up to ${MAX_FONT_BYTES / 1024 / 1024} MB can be added.`)
  const format = sniffFontFormat(bytes)
  if (!format) throw new Error('This is not a font file this app can use. Choose a TTF, OTF, WOFF or WOFF2 file.')
  return format
}

/** Default `verify`: the browser's own font loader (and its sanitiser) must accept the file. */
async function verifyWithFontFace(bytes: ArrayBuffer): Promise<void> {
  if (typeof FontFace === 'undefined') return
  try {
    await new FontFace('ptouch-verify', bytes).load()
  } catch {
    throw new Error('The browser could not read this font. The file may be damaged or in an unsupported format.')
  }
}

// ------------------------------------------------------------------------------------------
// Store
// ------------------------------------------------------------------------------------------

export function openFontStore(opts: FontStoreOptions = {}): FontStore {
  const area = opts.area ?? (hasIndexedDb() ? idbArea('ptouch-fonts', 'fonts') : memoryArea())
  const verify = opts.verify ?? verifyWithFontFace
  const now = opts.now ?? Date.now

  async function list(): Promise<UserFontInfo[]> {
    const out: UserFontInfo[] = []
    for (const [, rec] of await area.entries<StoredFont>()) if (rec?.info && rec.blob instanceof Blob) out.push(rec.info)
    return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.family.localeCompare(b.family))
  }

  return {
    list,

    async add(file) {
      // Size first: never read a huge file into memory.
      if (file.size > MAX_FONT_BYTES) checkFontFile(new Uint8Array(0), file.size)
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const format = checkFontFile(bytes)
      const ref = await contentRef(bytes)
      const existing = await area.get<StoredFont>(ref)
      if (existing?.info) return existing.info
      if ((await list()).length >= MAX_FONTS) throw new Error(`You already have ${MAX_FONTS} fonts. Remove one before adding another.`)
      await verify(buf.slice(0), format)
      const info: UserFontInfo = {
        ref,
        family: (await fontDisplayName(bytes, format)) ?? nameFromFileName(file.name),
        fileName: file.name.replace(/^.*[\\/]/, '').slice(0, 200),
        format,
        size: bytes.length,
        addedAt: new Date(now()).toISOString(),
      }
      await area.set(ref, { info, blob: new Blob([bytes], { type: FONT_MIME[format] }) } satisfies StoredFont)
      return info
    },

    async get(ref) {
      if (!ref) return undefined
      const rec = await area.get<StoredFont>(ref)
      return rec?.blob instanceof Blob ? rec.blob : undefined
    },

    async remove(ref) {
      await area.del(ref)
    },
  }
}
