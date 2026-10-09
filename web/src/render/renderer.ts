// W3 — LabelDoc → Bitmap1 (ARCHITECTURE.md §5.1–§5.2). Canvas2D (OffscreenCanvas where
// available) draws the crisp plane at 3×; photos go through Raster.blitTone; codes through
// encodeCode + Raster.blitCode (never via canvas). Compositing order: tone → crisp → codes.
//
// One renderer, two outputs: the Bitmap1 returned here is both the preview and the printed
// page. Canvas x = along the label (column 0 = left end as read), y = across the tape (row 0 =
// top of the printable band). The core encoder handles the printer's feed order.
import { Raster, release, type Bitmap1, type ModuleMatrix, type ToneOptions } from '../wasm'
import type { CodeItem, IconItem, ImageItem, Item, LabelDoc, Rotation, ShapeItem, TextItem } from '../doc/schema'
import { canvasReadbackIsNoisy } from './antifp'
import { context2d, createCanvas, rgbaBytes, type AnyCanvas, type Ctx2D } from './canvas'
import { chooseModuleDots, codeMatrix, humanReadable, isLinear, padMatrix, quietModules, repeatRow, rotateMatrix, tapeMarginDots } from './codes'
import { CODE_TEXT_FONT, MIN_QUALITY_CAP_MM, activeCustomFamily, ensureFonts, fontDef, isFaceReady, resolveWeight, textFaceReady } from './fonts'
import { loadIcons, loadedIcons } from './icon-set'
import type { IconDef } from './icons'
import { MAX_IMAGE_DOTS, decodeImage, imageSize, resolveImageBlob, type RgbaImage } from './images'
import { contentLength, flowSettings, layoutFlow, layoutFree, type FlowLayout, type FramedItem, type MeasuredItem } from './layout'
import { DEFAULT_CRISP_FACTOR, MIN_SHRINK, canvasMeasure, drawTextBlock, faceMetrics, fitTextBlock, lineHeightOf, pixelGrid, shrinkFactor, sizeTextBlock, splitLines } from './text'
import type { ItemBox, RenderOptions, RenderResult, RenderTarget, RenderWarning, TextRenderInfo } from './types'
import { dotsToMm, mmToDots } from './units'
import { wifiWarnings } from './wifi'

/** Widest crisp canvas drawn at once (px); longer labels are drawn in tiles. */
const MAX_TILE_PX = 8190
/** Below this cap-to-descender height text prints poorly at 180 dpi. */
const SMALL_TEXT_MM = 2
/** Narrowest module that scans reliably at 180 dpi (2 dots = 0.28 mm). */
const MIN_SCANNABLE_MODULE_MM = 0.25
/** Shortest bars we accept silently. */
const MIN_BAR_MM = 3

/** Content drawn on the crisp plane, in px, inside a box of `w × h` px at the origin. */
type CrispDraw = (ctx: Ctx2D, w: number, h: number, f: number) => void

/** One code blit relative to the item box (dots, unrotated). `m` already carries the quiet
 * zone as light modules (codes.ts padMatrix), so it is blitted with `quietZone = false`. */
interface CodeBlit {
  m: ModuleMatrix
  dx: number
  dy: number
  md: number
}

/** An item measured and ready to draw. Sizes in dots, unrotated. */
interface Prepared {
  id: string
  w: number
  h: number
  spacer?: boolean
  crisp?: CrispDraw
  /** Horizontal clip slack in px (italic overhang). */
  clipSlack?: number
  tone?: { img: RgbaImage; opts: ToneOptions }
  codes?: CodeBlit[]
  /** Content taller than the band it was given. */
  tooTall?: boolean
  /** Already rotated (images are decoded rotated): `w`/`h` are the final box. */
  prerotated?: boolean
  /** A linear code with `moduleDots: 'auto'` (sized to a fixed label length when there is one). */
  autoLinear?: boolean
  /** A non-empty text block: how it was sized (`RenderResult.texts`). */
  text?: TextRenderInfo
}

interface Ctx {
  f: number
  dpi: number
  mctx: Ctx2D
  warn: (w: RenderWarning) => void
  loadBlob?: RenderOptions['loadBlob']
  /** Unprinted tape beyond the band edge usable as a code's vertical quiet zone (0 when a
   * label frame or free-layout frame borders the code). */
  marginDots: number
  /** Length a linear `'auto'` code may take on a fixed-length label (dots, incl. its zone). */
  autoLinearW?: number
}

// ------------------------------------------------------------------------------------------
// Measuring canvas (shared, tiny)
// ------------------------------------------------------------------------------------------

let measureCtx: Ctx2D | undefined
function measuring(): Ctx2D {
  measureCtx ??= context2d(createCanvas(16, 16), false)
  return measureCtx
}

// ------------------------------------------------------------------------------------------
// Items
// ------------------------------------------------------------------------------------------

function prepareText(item: TextItem, band: number, c: Ctx, maxW?: number, scale = 1): Prepared {
  const lines = splitLines(item.text)
  if (lines.every((l) => l.trim() === '')) return { id: item.id, w: 0, h: 0 }
  const { f, dpi } = c
  const face = faceMetrics(c.mctx, item, textFaceReady(item))
  const measure = canvasMeasure(c.mctx, item)
  const pixel = pixelGrid(item)
  const sized = sizeTextBlock(lines, face, { size: item.size, align: item.align, invert: item.invert, lineHeight: lineHeightOf(item), ...(item.clipTall ? { clipTall: true } : {}) }, measure, {
    bandPx: band * f,
    f,
    dpi,
    pixel,
    ...(scale < 1 ? { scale } : {}),
    ...(maxW !== undefined ? { maxWPx: maxW * f } : {}),
  })
  const { block } = sized
  const w = Math.ceil(sized.wPx / f - 1e-6)
  const h = Math.ceil(sized.hPx / f - 1e-6)
  const lineMm = dotsToMm(block.lineBox / f, dpi)
  if (lineMm < SMALL_TEXT_MM) {
    c.warn({ code: 'small-text', itemId: item.id, message: `Text is only ${lineMm.toFixed(1)} mm tall and may be hard to read. Use fewer lines or wider tape.` })
  }
  if (sized.reduced) c.warn({ code: 'content-overflow', itemId: item.id, message: 'Text is taller than the printable area of this tape and was reduced to fit.' })
  const tooTall = h > band
  if (tooTall) c.warn({ code: 'content-overflow', itemId: item.id, message: 'Text is taller than the printable area of this tape and will be cut off.' })
  const capDots = (face.cap * block.fontPx) / f
  qualityWarning(item, capDots, c)
  const slack = item.italic ? block.lineBox * 0.25 : 0
  const grid = sized.pixelScale !== undefined ? f : undefined
  const info: TextRenderInfo = {
    itemId: item.id,
    emDots: block.fontPx / f,
    capDots,
    widthDots: w,
    ...(scale < 1 ? { shrink: scale } : {}),
    ...(sized.pixelScale !== undefined && !item.italic ? { pixelScale: sized.pixelScale } : {}),
  }
  return {
    id: item.id,
    w,
    h,
    tooTall,
    clipSlack: slack,
    text: info,
    crisp: (ctx, bw, bh) => {
      if (item.invert) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, bw, bh)
      }
      drawTextBlock(ctx, item, block, (bw - block.width) / 2, (bh - block.height) / 2, item.invert ? '#fff' : '#000', grid)
    },
  }
}

/** `font-quality`: a thin or script library font (`FontDef.quality`) below a readable cap height.
 * "Thin" families are only thin below semibold. Not for custom fonts (their own file is drawn). */
function qualityWarning(item: TextItem, capDots: number, c: Ctx): void {
  if (activeCustomFamily(item)) return
  const def = fontDef(item.fontFamily)
  if (!def.quality || (def.quality === 'thin' && resolveWeight(def, item.fontWeight) >= 600)) return
  const capMm = dotsToMm(capDots, c.dpi)
  if (!(capMm < MIN_QUALITY_CAP_MM)) return
  const what = def.quality === 'thin' ? 'Thin strokes' : 'Script letters'
  c.warn({
    code: 'font-quality',
    itemId: item.id,
    message: `${what} of ${def.label} print poorly below ${MIN_QUALITY_CAP_MM} mm (this text is ${capMm.toFixed(1)} mm): make it larger (M or more) or choose a sturdier font.`,
  })
}

const pathCache = new Map<string, Path2D[]>()
function iconPaths(icon: IconDef): Path2D[] {
  let p = pathCache.get(icon.id)
  if (!p) {
    p = icon.paths.map((d) => new Path2D(d))
    pathCache.set(icon.id, p)
  }
  return p
}

function prepareIcon(item: IconItem, band: number, c: Ctx, maxW?: number): Prepared {
  // renderLabel loads the catalogue before measuring a label that has icons.
  const icons = loadedIcons()
  const icon = icons ? (icons.iconById(item.iconId) ?? icons.iconById('question')) : undefined
  let side = item.size.mode === 'fit' ? Math.min(band, maxW ?? band) : mmToDots(item.size.mm, c.dpi)
  if (side > band) {
    c.warn({ code: 'content-overflow', itemId: item.id, message: 'The icon is larger than the printable area of this tape and was reduced.' })
    side = band
  }
  side = Math.max(1, side)
  if (!icons || !icon) return { id: item.id, w: side, h: side }
  const { ICON_STROKE, ICON_VIEWBOX } = icons
  return {
    id: item.id,
    w: side,
    h: side,
    crisp: (ctx, bw, bh, f) => {
      const sidePx = side * f
      const s = sidePx / ICON_VIEWBOX
      ctx.translate((bw - sidePx) / 2, (bh - sidePx) / 2)
      ctx.scale(s, s)
      ctx.strokeStyle = '#000'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      // Lucide's 2-unit stroke, but never thinner than 2 printer dots.
      ctx.lineWidth = Math.max(ICON_STROKE, (2 * f) / s)
      for (const p of iconPaths(icon)) ctx.stroke(p)
    },
  }
}

function prepareShape(item: ShapeItem, band: number, c: Ctx): Prepared {
  const { f, dpi } = c
  const strokeDots = Math.max(1, mmToDots(item.strokeMm, dpi))
  let h = item.size.mode === 'fit' ? band : Math.max(1, mmToDots(item.size.mm, dpi))
  if (h > band) {
    c.warn({ code: 'content-overflow', itemId: item.id, message: 'The shape is taller than the printable area of this tape and was reduced.' })
    h = band
  }
  const w = Math.max(strokeDots, mmToDots(item.widthMm, dpi))
  return {
    id: item.id,
    w,
    h,
    crisp: (ctx, bw, bh) => {
      const s = Math.min(strokeDots * f, bw, bh)
      ctx.fillStyle = '#000'
      ctx.strokeStyle = '#000'
      ctx.lineWidth = s
      if (item.shape === 'line') {
        ctx.lineCap = 'butt'
        ctx.beginPath()
        if (bw >= bh) {
          ctx.moveTo(0, bh / 2)
          ctx.lineTo(bw, bh / 2)
        } else {
          ctx.moveTo(bw / 2, 0)
          ctx.lineTo(bw / 2, bh)
        }
        ctx.stroke()
      } else if (item.shape === 'ellipse') {
        ctx.beginPath()
        if (item.fill) {
          ctx.ellipse(bw / 2, bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.ellipse(bw / 2, bh / 2, Math.max(0, bw / 2 - s / 2), Math.max(0, bh / 2 - s / 2), 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      } else if (item.fill) {
        ctx.fillRect(0, 0, bw, bh)
      } else {
        ctx.strokeRect(s / 2, s / 2, Math.max(0, bw - s), Math.max(0, bh - s))
      }
    },
  }
}

/** Crossed box shown where a code cannot be encoded (printing is blocked meanwhile). */
const invalidCodeDraw: CrispDraw = (ctx, bw, bh, f) => {
  ctx.strokeStyle = '#000'
  ctx.lineWidth = f
  ctx.setLineDash([2 * f, 2 * f])
  ctx.strokeRect(f / 2, f / 2, bw - f, bh - f)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(bw, bh)
  ctx.moveTo(bw, 0)
  ctx.lineTo(0, bh)
  ctx.stroke()
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^[A-Z_]+:\s*/, '')
}

const SYMBOLOGY_NAME: Record<CodeItem['symbology'], string> = { qr: 'QR code', code128: 'Code 128 barcode', ean13: 'EAN-13 barcode', datamatrix: 'DataMatrix code' }

function prepareCode(item: CodeItem, band: number, c: Ctx, maxW?: number): Prepared {
  const { f, dpi } = c
  const name = SYMBOLOGY_NAME[item.symbology]
  let m: ModuleMatrix
  try {
    if (item.content !== 'wifi' && item.data === '') throw new Error('Enter the data to encode.')
    m = codeMatrix(item)
  } catch (e) {
    c.warn({ code: 'code-invalid', itemId: item.id, blocking: true, message: `${name}: ${errorText(e)}` })
    const side = Math.max(1, Math.min(band, mmToDots(12, dpi)))
    return { id: item.id, w: side, h: band, crisp: invalidCodeDraw }
  }
  if (item.content === 'wifi' && item.symbology === 'qr' && item.wifi) {
    for (const message of wifiWarnings(item.wifi)) c.warn({ code: 'code-invalid', itemId: item.id, message: `${name}: ${message}` })
  }
  const auto = item.moduleDots === 'auto'
  if (!auto && !((item.moduleDots as number) >= 1)) {
    c.warn({ code: 'code-too-small', itemId: item.id, blocking: true, message: `${name}: the module size must be at least 1 dot.` })
  }
  const linear = isLinear(m)
  const [qx, qy] = quietModules(m, item.quietZone, item.symbology)

  if (!linear) {
    // In a free-layout frame the symbol (with its quiet zone) must also fit the frame width.
    const choice = chooseModuleDots(m, { moduleDots: item.moduleDots, quietZone: item.quietZone, symbology: item.symbology, bandDots: band, marginDots: c.marginDots, ...(maxW !== undefined ? { limitW: maxW } : {}) })
    if (choice.max < 1) {
      c.warn({ code: 'code-too-small', itemId: item.id, blocking: true, message: `${name}: ${m.height}×${m.width} modules do not fit on this tape. ${item.symbology === 'qr' ? 'Shorten the data, lower the error correction or use wider tape.' : 'Shorten the data or use wider tape.'}` })
      const side = Math.max(1, band)
      return { id: item.id, w: side, h: band, crisp: invalidCodeDraw }
    }
    const md = choice.md
    if (choice.reduced) c.warn({ code: 'content-overflow', itemId: item.id, message: `${name} reduced to ${md} dot${md === 1 ? '' : 's'} per module to fit the tape.` })
    if (dotsToMm(md, dpi) < MIN_SCANNABLE_MODULE_MM) {
      c.warn({ code: 'code-too-small', itemId: item.id, message: `${name}: modules are ${dotsToMm(md, dpi).toFixed(2)} mm and may not scan. Use wider tape or shorter data.` })
    }
    const symW = m.width * md
    const symH = m.height * md
    const w = symW + 2 * qx * md
    const h = Math.min(band, symH + 2 * qy * md)
    // The padded zone may run past the band into the unprinted tape edge; the core clips it.
    return { id: item.id, w, h, codes: [{ m: padMatrix(m, qx, qy), dx: 0, dy: Math.floor((h - symH) / 2) - qy * md, md }] }
  }

  // Linear: a frame limits the length; a fixed-length label limits 'auto' codes (autoLinearW).
  const limitW = maxW ?? (auto ? c.autoLinearW : undefined)
  const choice = chooseModuleDots(m, { moduleDots: item.moduleDots, quietZone: item.quietZone, symbology: item.symbology, bandDots: band, ...(limitW !== undefined ? { limitW } : {}) })
  if (maxW !== undefined && choice.max < 1) {
    c.warn({ code: 'code-too-small', itemId: item.id, blocking: true, message: `${name}: ${m.width} modules do not fit in its frame. Make the frame longer or shorten the data.` })
    return { id: item.id, w: Math.max(1, maxW), h: band, crisp: invalidCodeDraw }
  }
  const md = choice.md
  if (choice.reduced) c.warn({ code: 'content-overflow', itemId: item.id, message: `${name} reduced to ${md} dot${md === 1 ? '' : 's'} per module to fit its frame.` })

  // Linear: bars fill the band, optional human-readable line underneath.
  if (dotsToMm(md, dpi) < MIN_SCANNABLE_MODULE_MM) {
    c.warn({ code: 'code-too-small', itemId: item.id, message: `${name}: bars are ${dotsToMm(md, dpi).toFixed(2)} mm wide and may not scan. Use 2 or more dots per module.` })
  }
  const symW = m.width * md
  const w = symW + 2 * qx * md
  let barH = band
  let textDraw: CrispDraw | undefined
  const label = item.showText ? humanReadable(item) : ''
  if (label) {
    const textH = Math.max(mmToDots(1.6, dpi), Math.round(band * 0.2))
    const gap = Math.max(1, Math.round(textH * 0.25))
    if (band - textH - gap >= Math.max(mmToDots(MIN_BAR_MM, dpi), band * 0.5)) {
      barH = band - textH - gap
      const fontItem = { fontFamily: CODE_TEXT_FONT.id, fontWeight: CODE_TEXT_FONT.weight, italic: false } as const
      const def = fontDef(fontItem.fontFamily)
      const face = faceMetrics(c.mctx, fontItem, isFaceReady(def, fontItem.fontWeight))
      const measure = canvasMeasure(c.mctx, fontItem)
      let block = fitTextBlock([label], face, 1, 'center', measure, { fit: true, availPx: textH * f })
      if (block.width > w * f) {
        block = fitTextBlock([label], face, 1, 'center', measure, { fit: false, targetPx: (block.fontPx * w * f * 0.98 * (face.cap + face.desc)) / block.width })
      }
      const top = barH + gap
      textDraw = (ctx, bw) => drawTextBlock(ctx, fontItem, block, (bw - block.width) / 2, top * f + (textH * f - block.height) / 2, '#000')
    } else {
      c.warn({ code: 'content-overflow', itemId: item.id, message: `${name}: there is not enough room for the text under the bars on this tape, so it is left out.` })
    }
  }
  if (dotsToMm(barH, dpi) < MIN_BAR_MM) {
    c.warn({ code: 'code-too-small', itemId: item.id, message: `${name}: bars are only ${dotsToMm(barH, dpi).toFixed(1)} mm tall and may not scan.` })
  }
  // Bar height = rows × module; a second one-row blit tops up the remainder (protected dots of
  // the first blit stay untouched, so only the missing rows are painted). The zone is padded
  // along the label only.
  const rows = Math.max(1, Math.floor(barH / md))
  const codes: CodeBlit[] = [{ m: padMatrix(repeatRow(m, rows), qx, 0), dx: 0, dy: 0, md }]
  if (rows * md < barH) codes.push({ m: padMatrix(repeatRow(m, 1), qx, 0), dx: 0, dy: barH - md, md })
  return { id: item.id, w, h: band, codes, ...(textDraw ? { crisp: textDraw } : {}), ...(auto && maxW === undefined ? { autoLinear: true } : {}) }
}

/**
 * Linear codes with `moduleDots: 'auto'` on a fixed-length label: re-measure them so they share
 * the length the other flow blocks leave (largest module up to 4 dots that fits, else 1 with an
 * overflow warning from the layout). Auto-length labels keep the default 2 dots.
 */
function sizeAutoLinearCodes(doc: LabelDoc, prepared: Prepared[], items: Item[], band: number, c: Ctx, limits: { insetDots: number }): void {
  if (doc.length.mode !== 'fixed') return
  const auto = prepared.flatMap((p, i) => (p.autoLinear ? [i] : []))
  if (!auto.length) return
  const measured: MeasuredItem[] = prepared.map((p) => ({ itemId: p.id, w: p.w, h: p.h, ...(p.spacer ? { spacer: true } : {}) }))
  const { contentDots } = layoutFlow(doc, measured, band, c.dpi)
  const ends = Math.max(0, mmToDots(doc.marginsMm.start, c.dpi)) + Math.max(0, mmToDots(doc.marginsMm.end, c.dpi)) + 2 * limits.insetDots
  const others = contentDots - auto.reduce((n, i) => n + (prepared[i]?.w ?? 0), 0)
  const each = Math.floor((mmToDots(doc.length.mm, c.dpi) - ends - others) / auto.length)
  for (const i of auto) {
    const item = items[i]
    if (item?.kind === 'code') prepared[i] = prepareCode(item, band, { ...c, autoLinearW: Math.max(0, each) })
  }
}

/** A text block measured with its warnings held back (shrink to fit length measures it again). */
function prepareTextHeld(item: TextItem, band: number, c: Ctx, scale: number): { p: Prepared; warnings: RenderWarning[] } {
  const warnings: RenderWarning[] = []
  return { p: prepareText(item, band, { ...c, warn: (w) => warnings.push(w) }, undefined, scale), warnings }
}

/**
 * Shrinking keeps auto linear codes at their default module (2 dots) while the text needs no
 * more than this factor; below it the codes may go down to 1 dot when that leaves the text larger.
 */
const KEEP_CODE_MODULE_SHRINK = 0.5

/**
 * "Shrink to fit length" (`length.shrink`, fixed length only): when the flow content is longer
 * than the label, measure every flow text block again at one common scale (< 1, never larger)
 * until it fits. Icons, images and fixed-module codes keep their size. Linear codes with
 * `moduleDots: 'auto'` (sized afterwards by sizeAutoLinearCodes) count at their default 2-dot
 * module, or at 1 dot when the text would otherwise have to shrink below
 * `KEEP_CODE_MODULE_SHRINK` (or could not fit at all) and 1-dot codes leave it larger. The text
 * never goes below `MIN_SHRINK`: when that is not enough, or the rest alone is too long, the
 * layout reports the overflow. `held` maps flow indices of text blocks to their (replaced)
 * warnings.
 */
function shrinkTextToLength(doc: LabelDoc, prepared: Prepared[], items: Item[], band: number, c: Ctx, limits: { insetDots: number }, held: Map<number, RenderWarning[]>): void {
  if (doc.length.mode !== 'fixed' || !held.size) return
  const { gap } = flowSettings(doc, c.dpi)
  const ends = Math.max(0, mmToDots(doc.marginsMm.start, c.dpi)) + Math.max(0, mmToDots(doc.marginsMm.end, c.dpi)) + 2 * limits.insetDots
  const avail = mmToDots(doc.length.mm, c.dpi) - ends
  const texts = [...held.keys()]
  const content = (): number => contentLength(prepared.map((p) => ({ itemId: p.id, w: p.w, h: p.h, ...(p.spacer ? { spacer: true } : {}) })), gap)

  /** Shrink the text blocks (from their current size) until the content fits; the final scale. */
  const run = (): { scale: number; fits: boolean } => {
    let scale = 1
    // Widths are whole dots (and pixel fonts move in whole font pixels): a few rounds settle it.
    for (let round = 0; round < 8; round++) {
      const textDots = texts.reduce((n, i) => n + (prepared[i]?.w ?? 0), 0)
      const s = shrinkFactor(avail, content() - textDots, textDots)
      if (s === undefined || s >= 1) break
      const next = Math.max(MIN_SHRINK, scale * s * (round === 0 ? 1 : 0.995))
      if (next >= scale) break
      scale = next
      for (const i of texts) {
        const item = items[i]
        if (item?.kind !== 'text') continue
        const t = prepareTextHeld(item, band, c, scale)
        prepared[i] = t.p
        held.set(i, t.warnings)
      }
    }
    return { scale, fits: content() <= avail }
  }

  const autos = prepared.flatMap((p, i) => (p.autoLinear && items[i]?.kind === 'code' ? [i] : []))
  const snapshot = (): [number, Prepared, RenderWarning[] | undefined][] => [...texts, ...autos].map((i) => [i, prepared[i] as Prepared, held.get(i)])
  const restore = (snap: [number, Prepared, RenderWarning[] | undefined][]): void => {
    for (const [i, p, w] of snap) {
      prepared[i] = p
      if (w) held.set(i, w)
    }
  }
  const original = autos.length ? snapshot() : []
  const a = run()
  if (!autos.length || (a.fits && a.scale >= KEEP_CODE_MODULE_SHRINK)) return
  // Try again with the auto codes at 1 dot per module (their warnings come from sizeAutoLinearCodes).
  const withDefault = snapshot()
  restore(original)
  const quiet: Ctx = { ...c, warn: () => {}, autoLinearW: 0 }
  for (const i of autos) {
    const item = items[i]
    if (item?.kind === 'code') prepared[i] = prepareCode(item, band, quiet)
  }
  const b = run()
  if (!(b.fits && (!a.fits || b.scale > a.scale))) restore(withDefault)
}

function clampInt(v: number, lo: number, hi: number, dflt: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt
}

async function prepareImage(item: ImageItem, band: number, c: Ctx, rotation: Rotation, maxW?: number): Promise<Prepared> {
  let h = item.size.mode === 'fit' ? band : Math.max(1, mmToDots(item.size.mm, c.dpi))
  if (h > band) {
    c.warn({ code: 'content-overflow', itemId: item.id, message: 'The image is taller than the printable area of this tape and was reduced.' })
    h = band
  }
  const placeholder = { id: item.id, w: Math.max(1, h), h }
  const blob = await resolveImageBlob(item, c.loadBlob)
  if (!blob) {
    c.warn({ code: 'image-missing', itemId: item.id, message: item.blobRef || item.dataUrl ? 'The image is no longer available. Add it again.' : 'Choose an image file.' })
    return placeholder
  }
  let img: RgbaImage
  try {
    if (maxW !== undefined) {
      // Free layout: shrink so the (rotated) image also fits the frame width.
      const nat = await imageSize(blob)
      const quarterTurn = rotation === 90 || rotation === 270
      const aspect = quarterTurn ? nat.height / nat.width : nat.width / nat.height
      if (aspect > 0 && h * aspect > maxW) h = Math.max(1, Math.floor(maxW / aspect))
    }
    img = await decodeImage(blob, h, rotation)
    if (img.height < h) c.warn({ code: 'content-overflow', itemId: item.id, message: `The image is very wide, so it was made smaller to stay within ${Math.round(dotsToMm(MAX_IMAGE_DOTS, c.dpi))} mm.` })
  } catch {
    c.warn({ code: 'image-missing', itemId: item.id, message: 'The image could not be read. Try a PNG or JPEG file.' })
    return placeholder
  }
  const a = item.adjust
  const opts: ToneOptions = {
    dither: item.dither,
    level: clampInt(a.level, 0, 255, 128),
    brightness: clampInt(a.brightness, -100, 100, 0),
    contrast: clampInt(a.contrast, -100, 100, 0),
    gammaX100: clampInt(a.gammaX100, 10, 1000, 100),
    invert: !!a.invert,
  }
  return { id: item.id, w: img.width, h: img.height, tone: { img, opts }, prerotated: true }
}

/** `band` = available height across the item; `maxW` (free layout) = available width. */
async function prepareItem(item: Item, band: number, c: Ctx, rotation: Rotation, maxW?: number): Promise<Prepared> {
  switch (item.kind) {
    case 'text':
      return prepareText(item, band, c, maxW)
    case 'icon':
      return prepareIcon(item, band, c, maxW)
    case 'shape':
      return prepareShape(item, band, c)
    case 'code':
      return prepareCode(item, band, c, maxW)
    case 'image':
      return prepareImage(item, band, c, rotation, maxW)
    case 'spacer':
      return { id: item.id, w: Math.max(0, mmToDots(item.widthMm, c.dpi)), h: 0, spacer: true }
  }
}

// ------------------------------------------------------------------------------------------
// Placement and rotation
// ------------------------------------------------------------------------------------------

/** A prepared item at its final place (dots). `w`/`h` are the placed box (rotated). */
interface Placed {
  p: Prepared
  x: number
  y: number
  w: number
  h: number
  rotation: Rotation
}

/** Rotates a rect inside a `w × h` box clockwise; returns it in the rotated box. */
function rotateRect(r: { x: number; y: number; w: number; h: number }, w: number, h: number, rot: Rotation): { x: number; y: number; w: number; h: number } {
  switch (rot) {
    case 0:
      return r
    case 90:
      return { x: h - (r.y + r.h), y: r.x, w: r.h, h: r.w }
    case 180:
      return { x: w - (r.x + r.w), y: h - (r.y + r.h), w: r.w, h: r.h }
    case 270:
      return { x: r.y, y: w - (r.x + r.w), w: r.h, h: r.w }
  }
}

const quarter = (r: Rotation): boolean => r === 90 || r === 270

// ------------------------------------------------------------------------------------------
// Frame
// ------------------------------------------------------------------------------------------

interface FrameGeom {
  inset: number
  thickness: number
  radius: number
  /** Space reserved for the frame on every side (inset + thickness + padding). */
  reserve: number
}

function frameGeom(doc: LabelDoc, band: number, dpi: number): FrameGeom | undefined {
  const fr = doc.frame
  if (!fr || !(fr.thicknessMm > 0)) return undefined
  const thickness = Math.max(1, mmToDots(fr.thicknessMm, dpi))
  const inset = Math.max(0, mmToDots(fr.insetMm, dpi))
  const radius = Math.max(0, mmToDots(fr.radiusMm, dpi))
  const pad = Math.max(1, Math.min(mmToDots(1, dpi), Math.round(band * 0.06)))
  return { inset, thickness, radius, reserve: inset + thickness + pad }
}

/**
 * The band an item is sized in and the unprinted tape margin a code may count as quiet zone,
 * by the same rules as renderLabel: flow items get the band inside the label frame (when the
 * frame has a line), and the margin only without one; free-layout items in a frame get the
 * frame's height (its width when turned a quarter) and no margin. The code editor's size hints
 * use this so they never promise a size the print does not have.
 */
export function itemSizingBand(doc: LabelDoc, item: Item, area: RenderTarget['area']): { bandDots: number; marginDots: number; framed: boolean } {
  const fr = doc.layout.mode === 'free' ? item.frame : undefined
  if (fr) {
    const turned = quarter(([0, 90, 180, 270] as const).includes(fr.rotation) ? fr.rotation : 0)
    return { bandDots: Math.max(1, mmToDots(turned ? fr.wMm : fr.hMm, area.dpi)), marginDots: 0, framed: true }
  }
  const frame = frameGeom(doc, area.heightDots, area.dpi)
  const inner = Math.max(1, area.heightDots - 2 * (frame?.reserve ?? 0))
  return { bandDots: inner, marginDots: frame ? 0 : tapeMarginDots(area), framed: false }
}

function drawFrame(ctx: Ctx2D, g: FrameGeom, length: number, band: number, f: number): void {
  const t = g.thickness * f
  const x = g.inset * f + t / 2
  const y = g.inset * f + t / 2
  const w = (length - 2 * g.inset) * f - t
  const h = (band - 2 * g.inset) * f - t
  if (w <= 0 || h <= 0) return
  ctx.strokeStyle = '#000'
  ctx.lineWidth = t
  ctx.beginPath()
  const r = Math.min(g.radius * f, w / 2, h / 2)
  if (r > 0 && 'roundRect' in ctx) ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
  ctx.stroke()
}

// ------------------------------------------------------------------------------------------
// Crisp plane
// ------------------------------------------------------------------------------------------

function drawCrispScene(ctx: Ctx2D, placed: Placed[], frame: FrameGeom | undefined, length: number, band: number, f: number, x0: number, x1: number): boolean {
  let drew = false
  if (frame) {
    drawFrame(ctx, frame, length, band, f)
    drew = true
  }
  for (const pl of placed) {
    const draw = pl.p.crisp
    if (!draw || pl.w <= 0 || pl.h <= 0) continue
    const slackDots = Math.ceil((pl.p.clipSlack ?? 0) / f)
    if (pl.x + pl.w + slackDots < x0 || pl.x - slackDots > x1) continue
    const uw = quarter(pl.rotation) ? pl.h : pl.w
    const uh = quarter(pl.rotation) ? pl.w : pl.h
    ctx.save()
    ctx.translate((pl.x + pl.w / 2) * f, (pl.y + pl.h / 2) * f)
    ctx.rotate((pl.rotation * Math.PI) / 180)
    ctx.translate((-uw / 2) * f, (-uh / 2) * f)
    const slack = pl.p.clipSlack ?? 0
    ctx.beginPath()
    ctx.rect(-slack, 0, uw * f + 2 * slack, uh * f)
    ctx.clip()
    draw(ctx, uw * f, uh * f, f)
    ctx.restore()
    drew = true
  }
  return drew
}

function paintCrisp(raster: Raster, placed: Placed[], frame: FrameGeom | undefined, length: number, band: number, f: number, threshold: number): void {
  if (!frame && !placed.some((p) => p.p.crisp && p.w > 0 && p.h > 0)) return
  const tileDots = Math.max(1, Math.floor(MAX_TILE_PX / f))
  let canvas: AnyCanvas | undefined
  for (let x0 = 0; x0 < length; x0 += tileDots) {
    const len = Math.min(tileDots, length - x0)
    const w = len * f
    const h = band * f
    if (!canvas || canvas.width !== w || canvas.height !== h) canvas = createCanvas(w, h)
    const ctx = context2d(canvas)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.setTransform(1, 0, 0, 1, -x0 * f, 0)
    if (!drawCrispScene(ctx, placed, frame, length, band, f, x0, x0 + len)) continue
    const data = ctx.getImageData(0, 0, w, h).data
    if (len === length) {
      raster.blitCrisp(rgbaBytes(data), w, h, f, threshold)
    } else {
      // Crisp blits only add ink, so OR-ing tiles in is the same as one big blit.
      const tile = new Raster(len, band)
      let bmp: Bitmap1 | null = null
      try {
        tile.blitCrisp(rgbaBytes(data), w, h, f, threshold)
        bmp = tile.finish()
        raster.blitBitmap(bmp, x0, 0)
      } finally {
        release(tile) // still owned if blitCrisp threw (finish() consumes it otherwise)
        release(bmp)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------------------------------

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Rendering was cancelled', 'AbortError')
}

function oddFactor(f: number | undefined): number {
  const v = Math.round(f ?? DEFAULT_CRISP_FACTOR)
  if (!Number.isFinite(v)) return DEFAULT_CRISP_FACTOR
  return Math.max(1, Math.min(7, v))
}

/**
 * Renders `doc` for `target`. Requires `loadWasm()` to have resolved. Fonts are loaded on
 * demand (`ensureFonts`, cached). Never resamples after thresholding: the result feeds both
 * preview and job. Throws only for programming errors / aborts; problems with the design are
 * reported as `warnings` (and `blocking`).
 */
export async function renderLabel(doc: LabelDoc, target: RenderTarget, opts: RenderOptions = {}): Promise<RenderResult> {
  const f = oddFactor(opts.factor)
  const dpi = target.area.dpi
  const band = target.area.heightDots
  const signal = opts.signal
  const warnings: RenderWarning[] = []
  const seen = new Set<string>()
  const warn = (w: RenderWarning): void => {
    const k = `${w.code}|${w.itemId ?? ''}|${w.message}`
    if (seen.has(k)) return
    seen.add(k)
    warnings.push(w)
  }

  abortIfNeeded(signal)
  const fonts = await ensureFonts(doc, opts.loadFontBlob ? { loadFontBlob: opts.loadFontBlob } : {})
  abortIfNeeded(signal)
  if (doc.items.some((i) => i.kind === 'icon') && !(await loadIcons().catch(() => undefined))) {
    warn({ code: 'icons-missing', blocking: true, message: 'The icons could not be loaded, so they would print blank. Reload the page while online to fix this.' })
  }
  abortIfNeeded(signal)
  for (const fb of fonts.fallbacks) {
    warn({ code: 'font-fallback', message: `The font “${fb}” could not be loaded; a system font is used instead. Reload the page while online to fix this.` })
  }
  for (const name of fonts.missing ?? []) {
    warn({ code: 'font-missing', message: `The font “${name}” is not available on this device, so the label uses its built-in font instead. Add the font under Fonts to print it as designed.` })
  }
  if (canvasReadbackIsNoisy()) {
    warn({
      code: 'canvas-noise',
      blocking: true,
      message: 'Your browser adds random noise to canvas images (fingerprinting protection), which would print as speckles. Allow canvas access for this site (e.g. turn Brave Shields off here), then reload.',
    })
  }

  const frame = frameGeom(doc, band, dpi)
  const reserve = frame?.reserve ?? 0
  const inner = Math.max(1, band - 2 * reserve)
  // A code in the flow may count the unprinted tape margin as quiet zone, unless a frame line
  // runs along the band edge; codes in free-layout frames never do (neighbours may be there).
  const c: Ctx = { f, dpi, mctx: measuring(), warn, marginDots: frame ? 0 : tapeMarginDots(target.area), ...(opts.loadBlob ? { loadBlob: opts.loadBlob } : {}) }
  const cFramed: Ctx = { ...c, marginDots: 0 }

  // Measure. Free layout: items with a frame are placed by it; the rest flow.
  const free = doc.layout.mode === 'free'
  const flowItems: Prepared[] = []
  const flowSource: Item[] = []
  // Shrink to fit length: flow text is measured with its warnings held back until its final size.
  const shrinking = doc.length.mode === 'fixed' && !!doc.length.shrink
  const held = new Map<number, RenderWarning[]>()
  const framed: { p: Prepared; x: number; y: number; w: number; h: number; rotation: Rotation }[] = []
  for (const item of doc.items) {
    const fr = free ? item.frame : undefined
    if (fr) {
      const rotation = ([0, 90, 180, 270] as const).includes(fr.rotation) ? fr.rotation : 0
      const bw = Math.max(1, mmToDots(fr.wMm, dpi))
      const bh = Math.max(1, mmToDots(fr.hMm, dpi))
      // Images are decoded already rotated (their band is the frame height); everything else is
      // measured upright and rotated when drawn.
      const upright = item.kind === 'image' || !quarter(rotation)
      const p = await prepareItem(item, upright ? bh : bw, cFramed, rotation, upright ? bw : bh)
      const pw = p.prerotated || !quarter(rotation) ? p.w : p.h
      const ph = p.prerotated || !quarter(rotation) ? p.h : p.w
      if (!p.spacer && (pw > bw || ph > bh)) warn({ code: 'content-overflow', itemId: item.id, message: 'This item is larger than its frame and is cut off at the frame edge.' })
      framed.push({ p, x: mmToDots(fr.xMm, dpi), y: mmToDots(fr.yMm, dpi), w: bw, h: bh, rotation: p.prerotated ? 0 : rotation })
    } else if (shrinking && item.kind === 'text') {
      const t = prepareTextHeld(item, inner, c, 1)
      held.set(flowItems.length, t.warnings)
      flowItems.push(t.p)
      flowSource.push(item)
    } else {
      flowItems.push(await prepareItem(item, inner, c, 0))
      flowSource.push(item)
    }
    abortIfNeeded(signal)
  }

  const limits = { minLengthDots: target.area.minLengthDots, ...(target.area.maxLengthDots !== undefined ? { maxLengthDots: target.area.maxLengthDots } : {}), insetDots: reserve }
  if (shrinking) {
    shrinkTextToLength(doc, flowItems, flowSource, inner, c, limits, held)
    for (const ws of held.values()) for (const w of ws) warn(w)
  }
  sizeAutoLinearCodes(doc, flowItems, flowSource, inner, c, limits)
  const measured: MeasuredItem[] = flowItems.map((p) => ({ itemId: p.id, w: p.w, h: p.h, ...(p.spacer ? { spacer: true } : {}) }))
  let layout: FlowLayout = layoutFlow(doc, measured, band, dpi, limits)
  const placed: Placed[] = layout.placements.map((pl, i) => ({ p: flowItems[i] as Prepared, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rotation: 0 }))
  if (framed.length) {
    const freeItems: FramedItem[] = framed.map((fi) => ({ itemId: fi.p.id, x: fi.x, y: fi.y, w: fi.w, h: fi.h }))
    const fl = layoutFree(doc, freeItems, band, dpi, limits)
    const flowLen = flowItems.length ? layout.lengthDots : 0
    layout = { ...fl, lengthDots: Math.max(fl.lengthDots, flowLen), overflow: fl.overflow || (flowItems.length > 0 && layout.overflow) }
    for (const fi of framed) {
      // Centre the (rotated) content in its frame box.
      const cw = quarter(fi.rotation) ? fi.p.h : fi.p.w
      const ch = quarter(fi.rotation) ? fi.p.w : fi.p.h
      placed.push({ p: fi.p, x: fi.x + Math.floor((fi.w - Math.min(cw, fi.w)) / 2), y: fi.y + Math.floor((fi.h - Math.min(ch, fi.h)) / 2), w: Math.min(cw, fi.w), h: Math.min(ch, fi.h), rotation: fi.rotation })
    }
  }
  const length = layout.lengthDots

  if (layout.clamped === 'min') {
    warn({ code: 'length-clamped', message: `The label was lengthened to the printer minimum of ${dotsToMm(length, dpi).toFixed(1)} mm.` })
  } else if (layout.clamped === 'max') {
    warn({ code: 'length-clamped', message: `The label was shortened to the printer maximum of ${Math.round(dotsToMm(length, dpi))} mm.` })
  }
  if (layout.overflow) {
    const hint = doc.length.mode === 'fixed' && !doc.length.shrink && flowSource.some((i) => i.kind === 'text') ? ' Turn on “Shrink text to fit length” or make the label longer.' : ''
    warn({ code: 'content-overflow', message: doc.length.mode === 'fixed' ? `The content is longer than the fixed label length and will be cut off.${hint}` : 'The content does not fit on the label and will be cut off.' })
  }

  // Compose: tone → crisp → codes.
  const threshold = clampInt(doc.print.threshold, 0, 255, 128)
  const raster = new Raster(length, band)
  let finished = false
  try {
    for (const pl of placed) {
      const t = pl.p.tone
      if (!t) continue
      const dy = Math.floor((pl.h - t.img.height) / 2)
      const dx = Math.floor((pl.w - t.img.width) / 2)
      raster.blitTone(rgbaBytes(t.img.rgba), t.img.width, t.img.height, pl.x + dx, pl.y + dy, t.opts)
    }
    paintCrisp(raster, placed, frame, length, band, f, threshold)
    for (const pl of placed) {
      for (const cb of pl.p.codes ?? []) {
        const uw = pl.p.w
        const uh = quarter(pl.rotation) ? pl.w : pl.h
        // Unrotated box is (p.w × placed cross size); centre vertically if the band clipped it.
        const r = rotateRect({ x: cb.dx, y: cb.dy + Math.floor((uh - pl.p.h) / 2), w: cb.m.width * cb.md, h: cb.m.height * cb.md }, uw, uh, pl.rotation)
        // The padded light modules are the quiet zone: the core clears and protects them, so
        // nothing under or next to the code can print into it (whatever the rotation).
        raster.blitCode(rotateMatrix(cb.m, pl.rotation), pl.x + r.x, pl.y + r.y, cb.md, false)
      }
    }
    const bitmap = raster.finish()
    finished = true

    if (bitmap.isBlank() && !warnings.some((w) => w.blocking)) {
      warn({ code: 'empty', blocking: true, message: doc.items.length ? 'Nothing would be printed. Add some text, an icon or a code.' : 'The label is empty. Add some text, an icon or a code.' })
    }
    const boxes: ItemBox[] = placed
      .filter((pl) => pl.w > 0 || pl.p.spacer)
      .map((pl) => (pl.p.spacer ? { itemId: pl.p.id, x: pl.x, y: reserve, w: Math.max(1, pl.w), h: inner } : { itemId: pl.p.id, x: pl.x, y: pl.y, w: pl.w, h: pl.h }))
    const blocking = warnings.some((w) => w.blocking)
    warnings.sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking))
    const texts = placed.flatMap((pl) => (pl.p.text ? [pl.p.text] : []))
    return {
      bitmap,
      lengthDots: length,
      heightDots: band,
      lengthMm: dotsToMm(length, dpi),
      feedMarginMm: dotsToMm(target.area.defaultFeedDots, dpi),
      boxes,
      warnings,
      blocking,
      overflow: layout.overflow || placed.some((pl) => pl.p.tooTall),
      texts,
    }
  } finally {
    if (!finished) raster.free()
  }
}
