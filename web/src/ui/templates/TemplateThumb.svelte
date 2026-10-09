<!-- P2 — live thumbnail of one template: the exact 1-bit dots (renderLabel with sample Wi-Fi
     data and resolved placeholders) on a to-scale piece of tape. Rendered once the card scrolls
     into view, through the gallery's bounded queue; aborted on unmount; the bitmap is freed as
     soon as it is painted. Decorative (the card button carries the name and description). -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { resolveDoc } from '../../doc/variables'
  import { paintPreview, renderLabel, type PreviewColors } from '../../render'
  import { loadWasm, mediaForWidth, printArea, release } from '../../wasm'
  import { withSampleData, type TemplateDef } from './templates'
  import type { TaskQueue } from './gallery'

  let { template, model, colors, queue }: { template: TemplateDef; model: string; colors: PreviewColors; queue: TaskQueue } = $props()

  /** CSS px per mm of tape (24 mm tape → 48 px tall; labels up to ≈ 120 mm keep this scale). */
  const PX_PER_MM = 2

  let host: HTMLElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let phase = $state<'idle' | 'ready' | 'failed'>('idle')
  /** Rendered label length and printable band (mm). */
  let rendered = $state<{ lengthMm: number; bandMm: number } | null>(null)
  /** Before the render: the fixed length, or a typical short label. */
  const guessMm = $derived.by(() => {
    const l = template.build().length
    return l.mode === 'fixed' ? l.mm : 40
  })
  const lengthMm = $derived(rendered?.lengthMm ?? guessMm)
  const bandMm = $derived(rendered?.bandMm ?? template.tapeWidthMm)
  const ac = new AbortController()
  onDestroy(() => ac.abort())

  async function draw(): Promise<void> {
    await loadWasm()
    const media = mediaForWidth(model, template.tapeWidthMm)
    const area = printArea(model, media.id)
    const doc = resolveDoc(withSampleData(template.build()), 0, { now: new Date() }).doc
    const r = await renderLabel(doc, { model, media, area }, { signal: ac.signal })
    try {
      if (ac.signal.aborted || !canvas) return
      paintPreview(canvas, r.bitmap, colors)
      rendered = { lengthMm: r.lengthMm, bandMm: (r.heightDots * 25.4) / area.dpi }
      phase = 'ready'
    } finally {
      release(r.bitmap)
    }
  }

  $effect(() => {
    const el = host
    if (!el || phase !== 'idle') return
    const start = () =>
      void queue.run(draw, ac.signal).catch(() => {
        if (!ac.signal.aborted) phase = 'failed'
      })
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        start()
      },
      { rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  })
</script>

<div class="thumb" bind:this={host} style:height="calc({24 * PX_PER_MM}px + 2 * var(--space-2))" aria-hidden="true" data-state={phase}>
  <div
    class="tape"
    style:width="min(100%, {lengthMm * PX_PER_MM}px)"
    style:aspect-ratio="{lengthMm} / {template.tapeWidthMm}"
    style:background={colors.tape}
  >
    <canvas
      bind:this={canvas}
      class:shown={phase === 'ready'}
      style:top="{((template.tapeWidthMm - bandMm) / 2 / template.tapeWidthMm) * 100}%"
      style:height="{(bandMm / template.tapeWidthMm) * 100}%"
    ></canvas>
  </div>
</div>

<style>
  .thumb {
    display: grid;
    place-items: center;
    padding: var(--space-2);
  }
  .tape {
    position: relative;
    max-height: 100%;
    border-radius: 2px;
    box-shadow: var(--shadow-1);
    overflow: hidden;
  }
  canvas {
    position: absolute;
    left: 0;
    width: 100%;
    visibility: hidden;
  }
  canvas.shown {
    visibility: visible;
  }
</style>
