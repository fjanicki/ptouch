// W1 — the wasm binding contract as TS consumers (W2/W3/W5) see it, in node via `initSync`.
import { describe, expect, it } from 'vitest'
import { loadWasmForTests, P710BT_STATUS_24MM, wasmMemoryBytes } from '../../helpers/wasm'
import {
  Bitmap1,
  decodeJob,
  encodeCode,
  encodeJob,
  isPtouchError,
  listModels,
  mediaForStatus,
  mediaForWidth,
  parseStatus,
  printArea,
  PrintSession,
  ptouchErrorCode,
  Raster,
  release,
  StatusFramer,
  VirtualPrinter,
  type SessionConfig,
  type SessionEvent,
  type SessionEventOf,
  type VirtualBehaviour,
} from '../../../src/wasm'

loadWasmForTests()

const MODEL = 'PT-P710BT'
const MEDIA = 'tze128-24'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    expect(isPtouchError(e)).toBe(true)
    return ptouchErrorCode(e)
  }
  expect.unreachable('expected a PtouchError')
}

/** An RGBA crisp plane: a solid bar at the left end plus a sparse dot grid. */
function labelRgba(length: number, height: number): Uint8Array {
  const rgba = new Uint8Array(length * height * 4).fill(255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < length; x++)
      if (x < 8 || (x % 7 === 0 && y % 5 === 0)) rgba.fill(0, (y * length + x) * 4, (y * length + x) * 4 + 3)
  return rgba
}

function makePage(length = 80): Bitmap1 {
  const area = printArea(MODEL, MEDIA)
  const r = new Raster(length, area.heightDots)
  r.blitCrisp(labelRgba(length, area.heightDots), length, area.heightDots, 1, 128)
  return r.finish()
}

describe('models and media', () => {
  it('lists models with media and caps', () => {
    const models = listModels()
    expect(models[0]?.name).toBe(MODEL)
    const p710 = models[0]!
    expect(p710.dpi).toBe(180)
    expect(p710.bluetooth).toBe(true)
    expect(p710.caps.autoCut).toBe(true)
    expect(p710.media.map((m) => m.id)).toContain(MEDIA)
    expect(models.length).toBeGreaterThan(5)
  })

  it('computes the print area', () => {
    const a = printArea(MODEL, MEDIA)
    expect(a).toMatchObject({ model: MODEL, mediaId: MEDIA, dpi: 180, minLengthDots: 3, maxLengthDots: 7086, defaultFeedDots: 14, maxFeedDots: 900 })
    expect(a.heightDots).toBeLessThanOrEqual(a.tapeWidthDots)
    expect(a.leftMarginPins + a.heightDots + a.rightMarginPins).toBe(128)
  })

  it('resolves media by width (3.5 mm → width byte 4) and by status bytes', () => {
    expect(mediaForWidth(MODEL, 3.5)).toMatchObject({ widthByte: 4, widthMm: 3.5, kind: 'tze' })
    expect(mediaForWidth(MODEL, 24).id).toBe(MEDIA)
    expect(mediaForWidth(MODEL, 24, 'tze').id).toBe(MEDIA)
    expect(mediaForStatus(MODEL, 0x18, 0x01).id).toBe(MEDIA)
    expect(codeOf(() => mediaForStatus(MODEL, 0x18, 0x00))).toBe('NO_MEDIA')
    expect(codeOf(() => mediaForWidth(MODEL, 36))).toBe('UNSUPPORTED_MEDIA')
    expect(codeOf(() => mediaForWidth(MODEL, Number.NaN))).toBe('INVALID_INPUT')
    expect(codeOf(() => mediaForWidth(MODEL, 24, 'bogus' as never))).toBe('INVALID_INPUT')
  })
})

describe('parseStatus', () => {
  it('decodes the real PT-P710BT fixture', () => {
    const s = parseStatus(P710BT_STATUS_24MM)
    expect(s).toMatchObject({
      modelName: MODEL,
      mediaWidthMm: 24,
      mediaId: MEDIA,
      mediaType: 'laminated',
      ready: true,
      error: false,
      turnedOff: false,
      errors: [],
      statusType: 'reply',
      phase: { kind: 'receiving', number: 0 },
      notification: 'none',
      tapeColor: { name: 'white', css: '#ffffff' },
      textColor: { name: 'black', css: '#000000' },
    })
    expect(s.raw).toEqual([...P710BT_STATUS_24MM])
    expect('percent' in s.battery).toBe(false) // optional fields are absent, not null
  })

  it('decodes errors with stable ids', () => {
    const raw = P710BT_STATUS_24MM.slice()
    raw[9] = 0x10 // cover open
    raw[18] = 0x02 // error
    const s = parseStatus(raw)
    expect(s.error).toBe(true)
    expect(s.ready).toBe(false)
    expect(s.errors).toEqual([{ id: 'cover-open', message: 'cover open' }])
  })
})

describe('encodeCode', () => {
  it('encodes QR / Code 128 / EAN-13 as whole-module matrices', () => {
    const qr = encodeCode({ symbology: 'qr', data: 'HELLO' })
    expect([qr.width, qr.height, qr.modules.length]).toEqual([21, 21, 441])
    expect(qr.modules.slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 0])
    const qrH = encodeCode({ symbology: 'qr', data: 'https://fjanicki.github.io/ptouch/', ecc: 'H' })
    const qrL = encodeCode({ symbology: 'qr', data: 'https://fjanicki.github.io/ptouch/', ecc: 'L' })
    expect(qrH.width).toBeGreaterThan(qrL.width)
    const c128 = encodeCode({ symbology: 'code128', data: '1234' })
    expect([c128.width, c128.height]).toEqual([57, 1])
    const ean = encodeCode({ symbology: 'ean13', data: '400638133393' })
    expect([ean.width, ean.height]).toEqual([95, 1])
    expect(encodeCode({ symbology: 'ean13', data: '4006381333931' })).toEqual(ean)
  })

  it('encodes square DataMatrix (ECC 200) symbols with the finder border and no quiet zone', () => {
    const a1 = encodeCode({ symbology: 'datamatrix', data: 'A1' })
    expect([a1.width, a1.height, a1.modules.length]).toEqual([10, 10, 100])
    // Solid L (left column, bottom row); alternating timing on the top row.
    expect(a1.modules.filter((_, i) => i % 10 === 0)).toEqual(Array(10).fill(1))
    expect(a1.modules.slice(90)).toEqual(Array(10).fill(1))
    expect(a1.modules.slice(0, 10)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
    const wifi = encodeCode({ symbology: 'datamatrix', data: 'WIFI:T:WPA;S:Home;P:secret123;;' })
    expect(wifi.width).toBe(wifi.height)
    expect(wifi.width).toBeLessThanOrEqual(22) // fits 12 mm tape at 3 dots per module
  })

  it('rejects bad data with INVALID_INPUT', () => {
    expect(codeOf(() => encodeCode({ symbology: 'ean13', data: '4006381333932' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'code128', data: 'héllo' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'qr', data: '' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'qr', data: 'x'.repeat(4000) }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'datamatrix', data: '' }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'datamatrix', data: 'x'.repeat(5000) }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeCode({ symbology: 'pdf417', data: 'x' } as never))).toBe('INVALID_INPUT')
  })
})

describe('Raster / Bitmap1', () => {
  it('blits codes with integer modules and protects them', () => {
    const qr = encodeCode({ symbology: 'qr', data: 'HELLO' })
    const r = new Raster(100, 40)
    r.blitCode(qr, 10, 2, 1, false)
    const bmp = r.finish()
    expect(bmp.get(10, 2)).toBe(true) // finder corner
    expect(bmp.get(17, 2)).toBe(false) // separator
    bmp.free()
    expect(codeOf(() => new Raster(10, 10).blitCode({ width: 2, height: 2, modules: [1] }, 0, 0, 1, false))).toBe('INVALID_INPUT')
    expect(codeOf(() => new Raster(10, 10).blitCode(qr, 0, 0, 0, false))).toBe('INVALID_INPUT')
  })

  it('dithers photos with ToneOptions', () => {
    const w = 32
    const h = 16
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([i % 256, i % 256, i % 256, 255], i * 4)
    const a = new Raster(w, h)
    a.blitTone(rgba, w, h, 0, 0)
    const b = new Raster(w, h)
    b.blitTone(rgba, w, h, 0, 0, { dither: 'atkinson', contrast: 20 })
    const ta = a.finish()
    const tb = b.finish()
    expect(ta.toPacked()).not.toEqual(tb.toPacked())
    expect(codeOf(() => new Raster(w, h).blitTone(rgba.subarray(4), w, h, 0, 0))).toBe('DATA_LENGTH')
    ta.free()
    tb.free()
  })

  it('builds bitmaps from luma / RGBA and crops', () => {
    const w = 10
    const h = 8
    const luma = new Uint8Array(w * h).fill(255)
    luma[3] = 0 // (3, 0) dark
    const b = Bitmap1.fromLuma(luma, w, h)
    expect(b.get(3, 0)).toBe(true)
    expect(b.get(4, 0)).toBe(false)
    expect(b.trimBlank()).toEqual(new Uint32Array([3, 3]))
    const c = b.cropLines(3, 4)
    expect([c.length, c.height, c.get(0, 0)]).toEqual([1, 8, true])
    const rgba = new Uint8Array(w * h * 4).fill(255)
    rgba.set([0, 0, 0, 255], 3 * 4)
    const fromRgba = Bitmap1.fromRgba(rgba, w, h, { dither: 'threshold', level: 128 })
    expect(fromRgba.toPacked()).toEqual(b.toPacked())
    expect(b.toRgba(0xffffff, 0x000000).slice(12, 16)).toEqual(new Uint8Array([0, 0, 0, 255]))
    for (const x of [b, c, fromRgba]) x.free()
  })
})

describe('encodeJob / decodeJob', () => {
  it('encodes copies in one job ending in 0x1A and decodes them back', () => {
    const page = makePage()
    const packed = page.toPacked()
    const job = encodeJob(MODEL, MEDIA, [page], { copies: 2, cut: 'every-label' })
    expect(job.pageCount).toBe(2)
    expect(job.modelName).toBe(MODEL)
    expect(job.mediaWidthByte).toBe(24)
    expect(job.highResolution).toBe(false)
    expect([...job.pageLines()]).toEqual([80, 80])
    expect(job.totalLines).toBe(160)
    const bytes = job.toBytes()
    expect(job.byteLength).toBe(bytes.length)
    expect(bytes[bytes.length - 1]).toBe(0x1a)

    // Same bytes as repeating the page by hand.
    const p2 = makePage()
    const manual = encodeJob(MODEL, MEDIA, [p2.clone(), p2], { cut: 'every-label' })
    expect(manual.toBytes()).toEqual(bytes)

    const d = decodeJob(MODEL, bytes)
    expect(d.pageCount).toBe(2)
    const pages = d.pages()
    expect(pages[0]!.toPacked()).toEqual(packed)
    expect(d.violations()).toEqual([])
    expect(d.commands().some((c) => /^RasterLine\(\d+ bytes\)$/.test(c))).toBe(true)
    expect(d.commands()).toContain('PrintLast')
    for (const x of [...pages, d, job, manual]) x.free()
  })

  it('consumes the page handles', () => {
    const page = makePage()
    encodeJob(MODEL, MEDIA, [page]).free()
    expect(() => page.length).toThrow()
  })

  it('rejects a repeated, freed or foreign page with INVALID_INPUT before consuming any', () => {
    const a = makePage()
    const b = makePage()
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [a, b, a]))).toBe('INVALID_INPUT')
    expect(a.length).toBeGreaterThan(0) // nothing consumed
    expect(b.length).toBeGreaterThan(0)
    const freed = makePage()
    freed.free()
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [a, freed]))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [a, 5 as unknown as Bitmap1]))).toBe('INVALID_INPUT')
    expect(a.length).toBeGreaterThan(0)
    // No leak: repeated failures do not grow wasm memory.
    const before = wasmMemoryBytes()
    const big = Bitmap1.fromPacked(7000, 128, new Uint8Array(7000 * 16)) // 112 KB per page
    for (let i = 0; i < 30; i++) codeOf(() => encodeJob(MODEL, MEDIA, [big, b, b]))
    expect(big.length).toBe(7000)
    big.free()
    expect(wasmMemoryBytes() - before).toBeLessThan(512 * 1024) // a leak would be ≥ 3.3 MB
    encodeJob(MODEL, MEDIA, [a, b]).free()
  })

  it('[Symbol.dispose] (`using`) is safe on a consumed handle', () => {
    const r = new Raster(40, printArea(MODEL, MEDIA).heightDots)
    const bm = r.finish()
    expect(() => (r as unknown as Disposable)[Symbol.dispose]()).not.toThrow()
    ;(bm as unknown as Disposable)[Symbol.dispose]()
    expect(() => (bm as unknown as Disposable)[Symbol.dispose]()).not.toThrow()
  })

  it('StatusFramer reassembles split frames and resyncs after noise / truncation', () => {
    const f = new StatusFramer()
    f.push(new Uint8Array([0xaa, 0xbb]))
    f.push(P710BT_STATUS_24MM.subarray(0, 7))
    expect(f.nextFrame()).toBeUndefined()
    f.push(P710BT_STATUS_24MM.subarray(7))
    const s = f.nextFrame()
    expect(s?.mediaWidthMm).toBe(24)
    expect(s?.raw).toEqual(Array.from(P710BT_STATUS_24MM))
    expect(f.discardedBytes).toBe(2)
    f.push(new Uint8Array([...P710BT_STATUS_24MM.subarray(0, 10), ...P710BT_STATUS_24MM]))
    expect(f.nextFrame()?.raw).toEqual(Array.from(P710BT_STATUS_24MM))
    expect(f.nextFrame()).toBeUndefined()
    release(f)
  })

  it('maps encoder errors to codes', () => {
    expect(codeOf(() => encodeJob(MODEL, MEDIA, []))).toBe('EMPTY')
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [Bitmap1.fromPacked(10, 8, new Uint8Array(10))]))).toBe('BITMAP_SIZE')
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [makePage()], { copies: 0 }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [makePage()], { feedMarginDots: 5000 }))).toBe('INVALID_INPUT')
    expect(codeOf(() => encodeJob(MODEL, 'tze560-24', [makePage()]))).toBe('UNSUPPORTED_MEDIA')
    expect(codeOf(() => encodeJob(MODEL, MEDIA, [makePage(8000)]))).toBe('TOO_LONG')
  })

  it('applies high resolution and mirror', () => {
    const hi = encodeJob(MODEL, MEDIA, [makePage(40)], { highResolution: true })
    expect([...hi.pageLines()]).toEqual([80])
    expect(hi.highResolution).toBe(true)
    const a = encodeJob(MODEL, MEDIA, [makePage(40)])
    const m = encodeJob(MODEL, MEDIA, [makePage(40)], { mirror: true })
    expect(m.toBytes()).not.toEqual(a.toBytes())
    for (const x of [hi, a, m]) x.free()
  })
})

/** Fake-clock driver: PrintSession ↔ VirtualPrinter with RFCOMM-like 7 + 25 fragmentation. */
class Rig {
  now = 1000
  events: SessionEvent[] = []
  readonly session: PrintSession
  readonly printer: VirtualPrinter

  constructor(behaviour?: VirtualBehaviour, config?: SessionConfig, model?: string) {
    this.printer = new VirtualPrinter(MODEL, MEDIA, behaviour, { replyDelayMs: 20, basePrintMs: 300 })
    this.session = new PrintSession(model, config)
  }

  /** One step in the core harness order: pump, advance, deliver, timeout. */
  step(): boolean {
    this.pump()
    const next = Math.min(this.printer.nextOutputAt() ?? Infinity, this.session.pollTimeout() ?? Infinity)
    if (!Number.isFinite(next)) return false
    this.now = Math.max(this.now, next)
    for (let f = this.printer.pollOutput(this.now); f; f = this.printer.pollOutput(this.now)) {
      this.session.handleInput(f.subarray(0, 7), this.now)
      this.session.handleInput(f.subarray(7), this.now)
    }
    const t = this.session.pollTimeout()
    if (t !== undefined && t <= this.now) this.session.handleTimeout(this.now)
    this.pump()
    return true
  }

  pump(): void {
    for (let b = this.session.pollTransmit(); b; b = this.session.pollTransmit()) this.printer.handleInput(b, this.now)
    for (let e = this.session.pollEvent(); e; e = this.session.pollEvent()) this.events.push(e)
  }

  runUntil(pred: (e: SessionEvent) => boolean, maxSteps = 10_000): SessionEvent | undefined {
    let seen = 0
    for (let i = 0; i < maxSteps; i++) {
      const hit = this.events.slice(seen).find(pred)
      if (hit) return hit
      seen = this.events.length
      if (!this.step()) break
    }
    return this.events.slice(seen).find(pred)
  }

  free(): void {
    this.session.free()
    this.printer.free()
  }
}

const isType =
  <T extends SessionEvent['type']>(t: T) =>
  (e: SessionEvent): e is SessionEventOf<T> =>
    e.type === t

describe('PrintSession ↔ VirtualPrinter', () => {
  it('handshakes, prints two copies and reports progress from status frames', () => {
    const rig = new Rig()
    expect(rig.session.state()).toEqual({ state: 'idle' })
    rig.session.connect(rig.now)
    expect(rig.session.state()).toEqual({ state: 'handshaking', attempt: 1 })
    const ready = rig.runUntil(isType('ready'))
    expect(ready?.type).toBe('ready')
    if (ready?.type === 'ready') expect(ready.status.mediaId).toBe(MEDIA)
    expect(rig.session.state()).toEqual({ state: 'ready' })
    expect(rig.session.modelName).toBe(MODEL)
    expect(rig.session.lastStatus()?.mediaId).toBe(MEDIA)

    const page = makePage()
    const packed = page.toPacked()
    const job = encodeJob(MODEL, MEDIA, [page], { copies: 2 })
    rig.session.submit(job, rig.now)
    expect(job.pageCount).toBe(2) // submit borrows the job
    expect(rig.session.state()).toEqual({ state: 'printing', page: 1, of: 2 })
    expect(codeOf(() => rig.session.submit(job, rig.now))).toBe('BUSY')
    expect(codeOf(() => rig.session.requestStatus(rig.now))).toBe('BUSY')
    rig.events = []
    expect(rig.runUntil(isType('job-completed'))).toBeDefined()
    const progress = rig.events.filter((e) => e.type !== 'status').map((e) => ('page' in e ? `${e.type}:${e.page}` : e.type))
    expect(progress).toEqual(['page-started:1', 'page-completed:1', 'page-started:2', 'page-completed:2', 'job-completed'])
    const phases = rig.events.flatMap((e) => (e.type === 'status' ? [`${e.status.statusType}/${e.status.phase.kind}`] : []))
    expect(phases).toContain('phase-change/printing')
    expect(phases).toContain('printing-completed/printing')
    expect(rig.printer.printedCount).toBe(2)
    const printed = rig.printer.printedPage(0)!
    expect(printed.toPacked()).toEqual(packed) // label orientation, same as the preview
    expect(rig.printer.violations()).toEqual([])

    // Explicit status request once idle again.
    rig.runUntil(() => false, 50)
    rig.session.requestStatus(rig.now)
    rig.events = []
    expect(rig.runUntil(isType('status'))).toBeDefined()
    for (const x of [printed, job]) x.free()
    rig.free()
  })

  it('reports a silent printer as a handshake timeout', () => {
    const rig = new Rig({ kind: 'silent' }, { statusTimeoutMs: 500, statusAttempts: 2 })
    rig.session.connect(rig.now)
    const failed = rig.runUntil(isType('failed'))
    expect(failed?.type).toBe('failed')
    if (failed?.type === 'failed') {
      expect(failed.error.code).toBe('TIMEOUT')
      expect(failed.error.timeout).toBe('handshake')
      expect(failed.resumeFromPage).toBeUndefined()
    }
    expect(rig.session.state()).toEqual({ state: 'failed' })
    rig.free()
  })

  it('reports cover open on page 2 with printer errors and a resume page', () => {
    const rig = new Rig({ kind: 'cover-open-on-page', page: 2 })
    rig.session.connect(rig.now)
    rig.runUntil(isType('ready'))
    rig.session.submit(encodeJob(MODEL, MEDIA, [makePage()], { copies: 3 }), rig.now)
    const failed = rig.runUntil(isType('failed'))
    expect(failed?.type).toBe('failed')
    if (failed?.type === 'failed') {
      expect(failed.error.code).toBe('PRINTER')
      expect(failed.error.printerErrors.map((e) => e.id)).toContain('cover-open')
      expect(failed.resumeFromPage).toBe(2)
    }
    rig.free()
  })

  it('rejects a job for the wrong tape in preflight', () => {
    const rig = new Rig()
    rig.session.connect(rig.now)
    rig.runUntil(isType('ready'))
    const area = printArea(MODEL, 'tze128-12')
    const r = new Raster(60, area.heightDots)
    const job = encodeJob(MODEL, 'tze128-12', [r.finish()])
    expect(codeOf(() => rig.session.submit(job, rig.now))).toBe('MEDIA_MISMATCH')
    job.free()
    rig.free()
  })

  it('cancels a job with a CANCELLED failure', () => {
    const rig = new Rig()
    rig.session.connect(rig.now)
    rig.runUntil(isType('ready'))
    rig.session.submit(encodeJob(MODEL, MEDIA, [makePage()], { copies: 2 }), rig.now)
    rig.runUntil(isType('page-started'))
    rig.session.cancel(rig.now)
    const failed = rig.runUntil(isType('failed'))
    if (failed?.type === 'failed') expect(failed.error.code).toBe('CANCELLED')
    else expect.unreachable('no failed event')
    rig.free()
  })

  it('validates constructor arguments', () => {
    expect(codeOf(() => new PrintSession('PT-NOPE'))).toBe('UNKNOWN_MODEL')
    expect(codeOf(() => new PrintSession(undefined, { statusTimeoutMs: 'x' } as never))).toBe('INVALID_INPUT')
    new PrintSession('', { maxTicks: 3, phaseFrameWaitMs: 100 }).free()
    expect(codeOf(() => new VirtualPrinter(MODEL, 'nope'))).toBe('UNSUPPORTED_MEDIA')
    expect(codeOf(() => new VirtualPrinter(MODEL, MEDIA, { kind: 'cover-open-on-page' } as never))).toBe('INVALID_INPUT')
  })

  it('exposes the virtual idle status and no-media behaviour', () => {
    const vp = new VirtualPrinter(MODEL, MEDIA)
    expect(parseStatus(vp.idleStatus())).toMatchObject({ modelName: MODEL, mediaId: MEDIA, ready: true })
    expect(vp.isPrinting(0)).toBe(false)
    const none = new VirtualPrinter(MODEL, MEDIA, { kind: 'no-media' })
    const s = parseStatus(none.idleStatus())
    expect(s.mediaType).toBe('none')
    expect(s.errors.map((e) => e.id)).toContain('no-media')
    vp.free()
    none.free()
    release(null)
  })
})
