// W3 — LabelDoc → Bitmap1 (ARCHITECTURE.md §5.1–§5.2). Canvas2D (OffscreenCanvas where
// available) draws the crisp plane at 3×; photos go through Raster.blitTone; codes through
// encodeCode + Raster.blitCode (never via canvas). Compositing order: tone → crisp → cut marks
// (protected) → codes.
//
// One renderer, two outputs: the Bitmap1 returned here is both the preview and the printed
// page. Canvas x = along the label (column 0 = left end as read), y = across the tape (row 0 =
// top of the printable band). The core encoder handles the printer's feed order.
import { Raster, release, type Bitmap1, type ModuleMatrix, type ToneOptions } from '../wasm'
import type { CodeItem, IconItem, ImageItem, Item, LabelDoc, Rotation, ShapeItem, TableItem, TextItem } from '../doc/schema'
import { canvasReadbackIsNoisy } from './antifp'
import { context2d, createCanvas, rgbaBytes, type AnyCanvas, type Ctx2D } from './canvas'
import { chooseModuleDots, codeMatrix, humanReadable, isLinear, padMatrix, quietModules, repeatRow, rotateMatrix, tapeMarginDots } from './codes'
import { CODE_TEXT_FONT, MIN_QUALITY_CAP_MM, activeCustomFamily, ensureFonts, fontDef, isFaceReady, resolveWeight, textFaceReady } from './fonts'
import { loadIcons, loadedIcons } from './icon-set'
import { loadTables } from './table-set'
import type { IconDef } from './icons'
import { MAX_IMAGE_DOTS, decodeImage, imageSize, resolveImageBlob, type RgbaImage } from './images'
import { contentLength, flowSettings, layoutFlow, layoutFree, layoutPieces, splitPieces, type FlowLayout, type FramedItem, type IgnoredCutReason, type MeasuredItem, type PiecesLayout } from './layout'
import { DEFAULT_CRISP_FACTOR, MIN_SHRINK, canvasMeasure, cssFont, drawTextBlock, faceMetrics, fitTextBlock, lineHeightOf, pixelGrid, shrinkFactor, sizeTextBlock, splitLines } from './text'
import type { CutInfo, ItemBox, RenderOptions, RenderResult, RenderTarget, RenderWarning, TextRenderInfo } from './types'
import { dotsToMm, mmToDots } from './units'
import { wifiWarnings } from './wifi'

/** Widest crisp canvas drawn at once (px); longer labels are drawn in tiles. */
const MAX_TILE_PX = 8190
/** Below this cap-to-descender height (mm) text prints poorly, at any head resolution. */
const SMALL_TEXT_MM = 2
/** Narrowest module that scans reliably (2 dots at 180 dpi = 0.28 mm; 4 dots at 360 dpi). */
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
  /** Machine cuts inside the item (table "cut between columns"), dots from its left edge. */
  cuts?: number[]
  /** A Cut block (docs/CUT-PLAN.md): no ink, splits the flow into pieces. */
  cut?: boolean
}

/** What the pure layout needs of a prepared item. */
function measuredOf(p: Prepared): MeasuredItem {
  return { itemId: p.id, w: p.w, h: p.h, ...(p.spacer ? { spacer: true } : {}), ...(p.cut ? { cut: true } : {}) }
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
  /** Tables may be cut between columns (flow layout, Cut each on, a printer with a cutter). */
  cut: boolean
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
function qualityWarning(item: Pick<TextItem, 'id' | 'fontFamily' | 'fontWeight' | 'customFont'>, capDots: number, c: Ctx): void {
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
    const choice = chooseModuleDots(m, { moduleDots: item.moduleDots, quietZone: item.quietZone, symbology: item.symbology, bandDots: band, marginDots: c.marginDots, dpi, ...(maxW !== undefined ? { limitW: maxW } : {}) })
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
  const choice = chooseModuleDots(m, { moduleDots: item.moduleDots, quietZone: item.quietZone, symbology: item.symbology, bandDots: band, dpi, ...(limitW !== undefined ? { limitW } : {}) })
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
 * the length the other flow blocks leave (largest module up to 4 dots at 180 dpi that fits, else
 * 1 with an overflow warning from the layout). Auto-length labels keep the default 2 dots (4 at
 * 360 dpi: codes.ts `dotsAt`).
 */
function sizeAutoLinearCodes(doc: LabelDoc, prepared: Prepared[], items: Item[], band: number, c: Ctx, limits: { insetDots: number }): void {
  if (doc.length.mode !== 'fixed') return
  const auto = prepared.flatMap((p, i) => (p.autoLinear ? [i] : []))
  if (!auto.length) return
  const { contentDots } = layoutFlow(doc, prepared.map(measuredOf), band, c.dpi)
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
  const content = (): number => contentLength(prepared.map(measuredOf), gap)

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
    case 'table':
      return prepareTable(item, band, c)
    case 'cut':
      return { id: item.id, w: 0, h: 0, cut: true }
  }
}

/** A table (lazy chunk, render/table-set.ts); `cut` only in the flow (never in a frame). */
async function prepareTable(item: TableItem, band: number, c: Ctx): Promise<Prepared> {
  const t = await loadTables().catch(() => undefined)
  if (!t) {
    c.warn({ code: 'table-missing', itemId: item.id, blocking: true, message: 'The table could not be loaded. Reload the page while online.' })
    return { id: item.id, w: 0, h: 0 }
  }
  const font = (px: number): string => cssFont(item, px)
  return t.prepareTable(item, band, {
    ...c,
    face: faceMetrics(c.mctx, item, textFaceReady(item)),
    measure: canvasMeasure(c.mctx, item, font),
    font,
    pixel: pixelGrid(item),
    cut: c.cut && item.cutBetween,
    quality: (cap) => qualityWarning(item, cap, c),
  })
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
  /** The piece of a cut strip this block belongs to, `[start, end)` dots: it is drawn inside it
   * only, so a block that overflows a fixed-length piece is cut off at the cut, as on a label of
   * its own (docs/CUT-PLAN.md C2). Absent = drawn wherever it reaches (the label's own edges). */
  clip?: [number, number]
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

/** Rectangles in dots (cut marks). */
interface DotRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What is drawn besides the items: the label frame around every piece (`spans`, one span = the
 * whole label) and the cut marks of Cut blocks the printer does not cut at (docs/CUT-PLAN.md C5).
 */
interface Decor {
  frame: FrameGeom | undefined
  spans: [number, number][]
  marks: DotRect[]
}

function drawCrispScene(ctx: Ctx2D, placed: Placed[], decor: Decor, band: number, f: number, x0: number, x1: number): boolean {
  let drew = false
  if (decor.frame) {
    for (const [a, b] of decor.spans) {
      // Moved by the transform (whole px), so the path is the same as a label of its own.
      ctx.save()
      ctx.translate(a * f, 0)
      drawFrame(ctx, decor.frame, b - a, band, f)
      ctx.restore()
    }
    drew = true
  }
  for (const pl of placed) {
    const draw = pl.p.crisp
    if (!draw || pl.w <= 0 || pl.h <= 0) continue
    const slackDots = Math.ceil((pl.p.clipSlack ?? 0) / f)
    if (pl.x + pl.w + slackDots < x0 || pl.x - slackDots > x1) continue
    if (pl.clip && (pl.clip[1] <= Math.max(x0, pl.clip[0]) || pl.clip[0] >= x1)) continue
    const uw = quarter(pl.rotation) ? pl.h : pl.w
    const uh = quarter(pl.rotation) ? pl.w : pl.h
    ctx.save()
    if (pl.clip && (pl.x - slackDots < pl.clip[0] || pl.x + pl.w + slackDots > pl.clip[1])) {
      // Overflows its piece: cut off at the piece's ends (whole px, so no edge is anti-aliased).
      ctx.beginPath()
      ctx.rect(pl.clip[0] * f, 0, (pl.clip[1] - pl.clip[0]) * f, band * f)
      ctx.clip()
    }
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
  // Cut marks last (plain fills; the items above restore their own state).
  if (decor.marks.length) {
    ctx.fillStyle = '#000'
    for (const r of decor.marks) ctx.fillRect(r.x * f, r.y * f, r.w * f, r.h * f)
    drew = true
  }
  return drew
}

function paintCrisp(raster: Raster, placed: Placed[], decor: Decor, length: number, band: number, f: number, threshold: number): void {
  if (!decor.frame && !decor.marks.length && !placed.some((p) => p.p.crisp && p.w > 0 && p.h > 0)) return
  const tileDots = Math.max(1, Math.floor(MAX_TILE_PX / f))
  // Tiles start at every piece (one span = the whole label): a piece made by a Cut block is drawn
  // on the same canvases as when it is printed on its own, so it gets the very same dots (C2).
  const tiles = decor.spans.flatMap(([s, e]) => Array.from({ length: Math.ceil((e - s) / tileDots) }, (_, i): [number, number] => [s + i * tileDots, Math.min(tileDots, e - s - i * tileDots)]))
  let canvas: AnyCanvas | undefined
  for (const [x0, len] of tiles) {
    const w = len * f
    const h = band * f
    if (!canvas || canvas.width !== w || canvas.height !== h) canvas = createCanvas(w, h)
    const ctx = context2d(canvas)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.setTransform(1, 0, 0, 1, -x0 * f, 0)
    if (!drawCrispScene(ctx, placed, decor, band, f, x0, x0 + len)) continue
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
// Cut blocks (docs/CUT-PLAN.md)
// ------------------------------------------------------------------------------------------

/**
 * Blits a photo at (`x`, `y`), kept inside `clip` (its piece of a cut strip). An image that
 * overflows its piece is dithered whole on a raster of the piece's length, as on a label of its
 * own, and that raster is OR-ed in (tone comes first, so the strip is still blank there).
 */
function blitToneIn(raster: Raster, t: NonNullable<Prepared['tone']>, x: number, y: number, band: number, clip: [number, number] | undefined): void {
  const { img, opts } = t
  if (!clip || (x >= clip[0] && x + img.width <= clip[1])) {
    raster.blitTone(rgbaBytes(img.rgba), img.width, img.height, x, y, opts)
    return
  }
  const [a, b] = clip
  if (b <= a) return
  const piece = new Raster(b - a, band)
  let bmp: Bitmap1 | null = null
  try {
    piece.blitTone(rgbaBytes(img.rgba), img.width, img.height, x - a, y, opts)
    bmp = piece.finish()
    raster.blitBitmap(bmp, a, 0)
  } finally {
    release(piece) // still owned if blitTone threw (finish() consumes it otherwise)
    release(bmp)
  }
}

/**
 * A code's modules at (`x`, …) with `md` dots per module, cut to `clip` (its piece of a cut
 * strip): unchanged when it fits, else expanded to one dot per module and cut at the piece's
 * ends, so the strip gets the very dots (and quiet-zone clearing) of the piece printed alone.
 * Undefined when nothing of it is inside.
 */
function clipCode(m: ModuleMatrix, md: number, x: number, clip: [number, number] | undefined): { m: ModuleMatrix; md: number; x: number } | undefined {
  const w = m.width * md
  if (!clip || (x >= clip[0] && x + w <= clip[1])) return { m, md, x }
  const x0 = Math.max(clip[0], x)
  const x1 = Math.min(clip[1], x + w)
  if (x1 <= x0) return undefined
  const cw = x1 - x0
  const ch = m.height * md
  const modules = new Array<number>(cw * ch)
  for (let y = 0; y < ch; y++) {
    const row = Math.floor(y / md) * m.width
    for (let i = 0; i < cw; i++) modules[y * cw + i] = m.modules[row + Math.floor((x0 - x + i) / md)] ?? 0
  }
  return { m: { width: cw, height: ch, modules }, md: 1, x: x0 }
}

/** The `cut-ignored` sentences (C3). */
const IGNORED_CUT: Record<IgnoredCutReason, string> = {
  start: 'Nothing is printed before this cut, so it is ignored.',
  double: 'Nothing is printed between this cut and the one before it, so it is ignored.',
  end: 'Nothing is printed after this cut, so it is ignored. Add a block after it to start the next piece.',
}
/** A kept Cut beyond a strip that was cut to the printer maximum (no machine cuts). */
const BEYOND_MAX_CUT = 'The strip is cut off at the printer maximum before this cut, so it is ignored.'

/**
 * The box of a kept Cut (selection outline, hit-testing): the blank between the two pieces, the
 * end margin before it and the start margin after it (frame reserve included), at least 1.5 mm
 * wide so it can be clicked with margins of 0.
 */
function cutBoxOf(doc: LabelDoc, dpi: number, reserve: number, band: number, length: number): (itemId: string, x: number) => ItemBox {
  const before = Math.max(0, mmToDots(doc.marginsMm.end, dpi)) + reserve
  const after = Math.max(0, mmToDots(doc.marginsMm.start, dpi)) + reserve
  const min = mmToDots(1.5, dpi)
  return (itemId, x) => {
    const extra = Math.max(0, min - before - after)
    const x0 = Math.max(0, x - before - Math.floor(extra / 2))
    const x1 = Math.min(length, x + after + Math.ceil(extra / 2))
    return { itemId, x: x0, y: 0, w: Math.max(1, x1 - x0), h: band }
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
  const c: Ctx = { f, dpi, mctx: measuring(), warn, marginDots: frame ? 0 : tapeMarginDots(target.area), cut: doc.print.autoCut && opts.cutter !== false, ...(opts.loadBlob ? { loadBlob: opts.loadBlob } : {}) }
  const cFramed: Ctx = { ...c, marginDots: 0, cut: false }

  // Measure. Free layout: items with a frame are placed by it; the rest flow.
  const free = doc.layout.mode === 'free'
  const flowItems: Prepared[] = []
  const flowSource: Item[] = []
  // Shrink to fit length: flow text is measured with its warnings held back until its final size.
  const shrinking = doc.length.mode === 'fixed' && !!doc.length.shrink
  const held = new Map<number, RenderWarning[]>()
  const framed: { p: Prepared; x: number; y: number; w: number; h: number; rotation: Rotation }[] = []
  for (const item of doc.items) {
    // A Cut always flows (C10); the validator already drops a frame on one.
    const fr = free && item.kind !== 'cut' ? item.frame : undefined
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

  // Cut blocks (docs/CUT-PLAN.md) split the flow into pieces, each laid out like a label of its
  // own; a label without a kept Cut takes the plain flow path (bit-identical to before Cuts).
  const split = splitPieces(flowItems.map(measuredOf))
  const pieced = split.kept.length > 0
  // A table cut between its columns, or a strip cut at its Cut blocks, prints as one page per
  // piece (render/job.ts pageSpans), and the printer's maximum applies to each page: the strip
  // itself is not cut to the maximum, its pieces are checked below instead (an 88-key keyboard is
  // well over 1 m of tape).
  const pieceMax = target.area.maxLengthDots
  const cutting = flowItems.some((p) => !!p.cuts?.length) || (pieced && c.cut)
  const limits = { minLengthDots: target.area.minLengthDots, ...(pieceMax !== undefined && !cutting ? { maxLengthDots: pieceMax } : {}), insetDots: reserve }
  // Shrink to fit length and auto linear codes work per piece (C7): a fixed length is the length
  // of each piece.
  for (const idx of pieced ? split.pieces : [flowItems.map((_, i) => i)]) {
    const sub = idx.map((i) => flowItems[i] as Prepared)
    const subSource = idx.map((i) => flowSource[i] as Item)
    if (shrinking) {
      const subHeld = new Map<number, RenderWarning[]>()
      idx.forEach((i, j) => {
        const w = held.get(i)
        if (w) subHeld.set(j, w)
      })
      shrinkTextToLength(doc, sub, subSource, inner, c, limits, subHeld)
      // The text's warnings at its final size come before the auto codes' (as without Cuts).
      for (const ws of subHeld.values()) for (const w of ws) warn(w)
    }
    sizeAutoLinearCodes(doc, sub, subSource, inner, c, limits)
    idx.forEach((i, j) => (flowItems[i] = sub[j] as Prepared))
  }
  const measured: MeasuredItem[] = flowItems.map(measuredOf)
  const pieces: PiecesLayout | undefined = pieced ? layoutPieces(doc, measured, band, dpi, limits, cutting) : undefined
  let layout: FlowLayout = pieces ?? layoutFlow(doc, measured, band, dpi, limits)
  const placed: Placed[] = layout.placements.map((pl, i) => {
    // Pieces of a cut strip: a block is drawn inside its own piece only (a piece beyond a strip
    // cut to the printer maximum is not drawn at all).
    const span = pieces ? (pieces.spans[pieces.pieceOf[i] ?? 0] ?? [pieces.lengthDots, pieces.lengthDots]) : undefined
    return { p: flowItems[i] as Prepared, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rotation: 0, ...(span ? { clip: span } : {}) }
  })
  const pieceEdges = pieces?.pieceEdges ?? []
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
      if (pieceEdges.some((e) => fi.x < e && e < fi.x + fi.w)) warn({ code: 'content-overflow', itemId: fi.p.id, message: 'This block lies across a cut and will be cut through.' })
    }
  }
  const length = layout.lengthDots

  if (pieces?.pieceMin) {
    warn({ code: 'length-clamped', message: 'A piece was lengthened to the printer minimum.' })
  } else if (layout.clamped === 'min') {
    warn({ code: 'length-clamped', message: `The label was lengthened to the printer minimum of ${dotsToMm(length, dpi).toFixed(1)} mm.` })
  }
  if (layout.clamped === 'max') {
    warn({ code: 'length-clamped', message: `The label was shortened to the printer maximum of ${Math.round(dotsToMm(length, dpi))} mm.` })
  }
  if (layout.overflow) {
    const hint = doc.length.mode === 'fixed' && !doc.length.shrink && flowSource.some((i) => i.kind === 'text') ? ' Turn on “Shrink text to fit length” or make the label longer.' : ''
    const what = pieces ? 'A piece is longer than the fixed length of each piece and will be cut off.' : 'The content is longer than the fixed label length and will be cut off.'
    warn({ code: 'content-overflow', message: doc.length.mode === 'fixed' ? `${what}${hint}` : 'The content does not fit on the label and will be cut off.' })
  }
  for (const ig of split.ignored) warn({ code: 'cut-ignored', itemId: ig.itemId, message: IGNORED_CUT[ig.why] })
  for (const k of pieces?.split.kept ?? []) {
    if ((placed[k]?.x ?? 0) >= length) warn({ code: 'cut-ignored', itemId: flowItems[k]?.id ?? '', message: BEYOND_MAX_CUT })
  }

  // Cut blocks: the printer cuts there (Cut each and a cutter), or a cut mark is printed (C5).
  const marks = pieced && !c.cut ? pieceEdges.filter((x) => x > 0 && x < length) : []
  const markW = Math.max(1, mmToDots(0.25, dpi)) // table-layout.ts gridDots: the table's cut marks
  const markL = Math.max(1, Math.min(mmToDots(1.5, dpi), Math.round(band / 4)))
  // The pieces of Cut blocks on the strip; the last reaches the strip's end (free-layout blocks).
  const pieceSpans = pieces?.spans.map(([a, b], k, all): [number, number] => [a, k === all.length - 1 ? length : b])
  const decor: Decor = {
    frame,
    spans: pieceSpans ?? [[0, length]],
    marks: marks.flatMap((x) => [
      { x: x - Math.floor(markW / 2), y: 0, w: markW, h: markL },
      { x: x - Math.floor(markW / 2), y: band - markL, w: markW, h: markL },
    ]),
  }

  // Compose: tone → crisp → cut marks → codes.
  const threshold = clampInt(doc.print.threshold, 0, 255, 128)
  const raster = new Raster(length, band)
  let finished = false
  try {
    for (const pl of placed) {
      const t = pl.p.tone
      if (!t) continue
      const dy = Math.floor((pl.h - t.img.height) / 2)
      const dx = Math.floor((pl.w - t.img.width) / 2)
      blitToneIn(raster, t, pl.x + dx, pl.y + dy, band, pl.clip)
    }
    paintCrisp(raster, placed, decor, length, band, f, threshold)
    // Cut marks are protected too (an all-dark matrix): a code's quiet zone that reaches its piece
    // edge (margins 0) skips their dots instead of clearing them, so the mark still prints.
    for (const r of decor.marks) raster.blitCode({ width: r.w, height: r.h, modules: new Array<number>(r.w * r.h).fill(1) }, r.x, r.y, 1, false)
    for (const pl of placed) {
      for (const cb of pl.p.codes ?? []) {
        const uw = pl.p.w
        const uh = quarter(pl.rotation) ? pl.w : pl.h
        // Unrotated box is (p.w × placed cross size); centre vertically if the band clipped it.
        const r = rotateRect({ x: cb.dx, y: cb.dy + Math.floor((uh - pl.p.h) / 2), w: cb.m.width * cb.md, h: cb.m.height * cb.md }, uw, uh, pl.rotation)
        // The padded light modules are the quiet zone: the core clears and protects them, so
        // nothing under or next to the code can print into it (whatever the rotation).
        const code = clipCode(rotateMatrix(cb.m, pl.rotation), cb.md, pl.x + r.x, pl.clip)
        if (code) raster.blitCode(code.m, code.x, pl.y + r.y, code.md, false)
      }
    }
    const bitmap = raster.finish()
    finished = true

    if (bitmap.isBlank() && !warnings.some((w) => w.blocking)) {
      warn({ code: 'empty', blocking: true, message: doc.items.length ? 'Nothing would be printed. Add some text, an icon or a code.' : 'The label is empty. Add some text, an icon or a code.' })
    }
    const keptCuts = new Set(pieces ? pieces.split.kept : [])
    const cutBox = cutBoxOf(doc, dpi, reserve, band, length)
    const boxes: ItemBox[] = placed
      .filter((pl, i) => pl.w > 0 || pl.p.spacer || keptCuts.has(i))
      .map((pl) => (pl.p.cut ? cutBox(pl.p.id, pl.x) : pl.p.spacer ? { itemId: pl.p.id, x: pl.x, y: reserve, w: Math.max(1, pl.w), h: inner } : { itemId: pl.p.id, x: pl.x, y: pl.y, w: pl.w, h: pl.h }))
    // A table's column cuts inside its piece only (one that overflows a fixed length is cut off).
    const tableCuts = placed.flatMap((pl) => (pl.p.cuts ?? []).map((x) => pl.x + x).filter((x) => !pl.clip || (x > pl.clip[0] && x < pl.clip[1])))
    const cuts = [...new Set([...tableCuts, ...(c.cut ? pieceEdges : [])])].filter((x) => x > 0 && x < length).sort((a, b) => a - b)
    if (cuts.length && pieceMax !== undefined) {
      const edges = [0, ...cuts, length]
      const longest = Math.max(...edges.slice(1).map((e, i) => e - (edges[i] ?? 0)))
      if (longest > pieceMax) {
        warn({
          code: 'length-clamped',
          blocking: true,
          message: pieced
            ? `A piece is ${Math.round(dotsToMm(longest, dpi))} mm long; this printer prints at most ${Math.round(dotsToMm(pieceMax, dpi))} mm per piece. Add a Cut, make the columns narrower or shorten the blocks.`
            : `A piece is ${Math.round(dotsToMm(longest, dpi))} mm long; this printer prints at most ${Math.round(dotsToMm(pieceMax, dpi))} mm per piece. Make the columns narrower or shorten the blocks next to the table.`,
        })
      }
    }
    const blocking = warnings.some((w) => w.blocking)
    warnings.sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking))
    const texts = placed.flatMap((pl) => (pl.p.text ? [pl.p.text] : []))
    const ignoredWhy = new Map(split.ignored.map((ig) => [ig.index, ig.why]))
    const cutItems: CutInfo[] = flowItems.flatMap((p, i): CutInfo[] => {
      if (!p.cut) return []
      const why = ignoredWhy.get(i)
      if (why) return [{ itemId: p.id, how: 'ignored', why }]
      const x = placed[i]?.x ?? 0
      // Only a strip without machine cuts is cut to the maximum; a Cut past it prints nothing.
      if (x >= length) return [{ itemId: p.id, how: 'ignored', why: 'max' }]
      return [{ itemId: p.id, how: c.cut ? 'printer' : 'mark', x }]
    })
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
      ...(cuts.length ? { cuts } : {}),
      ...(marks.length ? { marks } : {}),
      ...(cutItems.length ? { cutItems } : {}),
      ...(pieces && pieceSpans ? { cutPieces: pieceSpans.map(([start, end], k) => ({ start, end, autoDots: pieces.autoDots[k] ?? end - start })) } : {}),
    }
  } finally {
    if (!finished) raster.free()
  }
}
