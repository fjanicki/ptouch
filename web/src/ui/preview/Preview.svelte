<!-- W4 — the exact Bitmap1 (render.paintPreview), tape-tinted, on a to-scale tape with the
     printable band, tape edges, feed margins and cut lines; ruler in mm; length readout; zoom
     (fit / real size / steps); Design vs Exact-dots modes; click a block to select it. -->
<script lang="ts">
  import { paintPreview } from '../../render'
  import Icon from '../common/Icon.svelte'
  import Segmented from '../common/Segmented.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { formatMm, previewColors, realScale, rulerSteps, zoomPercent, zoomStep } from '../state/view-model'
  import { savePrefs } from '../../doc/persist-prefs'

  const studio = getStudio()
  let canvas: HTMLCanvasElement | undefined = $state()
  let stageW = $state(0)
  let hoverId = $state<string | null>(null)

  const mode = $derived(studio.prefs.previewMode)
  const result = $derived(studio.render)
  const area = $derived(studio.target.ok ? studio.target.target.area : null)
  const dpi = $derived(area?.dpi ?? 180)
  const colors = $derived(previewColors(studio.conn, studio.doc))

  // Geometry in dots.
  const lengthDots = $derived(result?.lengthDots ?? 0)
  const bandDots = $derived(result?.heightDots ?? area?.heightDots ?? 128)
  const tapeDots = $derived(Math.max(area?.tapeWidthDots ?? bandDots, bandDots))
  const bandOffset = $derived((tapeDots - bandDots) / 2)
  const feedDots = $derived(result ? Math.round((result.feedMarginMm * dpi) / 25.4) : (area?.defaultFeedDots ?? 14))
  const totalDots = $derived(lengthDots + 2 * feedDots)
  const totalMm = $derived((totalDots * 25.4) / dpi)

  // Publish the fit scale (stage width minus padding; tape at most ~300 px tall).
  $effect(() => {
    if (totalDots > 0 && stageW > 0) studio.updateFit(stageW - 48, 300, totalDots, tapeDots, dpi)
  })

  const scale = $derived(studio.scale)
  const px = (dots: number) => dots * scale
  const pxPerMm = $derived((scale * dpi) / 25.4)
  const ruler = $derived(rulerSteps(pxPerMm))
  const ticks = $derived.by(() => {
    const out: { x: number; major: boolean; label?: string }[] = []
    if (totalMm <= 0) return out
    for (let mm = 0; mm <= totalMm + 1e-6; mm += ruler.minor) {
      const major = Math.abs(mm % ruler.label) < 1e-6
      out.push({ x: mm * pxPerMm, major, ...(major ? { label: String(Math.round(mm)) } : {}) })
    }
    return out
  })
  const marginStartPx = $derived(px((studio.doc.marginsMm.start * dpi) / 25.4))
  const marginEndPx = $derived(px((studio.doc.marginsMm.end * dpi) / 25.4))
  const smooth = $derived(mode === 'design' && scale < 1)
  const showGrid = $derived(mode === 'dots' && scale >= 4)
  const labelWarnings = $derived((result?.warnings ?? []).filter((w) => !w.itemId))
  const selectedBox = $derived(result?.boxes.find((b) => b.itemId === studio.selectedId) ?? null)
  const hoverBox = $derived(hoverId && hoverId !== studio.selectedId ? (result?.boxes.find((b) => b.itemId === hoverId) ?? null) : null)

  $effect(() => {
    const r = result
    const c = colors
    if (!canvas || !r) return
    try {
      paintPreview(canvas, r.bitmap, { tape: c.tape, ink: c.ink })
    } catch (e) {
      console.error('preview paint failed', e)
    }
  })

  function boxAt(e: PointerEvent | MouseEvent): string | null {
    if (!result || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * result.lengthDots
    const y = ((e.clientY - rect.top) / rect.height) * result.heightDots
    const hit = [...result.boxes].reverse().find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
    return hit?.itemId ?? null
  }

  /** Pointer selection on the band (keyboard users select in the block list). */
  function pointerSelect(node: HTMLElement) {
    const click = (e: MouseEvent) => {
      const id = boxAt(e)
      if (id) studio.select(id)
    }
    const move = (e: PointerEvent) => (hoverId = boxAt(e))
    const leave = () => (hoverId = null)
    node.addEventListener('click', click)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerleave', leave)
    return () => {
      node.removeEventListener('click', click)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerleave', leave)
    }
  }

  function setMode(m: 'design' | 'dots') {
    studio.prefs = savePrefs({ previewMode: m })
  }
  function zoomBy(dir: 1 | -1) {
    studio.zoom = zoomStep(scale / realScale(dpi), dir)
  }
</script>

<section class="preview panel" aria-label="Label preview" data-ready={result ? 'true' : 'false'}>
  <div class="toolbar">
    <Segmented
      label="View"
      hideLabel
      size="small"
      options={[
        { value: 'design', label: 'Design' },
        { value: 'dots', label: 'Exact dots' },
      ]}
      value={mode}
      onchange={setMode}
    />
    <div class="status" aria-hidden="true">
      {#if studio.rendering && result}<span class="busy"><Icon name="loader" size={14} />Updating</span>{/if}
    </div>
    <div class="zoom" role="group" aria-label="Zoom">
      <button type="button" class="btn ghost icon small" aria-label="Zoom out" title="Zoom out (−)" onclick={() => zoomBy(-1)}><Icon name="minus" size={16} /></button>
      <button type="button" class="btn ghost small zoom-value" title="Zoom to fit (0)" aria-label="Zoom {zoomPercent(scale, dpi)}{studio.zoom === 'fit' ? ', fit to window' : ''}. Activate to fit." onclick={() => (studio.zoom = 'fit')}>
        {studio.zoom === 'fit' ? 'Fit · ' : ''}{zoomPercent(scale, dpi)}
      </button>
      <button type="button" class="btn ghost icon small" aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomBy(1)}><Icon name="plus" size={16} /></button>
      <button type="button" class="btn ghost small" aria-pressed={studio.zoom === 1} title="Real size (1)" onclick={() => (studio.zoom = 1)}>1:1</button>
    </div>
  </div>

  <!-- Focusable so keyboard users can scroll a label longer than the stage (arrow keys); single-key
       zoom shortcuts work here. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="stage" bind:clientWidth={stageW} class:grid={showGrid} tabindex="0" role="group" aria-label="Label preview (scrollable)" data-shortcut-scope>
    {#if studio.wasm === 'loading'}
      <div class="placeholder"><span class="spin"><Icon name="loader" size={22} /></span>Loading the label engine…</div>
    {:else if studio.wasm === 'error'}
      <div class="placeholder error" role="alert">
        <Icon name="alert" size={22} />
        <span>The label engine could not be loaded. Check that the browser supports WebAssembly, then reload.</span>
        <button type="button" class="btn small" onclick={() => location.reload()}>Reload</button>
      </div>
    {:else if !result}
      {#if studio.renderError}
        <div class="placeholder error" role="alert"><Icon name="alert" size={22} /><span>Preview unavailable: {studio.renderError}</span></div>
      {:else}
        <div class="placeholder"><span class="spin"><Icon name="loader" size={22} /></span>Rendering…</div>
      {/if}
    {:else}
      <figure class="label" style:width="{px(totalDots)}px" aria-label="Label preview, {formatMm(totalMm)} long on {formatMm(studio.doc.tape.widthMm)} tape">
        <div
          class="tape"
          class:design={mode === 'design'}
          style:width="{px(totalDots)}px"
          style:height="{px(tapeDots)}px"
          style:--tape={colors.tape}
          style:--ink={colors.ink}
        >
          <div class="band" style:left="{px(feedDots)}px" style:top="{px(bandOffset)}px" style:width="{px(lengthDots)}px" style:height="{px(bandDots)}px" {@attach pointerSelect}>
            <canvas bind:this={canvas} class:smooth style:width="{px(lengthDots)}px" style:height="{px(bandDots)}px" aria-hidden="true"></canvas>
            {#if mode === 'design'}
              {#if marginStartPx > 0}<span class="margin start" style:width="{marginStartPx}px"></span>{/if}
              {#if marginEndPx > 0}<span class="margin end" style:width="{marginEndPx}px"></span>{/if}
              {#if hoverBox}
                <span class="box hover" style:left="{px(hoverBox.x)}px" style:top="{px(hoverBox.y)}px" style:width="{px(hoverBox.w)}px" style:height="{px(hoverBox.h)}px"></span>
              {/if}
              {#if selectedBox}
                <span class="box selected" style:left="{px(selectedBox.x)}px" style:top="{px(selectedBox.y)}px" style:width="{px(selectedBox.w)}px" style:height="{px(selectedBox.h)}px"></span>
              {/if}
            {/if}
            {#if showGrid}<span class="dotgrid" style:background-size="{scale}px {scale}px"></span>{/if}
          </div>
          <span class="cut start" aria-hidden="true"></span>
          <span class="cut end" aria-hidden="true"></span>
        </div>
        <svg class="ruler" width={px(totalDots)} height="26" aria-hidden="true">
          {#each ticks as t, i (i)}
            <line x1={t.x + 0.5} x2={t.x + 0.5} y1="0" y2={t.major ? 9 : 5} />
            {#if t.label !== undefined}<text x={t.x + 0.5} y="21" text-anchor={i === 0 ? 'start' : 'middle'}>{t.label}</text>{/if}
          {/each}
        </svg>
        <figcaption class="dimension">
          <span class="arrow left" aria-hidden="true"></span>
          <strong>{formatMm(totalMm)}</strong>
          <span class="arrow right" aria-hidden="true"></span>
        </figcaption>
      </figure>
    {/if}
  </div>

  {#if result}
    <div class="readout">
      <span><strong>{formatMm(totalMm)}</strong> label</span>
      <span>{formatMm(result.lengthMm)} printed + 2 × {formatMm(result.feedMarginMm)} feed</span>
      <span>{formatMm(studio.doc.tape.widthMm)} tape · printable {formatMm((bandDots * 25.4) / dpi)} ({bandDots} dots)</span>
      {#if studio.doc.print.mirror}<span class="badge"><Icon name="flip" size={14} />Mirrored when printed</span>{/if}
      {#if colors.fromPrinter}<span class="badge">Colours from printer</span>{/if}
    </div>
  {/if}
  {#if labelWarnings.length}
    <ul class="warnings">
      {#each labelWarnings as w, i (i)}<li class:blocking={result?.blocking && (w.code === 'canvas-noise' || w.code === 'code-invalid')}><Icon name="alert" size={14} />{w.message}</li>{/each}
    </ul>
  {/if}
</section>

<style>
  .preview {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) var(--space-3);
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .toolbar :global(.seg-wrap) {
    width: 190px;
  }
  .status {
    flex: 1;
    min-width: 0;
  }
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .busy :global(svg),
  .spin {
    animation: spin 0.9s linear infinite;
  }
  .spin {
    display: inline-flex;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .zoom-value {
    min-width: 84px;
    font-variant-numeric: tabular-nums;
  }
  .zoom [aria-pressed='true'] {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .stage {
    position: relative;
    display: grid;
    align-items: center;
    justify-items: safe center;
    min-height: 220px;
    padding: var(--space-5);
    overflow: auto;
    border-radius: var(--radius-m);
    background-color: var(--canvas-bg);
    background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size: 16px 16px;
  }
  .placeholder {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 420px;
    color: var(--text-muted);
    text-align: left;
  }
  .placeholder.error {
    color: var(--danger);
    flex-wrap: wrap;
  }
  .label {
    margin: 0 auto;
    display: grid;
    gap: 2px;
  }
  .tape {
    position: relative;
    background: var(--tape);
    border-radius: 2px;
    box-shadow: var(--shadow-tape);
  }
  /* Unprintable tape edges: faint hatch so the printable band reads clearly. */
  .tape.design::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--ink) 6%, transparent) 0 1px, transparent 1px 7px);
    pointer-events: none;
  }
  .band {
    position: absolute;
    background: var(--tape);
    cursor: default;
  }
  .design .band {
    outline: 1px dashed color-mix(in srgb, var(--selection) 55%, transparent);
  }
  canvas {
    display: block;
    image-rendering: pixelated;
  }
  canvas.smooth {
    image-rendering: auto;
  }
  .margin {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--selection) 7%, transparent);
    pointer-events: none;
  }
  .margin.start {
    left: 0;
    border-right: 1px dotted color-mix(in srgb, var(--selection) 60%, transparent);
  }
  .margin.end {
    right: 0;
    border-left: 1px dotted color-mix(in srgb, var(--selection) 60%, transparent);
  }
  .box {
    position: absolute;
    pointer-events: none;
    border-radius: 2px;
  }
  .box.selected {
    outline: 2px solid var(--selection);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--selection) 20%, transparent);
  }
  .box.hover {
    outline: 1px dashed var(--selection);
    outline-offset: 1px;
  }
  .dotgrid {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(to right, color-mix(in srgb, var(--selection) 22%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom, color-mix(in srgb, var(--selection) 22%, transparent) 1px, transparent 1px);
  }
  .cut {
    position: absolute;
    top: -6px;
    bottom: -6px;
    width: 0;
    border-left: 1.5px dashed var(--text-muted);
  }
  .cut.start {
    left: 0;
  }
  .cut.end {
    right: 0;
  }
  .ruler {
    display: block;
    overflow: visible;
  }
  .ruler line {
    stroke: var(--text-muted);
    stroke-width: 1;
  }
  .ruler text {
    fill: var(--text-muted);
    font: 10px var(--font-ui);
  }
  .dimension {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .arrow {
    flex: 1;
    position: relative;
    height: 1px;
    background: var(--text-muted);
    min-width: 8px;
  }
  .arrow.left::before,
  .arrow.right::after {
    content: '';
    position: absolute;
    top: -4px;
    border: 4px solid transparent;
  }
  .arrow.left::before {
    left: -1px;
    border-right-color: var(--text-muted);
    border-left: 0;
  }
  .arrow.right::after {
    right: -1px;
    border-left-color: var(--text-muted);
    border-right: 0;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    color: var(--text-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .readout strong {
    color: var(--text);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    border-radius: 999px;
    background: var(--surface-2);
  }
  .warnings {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-s);
    background: var(--warn-soft);
    font-size: 13px;
    display: grid;
    gap: 2px;
  }
  .warnings li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .warnings li.blocking {
    color: var(--danger);
    font-weight: 600;
  }
  .warnings :global(svg) {
    color: var(--warn);
    transform: translateY(2px);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
