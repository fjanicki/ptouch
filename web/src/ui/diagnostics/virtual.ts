// W5 — "virtual printer" pipeline for the Diagnostics page: LabelDoc → W3 renderer → wasm
// encodeJob (via buildPrintJob) → bytes for "Download .bin" → wasm decodeJob → decoded pages
// (what a printer would print) for side-by-side comparison with the preview.
// Printer models (docs/MODELS-PLAN.md; P-core-ui): runs and the virtual probe use the studio's
// active model (the connected printer's, else the "Design for" model), not a fixed PT-P710BT.
import type { LabelDoc } from '../../doc/schema'
import { buildPrintJob, ensureFonts, paintPreview, renderLabel, type RenderResult, type RenderTarget } from '../../render'
import { decodeJob, mediaForWidth, printArea, type Bitmap1, type MediaInfo } from '../../wasm'

/** Render target for `widthMm` on `model`; reuses `loaded` media (from the printer status) when it matches. */
export function resolveTarget(model: string, widthMm: number, loaded?: MediaInfo | null): RenderTarget {
  const media = loaded && loaded.widthMm === widthMm ? loaded : mediaForWidth(model, widthMm)
  return { model, media, area: printArea(model, media.id) }
}

export interface VirtualRun {
  target: RenderTarget
  render: RenderResult
  bytes: Uint8Array
  pageCount: number
  totalLines: number
  /** Decoded pages (label orientation). Owned by the run: call `freeRun()`. */
  decoded: Bitmap1[]
  violations: string[]
  commands: string[]
}

/**
 * Renders `doc` as the studio would for `target` and runs it through the encoder and decoder.
 * `cutter`: the model has a cutter (Studio.cutterFor), so a table cut between its columns is
 * split into pieces exactly as in the preview and the real print (render `RenderOptions.cutter`).
 */
export async function runVirtual(doc: LabelDoc, target: RenderTarget, loadBlob?: (ref: string) => Promise<Blob | undefined>, signal?: AbortSignal, cutter?: boolean): Promise<VirtualRun> {
  await ensureFonts(doc)
  const render = await renderLabel(doc, target, { ...(loadBlob ? { loadBlob } : {}), ...(signal ? { signal } : {}), ...(cutter !== undefined ? { cutter } : {}) })
  try {
    const job = buildPrintJob(doc, render, target)
    let bytes: Uint8Array
    let pageCount: number
    let totalLines: number
    try {
      bytes = job.toBytes()
      pageCount = job.pageCount
      totalLines = job.totalLines
    } finally {
      job.free()
    }
    const dec = decodeJob(target.model, bytes)
    try {
      return { target, render, bytes, pageCount, totalLines, decoded: dec.pages(), violations: dec.violations(), commands: dec.commands() }
    } finally {
      dec.free()
    }
  } catch (e) {
    render.bitmap.free()
    throw e
  }
}

export function freeRun(run: VirtualRun | null | undefined): void {
  if (!run) return
  run.render.bitmap.free()
  for (const p of run.decoded) p.free()
}

/** PNG of a bitmap (black on white, exact dots). */
export function bitmapPng(bitmap: Bitmap1): Promise<Blob> {
  const canvas = document.createElement('canvas')
  paintPreview(canvas, bitmap, { tape: '#ffffff', ink: '#000000' })
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'))
}

/** "Cable tags" → "cable-tags". */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'label'
  )
}

/** Download base name for a run, e.g. "ptouch-orientation-test-24mm". */
export function runFileBase(doc: LabelDoc, target: RenderTarget): string {
  const name = doc.name.replace(/\s*\d+(?:\.\d+)?\s*mm\s*$/i, '')
  return `ptouch-${slug(name)}-${`${target.media.widthMm}mm`.replace('.', '_')}`
}
