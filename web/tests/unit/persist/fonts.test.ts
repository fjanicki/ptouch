// P4 — uploaded fonts: signature/size validation, name-table parsing (TTF and WOFF), and the
// store (memory area; node has no IndexedDB or FontFace).
import { describe, expect, it } from 'vitest'
import { memoryBackend } from '../../../src/doc/persist'
import { MAX_FONT_BYTES, MAX_FONTS, checkFontFile, fontDisplayName, nameFromFileName, openFontStore, parseNameTable, sniffFontFormat } from '../../../src/doc/persist-fonts'
import { CONTENT_REF_RE } from '../../../src/doc/schema'
import { makeTestFont, toWoff } from './font-fixture'

const bytes = (...b: number[]): Uint8Array => Uint8Array.from([...b, ...new Array<number>(12).fill(0)])
const file = (data: Uint8Array, name = 'Test.ttf'): File => new File([data.slice()], name)

describe('font file validation', () => {
  it('recognises the four signatures', () => {
    expect(sniffFontFormat(bytes(0, 1, 0, 0))).toBe('ttf')
    expect(sniffFontFormat(bytes(...[...'true'].map((c) => c.charCodeAt(0))))).toBe('ttf')
    expect(sniffFontFormat(bytes(...[...'OTTO'].map((c) => c.charCodeAt(0))))).toBe('otf')
    expect(sniffFontFormat(bytes(...[...'wOFF'].map((c) => c.charCodeAt(0))))).toBe('woff')
    expect(sniffFontFormat(bytes(...[...'wOF2'].map((c) => c.charCodeAt(0))))).toBe('woff2')
  })

  it('rejects other files, empty files and oversized files with a message', () => {
    expect(sniffFontFormat(bytes(...[...'%PDF'].map((c) => c.charCodeAt(0))))).toBeUndefined()
    expect(sniffFontFormat(new Uint8Array([0, 1, 0, 0]))).toBeUndefined() // too short
    expect(() => checkFontFile(bytes(137, 80, 78, 71))).toThrow(/TTF, OTF, WOFF or WOFF2/)
    expect(() => checkFontFile(new Uint8Array(0))).toThrow(/empty/)
    expect(() => checkFontFile(bytes(0, 1, 0, 0), MAX_FONT_BYTES + 1)).toThrow(/too large/)
    expect(checkFontFile(bytes(0, 1, 0, 0), MAX_FONT_BYTES)).toBe('ttf')
  })

  it('names a font after its file when the name table cannot be read', () => {
    expect(nameFromFileName('Inter-Bold_v4.ttf')).toBe('Inter Bold v4')
    expect(nameFromFileName('C:\\fonts\\My Font.WOFF2')).toBe('My Font')
    expect(nameFromFileName('.ttf')).toBe('Uploaded font')
    expect(nameFromFileName(`${'x'.repeat(300)}.otf`)).toHaveLength(100)
  })
})

describe('name table', () => {
  it('reads the typographic family and subfamily of a TrueType file', async () => {
    const font = makeTestFont({ family: 'Gridfinity Sans', subfamily: 'Bold' })
    expect(await fontDisplayName(font, 'ttf')).toBe('Gridfinity Sans Bold')
    expect(await fontDisplayName(makeTestFont({ family: 'Plain' }), 'ttf')).toBe('Plain')
  })

  it('reads it through WOFF (zlib-compressed tables)', async () => {
    const woff = await toWoff(makeTestFont({ family: 'Woffy', subfamily: 'Light' }))
    expect(sniffFontFormat(woff)).toBe('woff')
    expect(await fontDisplayName(woff, 'woff')).toBe('Woffy Light')
  })

  it('prefers Windows US-English records and IDs 16/17 over 1/2', () => {
    // count 3: mac family "Mac", windows family (ID 1) "Win", windows typographic (ID 16) "Typo"
    const strings = [[...'Mac'].map((c) => c.charCodeAt(0)), [...'Win'].flatMap((c) => [0, c.charCodeAt(0)]), [...'Typo'].flatMap((c) => [0, c.charCodeAt(0)])]
    const recs: number[][] = [
      [1, 0, 0, 1],
      [3, 1, 0x409, 1],
      [3, 1, 0x409, 16],
    ]
    const head = [0, 3, 6 + 3 * 12] // format, count, string storage offset
    const out: number[] = []
    const u16 = (v: number) => out.push(v >> 8, v & 255)
    head.forEach(u16)
    let off = 0
    recs.forEach(([p, e, l, id], i) => {
      ;[p, e, l, id, strings[i]?.length ?? 0, off].forEach((v) => u16(v ?? 0))
      off += strings[i]?.length ?? 0
    })
    out.push(...strings.flat())
    expect(parseNameTable(Uint8Array.from(out))).toEqual({ family: 'Typo' })
  })

  it('never throws on garbage', async () => {
    expect(parseNameTable(new Uint8Array([0, 0, 0, 200, 0, 0]))).toEqual({})
    const broken = makeTestFont()
    broken.fill(255, 20, 200) // corrupt the table directory
    expect(await fontDisplayName(broken, 'ttf')).toBeUndefined()
    expect(await fontDisplayName(bytes(...[...'wOF2'].map((c) => c.charCodeAt(0))), 'woff2')).toBeUndefined()
  })
})

describe('font store', () => {
  const open = (verify?: () => Promise<void>) => openFontStore({ area: memoryBackend().blobs, now: () => Date.parse('2026-10-08T12:00:00Z'), ...(verify ? { verify } : {}) })

  it('adds, lists, gets and removes a font by content ref', async () => {
    const store = open()
    const font = makeTestFont({ family: 'Box' })
    const info = await store.add(file(font, 'box.ttf'))
    expect(info).toMatchObject({ family: 'Box', fileName: 'box.ttf', format: 'ttf', size: font.length, addedAt: '2026-10-08T12:00:00.000Z' })
    expect(info.ref).toMatch(CONTENT_REF_RE)
    expect(await store.list()).toEqual([info])
    const blob = await store.get(info.ref)
    expect(blob?.type).toBe('font/ttf')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(font)
    await store.remove(info.ref)
    expect(await store.list()).toEqual([])
    expect(await store.get(info.ref)).toBeUndefined()
  })

  it('dedupes equal content and falls back to the file name for WOFF2', async () => {
    const store = open()
    const font = makeTestFont()
    const a = await store.add(file(font, 'a.ttf'))
    const b = await store.add(file(font, 'b.ttf'))
    expect(b).toEqual(a)
    expect(await store.list()).toHaveLength(1)
    const w2 = await store.add(file(bytes(...[...'wOF2'].map((c) => c.charCodeAt(0)), 9), 'Brand_Sans-Medium.woff2'))
    expect(w2).toMatchObject({ family: 'Brand Sans Medium', format: 'woff2' })
  })

  it('rejects bad files before storing them', async () => {
    const store = open()
    await expect(store.add(file(new TextEncoder().encode('<svg>not a font</svg>'), 'x.ttf'))).rejects.toThrow(/not a font file/)
    const huge = { size: MAX_FONT_BYTES + 1, name: 'huge.ttf', arrayBuffer: () => Promise.reject(new Error('must not be read')) } as unknown as File
    await expect(store.add(huge)).rejects.toThrow(/too large/)
    expect(await store.list()).toEqual([])
  })

  it('stores only fonts the browser accepted (verify)', async () => {
    const store = open(() => Promise.reject(new Error('The browser could not read this font.')))
    await expect(store.add(file(makeTestFont()))).rejects.toThrow(/could not read/)
    expect(await store.list()).toEqual([])
  })

  it(`keeps at most ${MAX_FONTS} fonts`, async () => {
    const store = open()
    for (let i = 0; i < MAX_FONTS; i++) await store.add(file(makeTestFont({ boxWidth: 100 + i })))
    await expect(store.add(file(makeTestFont({ boxWidth: 900 })))).rejects.toThrow(/already have 50 fonts/)
    // re-adding an existing font is still fine
    await expect(store.add(file(makeTestFont({ boxWidth: 100 })))).resolves.toMatchObject({ format: 'ttf' })
  })
})
