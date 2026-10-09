// W3 — renderer contract (frozen interface between W3 renderer and W4/W5 UI).
import type { Bitmap1, MediaInfo, PrintArea } from '../wasm'

/** What we render for: the loaded (or chosen) model + media. */
export interface RenderTarget {
  model: string
  media: MediaInfo
  area: PrintArea
}

export type RenderWarningCode =
  | 'font-fallback' // a family/weight did not load; system fallback used
  | 'font-missing' // a custom (uploaded/local) font is not on this device; the bundled family is used
  | 'small-text' // text < 2 mm tall prints poorly at 180 dpi
  | 'font-quality' // a thin or script font (FontDef.quality) below MIN_QUALITY_CAP_MM cap height
  | 'code-too-small' // module < 1 dot or code taller than the band
  | 'code-invalid' // encodeCode failed (bad EAN digits, data too long…)
  | 'content-overflow' // fixed length too short / item taller than the band (clipped)
  | 'image-missing' // blobRef not found
  | 'icons-missing' // the icon catalogue chunk could not be loaded (offline, stale deploy)
  | 'length-clamped' // below printer minimum (padded) or above maximum
  | 'canvas-noise' // anti-fingerprinting detected: printing must be blocked
  | 'empty' // nothing would be printed

export interface RenderWarning {
  code: RenderWarningCode
  itemId?: string
  /** User-facing sentence (English). */
  message: string
  /** This warning blocks printing (`RenderResult.blocking`). Blocking warnings come first. */
  blocking?: boolean
}

/** Item bounding box in dots (canvas coords: x along the label, y across the tape). */
export interface ItemBox {
  itemId: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * How a text block was sized (docs/FONTS-AND-SIZE-PLAN.md §2.5): read by the font picker (quality
 * hint, "crisp" badge) and the quick sizes (length estimates). Dots, unrotated.
 */
export interface TextRenderInfo {
  itemId: string
  /** Em size the block was drawn at (after fit / shrink / pixel snapping). */
  emDots: number
  /** Cap height of one line. */
  capDots: number
  /** Ink width of the block (its length along the label when not rotated). */
  widthDots: number
  /** Scaled down by "shrink to fit length" (factor < 1), absent otherwise. */
  shrink?: number
  /** Pixel font drawn at a whole multiple of its design grid: that multiple (dots per font
   * pixel). Absent for other fonts and when the size could not be snapped. */
  pixelScale?: number
}

export interface RenderResult {
  /** The exact dots that are previewed AND printed. Owned by the caller: free() when replaced. */
  bitmap: Bitmap1
  lengthDots: number
  heightDots: number
  lengthMm: number
  /** Printer feed margin at each end (mm) — drawn by the preview, not part of the bitmap. */
  feedMarginMm: number
  boxes: ItemBox[]
  warnings: RenderWarning[]
  /** `true` when printing must be blocked (canvas noise, invalid code, empty label). */
  blocking: boolean
  /** Content is longer than a fixed length / the printer maximum, or taller than the band. */
  overflow?: boolean
  /** One entry per non-empty text block (P-size fills it; absent until then). */
  texts?: TextRenderInfo[]
}

export interface RenderOptions {
  /** Crisp-plane supersampling factor (odd, 1–7; default 3). */
  factor?: number
  /** Resolve ImageItem.blobRef (W5 store.getBlob). */
  loadBlob?: (ref: string) => Promise<Blob | undefined>
  /** Resolve an uploaded font (`FontSource` kind 'user', persist-fonts.ts FontStore.get). */
  loadFontBlob?: (ref: string) => Promise<Blob | undefined>
  signal?: AbortSignal
}

export interface PreviewColors {
  /** CSS colours; from the printer status (tapeColor.css / textColor.css) or doc.tape.colors. */
  tape: string
  ink: string
}
