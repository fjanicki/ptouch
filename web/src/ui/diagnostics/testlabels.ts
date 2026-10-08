// W5 — built-in test labels for the Diagnostics page, built as ordinary LabelDocs and rendered
// through the W3 renderer (so they exercise the same pipeline as user labels):
//   • orientation — START … END along the label, TOP/BOTTOM across it, an asymmetric "F"
//     (reveals mirroring) and a QR code; framed to show the printable band edges.
//   • ruler — fixed 60 mm, no margins, free layout: a tick every mm (taller every 5/10 mm) with
//     numbers every 10 mm. Measure the print to verify feed resolution and margins.
import { createDoc, createItem, newId, type Item, type LabelDoc, type ShapeItem, type TapeWidthMm, type TextItem } from '../../doc/schema'

export type TestLabelKind = 'orientation' | 'ruler'

function text(t: string, patch: Partial<TextItem> = {}): TextItem {
  return { ...createItem('text'), text: t, fontFamily: 'atkinson-hyperlegible', fontWeight: 700, ...patch }
}

export function orientationDoc(widthMm: TapeWidthMm): LabelDoc {
  const items: Item[] = [
    text('START >', { align: 'start' }),
    text('TOP\nBOTTOM', { fontWeight: 600, lineHeight: 1.0 }),
    text('F', { fontFamily: 'fira-sans', fontWeight: 800 }),
  ]
  if (widthMm >= 9) items.push({ ...createItem('code'), data: 'ptouch orientation test', ecc: 'L', moduleDots: widthMm >= 18 ? 3 : 2 })
  items.push(text('> END', { align: 'end' }))
  return createDoc({
    name: `Orientation test ${widthMm} mm`,
    tape: { widthMm },
    length: { mode: 'auto' },
    marginsMm: { start: 1, end: 1 },
    layout: { mode: 'flow', gapMm: 3, align: 'center' },
    frame: { thicknessMm: 0.3, radiusMm: 0, insetMm: 0 },
    items,
  })
}

/**
 * @param bandMm height of the printable band in mm (printArea.heightDots / dpi × 25.4); ticks and
 *   numbers are placed relative to it.
 */
export function rulerDoc(widthMm: TapeWidthMm, bandMm: number, lengthMm = 60): LabelDoc {
  const items: Item[] = []
  const tickW = 0.25
  for (let mm = 0; mm <= lengthMm; mm++) {
    const major = mm % 10 === 0
    const mid = mm % 5 === 0
    const h = bandMm * (major ? 1 : mid ? 0.5 : 0.25)
    const x = Math.min(mm, lengthMm - tickW)
    const tick: ShapeItem = {
      id: newId(),
      kind: 'shape',
      shape: 'rect',
      widthMm: tickW,
      size: { mode: 'mm', mm: h },
      strokeMm: tickW,
      fill: true,
      frame: { xMm: x, yMm: 0, wMm: tickW, hMm: h, rotation: 0 },
    }
    items.push(tick)
    if (major && mm > 0 && mm < lengthMm && bandMm >= 4) {
      const th = Math.min(bandMm * 0.4, 5)
      items.push(text(String(mm), { fontFamily: 'jetbrains-mono', fontWeight: 600, size: { mode: 'mm', mm: th }, align: 'start', frame: { xMm: mm + 0.6, yMm: bandMm - th, wMm: 8, hMm: th, rotation: 0 } }))
    }
  }
  return createDoc({
    name: `Ruler test ${widthMm} mm`,
    tape: { widthMm },
    length: { mode: 'fixed', mm: lengthMm },
    marginsMm: { start: 0, end: 0 },
    layout: { mode: 'free' },
    items,
  })
}
