// P4 — PNG and PDF writers, parsed back byte by byte (no wasm: a fake bitmap in the core's
// packed layout, line x at x·stride, dot y = bit 7 − y%8).
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32, exportPdf, exportPng, packRows, pdfPageMm, pixelsPerMetre, type BitmapSource } from '../../../src/render/export'

/** A fake Bitmap1 with ink where `ink(x, y)`. */
function fake(length: number, height: number, ink: (x: number, y: number) => boolean): BitmapSource {
  const stride = Math.ceil(height / 8)
  const data = new Uint8Array(length * stride)
  for (let x = 0; x < length; x++) for (let y = 0; y < height; y++) if (ink(x, y)) data[x * stride + (y >> 3)]! |= 1 << (7 - (y & 7))
  return { length, height, toPacked: () => data.slice() }
}

const diag = fake(19, 11, (x, y) => x === y || (x === 18 && y === 0))

async function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer())
}

interface Chunk {
  type: string
  data: Uint8Array
  crcOk: boolean
}

function chunks(png: Uint8Array): Chunk[] {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: Chunk[] = []
  for (let at = 8; at < png.length; ) {
    const len = v.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    out.push({ type, data, crcOk: crc32(png.subarray(at + 4, at + 8 + len)) === v.getUint32(at + 8 + len) })
    at += 12 + len
  }
  return out
}

describe('packRows', () => {
  it('turns line-major dots into row-major rows, ink = 0 (black)', () => {
    const rows = packRows(diag)
    const rowBytes = 3
    expect(rows.length).toBe(rowBytes * 11)
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 19; x++) {
        const bit = ((rows[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1
        expect(bit, `${x},${y}`).toBe(x === y || (x === 18 && y === 0) ? 0 : 1)
      }
    }
    const filtered = packRows(diag, true)
    expect(filtered.length).toBe((rowBytes + 1) * 11)
    expect(filtered[0]).toBe(0)
    expect(filtered[rowBytes + 1]).toBe(0)
  })
})

describe('PNG export', () => {
  it('has the signature, IHDR 1-bit grey, pHYs 180 dpi and valid CRCs', async () => {
    const png = await bytesOf(await exportPng(diag, { dpi: 180 }))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const cs = chunks(png)
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND'])
    expect(cs.every((c) => c.crcOk)).toBe(true)
    const ihdr = new DataView(cs[0]!.data.buffer, cs[0]!.data.byteOffset, 13)
    expect([ihdr.getUint32(0), ihdr.getUint32(4), ...cs[0]!.data.subarray(8)]).toEqual([19, 11, 1, 0, 0, 0, 0])
    const phys = new DataView(cs[1]!.data.buffer, cs[1]!.data.byteOffset, 9)
    expect(pixelsPerMetre(180)).toBe(7087)
    expect([phys.getUint32(0), phys.getUint32(4), cs[1]!.data[8]]).toEqual([7087, 7087, 1])
  })

  it('IDAT inflates to the packed rows with filter bytes', async () => {
    const png = await bytesOf(await exportPng(diag, { dpi: 180 }))
    const idat = chunks(png).find((c) => c.type === 'IDAT')!
    expect(new Uint8Array(inflateSync(idat.data))).toEqual(packRows(diag, true))
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082)
  })

  it('refuses an empty bitmap', async () => {
    await expect(exportPng(fake(0, 70, () => false), { dpi: 180 })).rejects.toThrow(/empty/)
  })
})

describe('PDF export', () => {
  // 12 mm tape: 70 printed pins of 84; 2 mm feed margin ≈ 14 dots.
  const bmp = fake(200, 70, (x, y) => (x + y) % 3 === 0)
  const opts = { dpi: 180, tapeWidthDots: 84, marginDots: 14, title: 'Shelf 3 — “screws”' }

  it('is a PDF 1.4 whose xref offsets point at each object', async () => {
    const pdf = await bytesOf(await exportPdf(bmp, opts))
    const text = new TextDecoder('latin1').decode(pdf)
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const rows = text.slice(startxref).split('\n').slice(2, 9)
    expect(rows[0]).toBe('0000000000 65535 f ')
    for (let n = 1; n <= 6; n++) {
      const row = rows[n]!
      expect(row).toMatch(/^\d{10} 00000 n $/)
      expect(row.length + 1).toBe(20) // every xref entry is exactly 20 bytes
      const off = Number(row.slice(0, 10))
      expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`)
    }
    expect(text).toContain('/Size 7 /Root 1 0 R /Info 6 0 R')
  })

  it('MediaBox is the label length (with feed margins) by the tape width', async () => {
    const text = new TextDecoder('latin1').decode(await bytesOf(await exportPdf(bmp, opts)))
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
    const [wMm, hMm] = [Number(box?.[1]) * (25.4 / 72), Number(box?.[2]) * (25.4 / 72)]
    expect(wMm).toBeCloseTo(((200 + 28) * 25.4) / 180, 2)
    expect(hMm).toBeCloseTo((84 * 25.4) / 180, 2) // 11.85 mm: the physical 12 mm tape
    expect(pdfPageMm(bmp, opts)[0]).toBeCloseTo(wMm, 2)
    expect(pdfPageMm(bmp, opts)[1]).toBeCloseTo(hMm, 2)
    // the image is placed at true size, centred across the tape
    const cm = /([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(text)
    expect(Number(cm?.[1])).toBeCloseTo((200 * 72) / 180, 2)
    expect(Number(cm?.[2])).toBeCloseTo((70 * 72) / 180, 2)
    expect(Number(cm?.[3])).toBeCloseTo((14 * 72) / 180, 2)
    expect(Number(cm?.[4])).toBeCloseTo((7 * 72) / 180, 2)
  })

  it('the image XObject is 1-bit DeviceGray Flate data equal to the packed rows', async () => {
    const pdf = await bytesOf(await exportPdf(bmp, opts))
    const text = new TextDecoder('latin1').decode(pdf)
    const head = /4 0 obj\n<< \/Type \/XObject \/Subtype \/Image \/Width 200 \/Height 70 \/ColorSpace \/DeviceGray \/BitsPerComponent 1 \/Interpolate false \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text)
    expect(head).not.toBeNull()
    const start = (head?.index ?? 0) + (head?.[0].length ?? 0)
    const len = Number(head?.[1])
    expect(text.slice(start + len, start + len + 10)).toBe('\nendstream')
    expect(new Uint8Array(inflateSync(pdf.subarray(start, start + len)))).toEqual(packRows(bmp))
  })

  it('encodes the title as UTF-16 and keeps protocol bytes out', async () => {
    const text = new TextDecoder('latin1').decode(await bytesOf(await exportPdf(bmp, opts)))
    expect(text).toMatch(/\/Title <FEFF[0-9A-F]+>/)
    expect(text).toContain('<FEFF005300680065006C0066') // "Shelf"
  })
})
