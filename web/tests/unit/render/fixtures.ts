// W3 — PT-P710BT geometry fixtures, copied from the core media table (crates/ptouch/src/model/
// generated.rs: tze128-24 / tze128-12 / tze128-6) so render tests do not depend on printArea().
import type { MediaInfo, PrintArea } from '../../../src/wasm'

export const AREA_24: PrintArea = {
  model: 'PT-P710BT',
  mediaId: 'tze128-24',
  dpi: 180,
  heightDots: 128,
  tapeWidthDots: 170,
  leftMarginPins: 0,
  rightMarginPins: 0,
  minLengthDots: 3,
  maxLengthDots: 7086,
  defaultFeedDots: 14,
  maxFeedDots: 900,
}

export const MEDIA_24: MediaInfo = {
  id: 'tze128-24',
  kind: 'tze',
  widthMm: 24,
  widthByte: 24,
  printPins: 128,
  leftMarginPins: 0,
  rightMarginPins: 0,
  tapeWidthDots: 170,
  defaultFeedDots: 14,
}

export const AREA_12: PrintArea = { ...AREA_24, mediaId: 'tze128-12', heightDots: 70, tapeWidthDots: 84, leftMarginPins: 29, rightMarginPins: 29 }
export const MEDIA_12: MediaInfo = { ...MEDIA_24, id: 'tze128-12', widthMm: 12, widthByte: 12, printPins: 70, leftMarginPins: 29, rightMarginPins: 29, tapeWidthDots: 84 }

export const AREA_6: PrintArea = { ...AREA_24, mediaId: 'tze128-6', heightDots: 32, tapeWidthDots: 42, leftMarginPins: 48, rightMarginPins: 48 }
export const MEDIA_6: MediaInfo = { ...MEDIA_24, id: 'tze128-6', widthMm: 6, widthByte: 6, printPins: 32, leftMarginPins: 48, rightMarginPins: 48, tapeWidthDots: 42 }
