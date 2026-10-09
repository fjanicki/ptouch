// P1 (docs/STUDIO-V1-PLAN.md) — renders batch labels off the critical path, one at a time:
// first the thumbnails the preview grid shows (lazily, as they scroll into view), then every
// other label in the background to MEASURE its length, so the print bar's tape estimate becomes
// exact. Results are keyed by (doc object, target, fonts version): any edit aborts the run,
// clears the results and starts again after a short pause. Every bitmap is freed right after
// it was measured / painted. Shared by BatchPanel and PrintBar (one instance per Studio).
import type { LabelDoc } from '../../doc/schema'
import { batchSize } from '../../doc/variables'
import type { RenderTarget } from '../../render'
import type { Bitmap1 } from '../../wasm'
import type { Studio } from '../state/studio.svelte'
import { renderBatchLabel } from './batch-job'

/** Paints a rendered label (the bitmap is freed after the call returns). */
export type Painter = (bitmap: Bitmap1) => void

export interface RowInfo {
  lengthMm: number
  /** The label cannot be printed (first blocking warning). */
  problem?: string
  /** It prints, but not as designed: text cut off or too small to read (first such warning). */
  notice?: string
}

/** Non-blocking warnings worth flagging per batch row, most important first: a long value cut
 * off, or shrunk too far to read. */
const ROW_NOTICES = ['content-overflow', 'small-text'] as const

/** Wait after an edit before rendering again (typing in a cell re-keys every keystroke). */
const SETTLE_MS = 350

export class BatchMeasure {
  /** Bumped whenever results change (reactive dependency for the getters below). */
  #version = $state(0)
  #rows = new Map<number, RowInfo>()
  #feedMarginMm = 0
  #key = ''
  #doc: LabelDoc | null = null
  #target: RenderTarget | null = null
  #total = 0
  #painters = new Map<number, Set<Painter>>()
  #ac: AbortController | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #running = false
  #next = 0
  #studio: Studio

  constructor(studio: Studio) {
    this.#studio = studio
  }

  /** Labels measured so far. */
  get measured(): number {
    void this.#version
    return this.#rows.size
  }

  /** Labels of the current batch. */
  get total(): number {
    void this.#version
    return this.#total
  }

  get feedMarginMm(): number {
    void this.#version
    return this.#feedMarginMm
  }

  /** Measured length per label (undefined = not yet). */
  get lengths(): (number | undefined)[] {
    void this.#version
    return Array.from({ length: this.#total }, (_, i) => this.#rows.get(i)?.lengthMm)
  }

  row(i: number): RowInfo | undefined {
    void this.#version
    return this.#rows.get(i)
  }

  /** Labels that cannot be printed (0-based index → message). */
  get problems(): [number, string][] {
    void this.#version
    return [...this.#rows].filter(([, r]) => r.problem).map(([i, r]) => [i, r.problem ?? ''])
  }

  /** Labels that print, but cut off or with text too small (0-based index → message). */
  get notices(): [number, string][] {
    void this.#version
    return [...this.#rows].filter(([, r]) => !r.problem && r.notice).map(([i, r]) => [i, r.notice ?? ''])
  }

  /** Follow the studio's doc / target (call from an effect). Idempotent per key. */
  sync(doc: LabelDoc, target: RenderTarget | null, fontsVersion: number): void {
    const total = target ? batchSize(doc) : 0
    const key = target ? `${target.model}|${target.media.id}|${fontsVersion}|${total}` : ''
    if (doc === this.#doc && key === this.#key) return
    this.#doc = doc
    this.#key = key
    this.#target = target
    this.#total = total
    this.#ac?.abort()
    this.#ac = null
    this.#rows = new Map()
    this.#next = 0
    this.#version++
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (total > 0) this.#timer = setTimeout(() => void this.#run(), SETTLE_MS)
  }

  /** Paint label `i` when it is rendered (again for every new doc) until the returned function
   * is called. Visible thumbnails are rendered before the background measuring continues. */
  want(i: number, paint: Painter): () => void {
    let set = this.#painters.get(i)
    if (!set) this.#painters.set(i, (set = new Set()))
    set.add(paint)
    if (this.#total > 0 && !this.#running && !this.#ac?.signal.aborted && this.#timer === undefined) void this.#run()
    return () => {
      set.delete(paint)
      this.#painted.delete(paint)
      if (set.size === 0 && this.#painters.get(i) === set) this.#painters.delete(i)
    }
  }

  /** Thumbnails already painted for the current doc. */
  #painted = new Map<Painter, LabelDoc>()

  #pick(): number | undefined {
    const doc = this.#doc
    for (const [i, set] of this.#painters) {
      if (i >= this.#total) continue
      for (const p of set) if (this.#painted.get(p) !== doc) return i
    }
    while (this.#next < this.#total && this.#rows.has(this.#next)) this.#next++
    return this.#next < this.#total ? this.#next : undefined
  }

  async #run(): Promise<void> {
    this.#timer = undefined
    if (this.#running) return
    const doc = this.#doc
    const target = this.#target
    if (!doc || !target) return
    this.#running = true
    const ac = new AbortController()
    this.#ac = ac
    const studio = this.#studio
    try {
      for (;;) {
        if (ac.signal.aborted || this.#doc !== doc) return
        const i = this.#pick()
        if (i === undefined) return
        let r
        try {
          r = await renderBatchLabel(doc, i, target, {
            now: new Date(),
            loadBlob: (ref) => studio.store.getBlob(ref),
            loadFontBlob: (ref) => studio.fonts.get(ref),
            signal: ac.signal,
          })
        } catch (e) {
          if (ac.signal.aborted) return
          this.#rows.set(i, { lengthMm: 0, problem: e instanceof Error ? e.message : String(e) })
          for (const p of this.#painters.get(i) ?? []) this.#painted.set(p, doc) // never retried for this doc
          this.#version++
          continue
        }
        try {
          if (ac.signal.aborted || this.#doc !== doc) return
          const w = r.blocking ? (r.warnings.find((x) => x.blocking) ?? r.warnings[0]) : undefined
          const n = r.blocking ? undefined : ROW_NOTICES.map((code) => r.warnings.find((x) => x.code === code)).find((x) => x !== undefined)
          this.#rows.set(i, { lengthMm: r.lengthMm, ...(r.blocking ? { problem: w?.message ?? 'Cannot be printed as designed.' } : {}), ...(n ? { notice: n.message } : {}) })
          this.#feedMarginMm = r.feedMarginMm
          for (const p of this.#painters.get(i) ?? []) {
            if (this.#painted.get(p) === doc) continue
            this.#painted.set(p, doc)
            try {
              p(r.bitmap)
            } catch (e) {
              console.warn('batch thumbnail failed', e)
            }
          }
          this.#version++
        } finally {
          r.bitmap.free()
        }
        // Yield between labels: typing and the main preview stay responsive.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      this.#running = false
      if (this.#ac === ac) this.#ac = null
      // A newer doc arrived while this run finished: its timer may have fired into `running`.
      if (this.#doc !== doc && this.#total > 0 && this.#timer === undefined) this.#timer = setTimeout(() => void this.#run(), SETTLE_MS)
    }
  }

  /** Stops rendering (the panel unmounted, e.g. for the diagnostics view); the next `sync`
   * starts over. */
  dispose(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#ac?.abort()
    this.#painters.clear()
    this.#painted.clear()
    this.#doc = null
    this.#key = ''
  }
}

const instances = new WeakMap<Studio, BatchMeasure>()

/** The studio's shared BatchMeasure. */
export function batchMeasure(studio: Studio): BatchMeasure {
  let m = instances.get(studio)
  if (!m) instances.set(studio, (m = new BatchMeasure(studio)))
  return m
}
