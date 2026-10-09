// P4 (docs/STUDIO-V1-PLAN.md) — exports the exact print bitmap (the same Bitmap1 that is
// previewed and printed) as a 1-bit PNG with its real resolution, or as a one-page PDF at true
// physical size. Both writers are hand-written (no library): PNG = signature + IHDR + pHYs +
// IDAT + IEND with a table CRC-32; PDF 1.4 = catalog, pages, page, image XObject, content
// stream, info and a byte-exact xref. Compression is the platform's CompressionStream('deflate'),
// which produces the zlib format both PNG IDAT and PDF /FlateDecode expect.
//
// Orientation is the canvas one used everywhere in render/: x = along the label (left end as
// read), y = across the tape (row 0 = top of the printable band). Ink is black.
import type { Bitmap1 } from '../wasm'

/** What the writers need of a bitmap (a `Bitmap1`, or a plain fake in unit tests). */
export type BitmapSource = Pick<Bitmap1, 'length' | 'height' | 'toPacked'>

export interface PngExportOptions {
  /** Dots per inch along and across the tape (PT-P710BT: 180). */
  dpi: number
}

export interface PdfExportOptions {
  dpi: number
  /** Physical tape width in dots (`PrintArea.tapeWidthDots`): the page height. The printable
   * band (the bitmap) is centred on it, like on the tape. */
  tapeWidthDots: number
  /** Blank tape before and after the printed dots (the printer's feed margin), in dots. */
  marginDots?: number
  /** Document title (PDF Info dictionary). */
  title?: string
}

/** 1 inch = 25.4 mm; PDF user space unit = 1/72 inch. */
const PT_PER_INCH = 72

/**
 * Row-major 1-bit rows (`ceil(length / 8)` bytes per row, MSB first, 1 = WHITE, 0 = ink), the
 * layout of both PNG grey 1-bit and PDF DeviceGray 1-bit. `filterByte` prefixes each row with a
 * PNG filter type 0.
 */
export function packRows(bitmap: BitmapSource, filterByte = false): Uint8Array {
  const w = bitmap.length
  const h = bitmap.height
  const stride = Math.ceil(h / 8) // core layout: line x at x·stride, dot y = bit 7 − y%8 of byte y/8
  const src = bitmap.toPacked()
  const rowBytes = Math.ceil(w / 8)
  const lead = filterByte ? 1 : 0
  const out = new Uint8Array((rowBytes + lead) * h).fill(255)
  for (let y = 0; y < h; y++) {
    const row = y * (rowBytes + lead)
    if (filterByte) out[row] = 0
    const byteY = y >> 3
    const bitY = 7 - (y & 7)
    for (let x = 0; x < w; x++) {
      if (((src[x * stride + byteY] ?? 0) >> bitY) & 1) {
        const at = row + lead + (x >> 3)
        out[at] = (out[at] ?? 0) & ~(1 << (7 - (x & 7)))
      }
    }
  }
  return out
}

/** zlib-wrapped deflate (RFC 1950) via CompressionStream. */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ------------------------------------------------------------------------------------------
// PNG
// ------------------------------------------------------------------------------------------

let crcTable: Uint32Array | undefined

/** CRC-32 (ISO-HDLC, the PNG chunk checksum). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = ~crc >>> 0
  for (const b of bytes) c = (crcTable[(c ^ b) & 255] ?? 0) ^ (c >>> 8)
  return ~c >>> 0
}

/** PNG signature: \x89 P N G \r \n \x1a \n (written in decimal). */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Pixels per metre for a dpi (pHYs): 180 dpi → 7087. */
export function pixelsPerMetre(dpi: number): number {
  return Math.round(dpi / 0.0254)
}

/** The bitmap as a 1-bit greyscale PNG whose pHYs makes it open at real size. */
export async function exportPng(bitmap: BitmapSource, opts: PngExportOptions): Promise<Blob> {
  const w = bitmap.length
  const h = bitmap.height
  if (w < 1 || h < 1) throw new Error('The label is empty.')
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, w)
  iv.setUint32(4, h)
  ihdr.set([1, 0, 0, 0, 0], 8) // bit depth 1, colour type 0 (grey), deflate, filter 0, no interlace
  const phys = new Uint8Array(9)
  const pv = new DataView(phys.buffer)
  const ppm = pixelsPerMetre(opts.dpi)
  pv.setUint32(0, ppm)
  pv.setUint32(4, ppm)
  phys[8] = 1 // unit: metre
  const idat = await zlibDeflate(packRows(bitmap, true))
  const parts = [Uint8Array.from(PNG_SIGNATURE), pngChunk('IHDR', ihdr), pngChunk('pHYs', phys), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  return new Blob(parts as BlobPart[], { type: 'image/png' })
}

// ------------------------------------------------------------------------------------------
// PDF
// ------------------------------------------------------------------------------------------

/** A PDF number: up to 3 decimals, no exponent, no trailing zeros. */
function pdfNum(n: number): string {
  const s = (Math.round(n * 1000) / 1000).toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}

/** A PDF text string as UTF-16BE hex with BOM (safe for any title). */
function pdfText(s: string): string {
  let hex = 'FEFF'
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return `<${hex}>`
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255)

/** Page size of a PDF export in mm: `[width along the tape, tape width]`. */
export function pdfPageMm(bitmap: Pick<BitmapSource, 'length'>, opts: Pick<PdfExportOptions, 'dpi' | 'tapeWidthDots' | 'marginDots'>): [number, number] {
  const m = Math.max(0, opts.marginDots ?? 0)
  return [((bitmap.length + 2 * m) * 25.4) / opts.dpi, (opts.tapeWidthDots * 25.4) / opts.dpi]
}

/**
 * A one-page PDF 1.4 at true physical size: the page is the label (length + feed margins) by
 * the tape width; the bitmap is a 1-bit DeviceGray image XObject placed at the band offset.
 */
export async function exportPdf(bitmap: BitmapSource, opts: PdfExportOptions): Promise<Blob> {
  const w = bitmap.length
  const h = bitmap.height
  if (w < 1 || h < 1) throw new Error('The label is empty.')
  const pt = (dots: number): number => (dots * PT_PER_INCH) / opts.dpi
  const margin = Math.max(0, opts.marginDots ?? 0)
  const tape = Math.max(h, opts.tapeWidthDots)
  const pageW = pt(w + 2 * margin)
  const pageH = pt(tape)
  // PDF y grows upwards: the band's bottom edge sits (tape − band) / 2 above the page bottom.
  const x = pt(margin)
  const y = pt((tape - h) / 2)
  const image = await zlibDeflate(packRows(bitmap, false))
  const content = ascii(`q\n${pdfNum(pt(w))} 0 0 ${pdfNum(pt(h))} ${pdfNum(x)} ${pdfNum(y)} cm\n/Im1 Do\nQ\n`)

  const chunks: Uint8Array[] = []
  let size = 0
  const offsets: number[] = []
  const push = (b: Uint8Array): void => {
    chunks.push(b)
    size += b.length
  }
  const obj = (n: number, dict: string, stream?: Uint8Array): void => {
    offsets[n] = size
    push(ascii(`${n} 0 obj\n${dict}\n`))
    if (stream) {
      push(ascii('stream\n'))
      push(stream)
      push(ascii('\nendstream\n'))
    }
    push(ascii('endobj\n'))
  }

  // Header + a comment with high bytes so tools treat the file as binary.
  push(ascii('%PDF-1.4\n'))
  push(Uint8Array.from([37, 226, 227, 207, 211, 10]))
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(pageW)} ${pdfNum(pageH)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`)
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Interpolate false /Filter /FlateDecode /Length ${image.length} >>`, image)
  obj(5, `<< /Length ${content.length} >>`, content)
  obj(6, `<< /Producer (ptouch studio)${opts.title ? ` /Title ${pdfText(opts.title)}` : ''} >>`)
  const xref = size
  let table = `xref\n0 7\n0000000000 65535 f \n`
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`
  push(ascii(`${table}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}
