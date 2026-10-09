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
  | 'code-too-small' // module < 1 dot or code taller than the band
  | 'code-invalid' // encodeCode failed (bad EAN digits, data too long…)
  | 'content-overflow' // fixed length too short / item taller than the band (clipped)
  | 'image-missing' // blobRef not found
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
