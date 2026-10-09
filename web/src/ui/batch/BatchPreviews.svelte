<!-- P1 (docs/STUDIO-V1-PLAN.md) — one 1-bit thumbnail per batch label (PAGE_SIZE per page),
     rendered lazily by BatchMeasure when a tile scrolls into view (one render at a time, aborted
     on every edit, bitmaps freed after painting; a tile keeps its old picture until repainted). Choosing a tile (click, Enter, Space) shows that
     label in the main preview (studio.previewRow). Labels that cannot print say so in text. -->
<script lang="ts">
  import { paintPreview } from '../../render'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { previewColors } from '../state/view-model'
  import { PAGE_SIZE, pageCount, pageOf, rowCaption } from './batch-model'
  import { batchMeasure } from './batch-measure.svelte'

  let { total }: { total: number } = $props()
  const studio = getStudio()
  const measure = batchMeasure(studio)

  let page = $state(pageOf(studio.previewRow, PAGE_SIZE))
  const pages = $derived(pageCount(total, PAGE_SIZE))
  const first = $derived(Math.min(page, pages - 1) * PAGE_SIZE)
  const rows = $derived(Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - first)) }, (_, k) => first + k))
  const colors = $derived(previewColors(studio.conn, studio.doc))

  // The page follows the preview row (chosen elsewhere: the stepper, the print bar…).
  $effect(() => {
    const row = studio.previewRow
    if (row < first || row >= first + PAGE_SIZE) page = pageOf(row, PAGE_SIZE)
  })

  /** Lazily asks BatchMeasure for tile `row` once it is (nearly) visible. */
  function thumb(canvas: HTMLCanvasElement, row: number) {
    let stop: (() => void) | undefined
    const paint = (b: Parameters<typeof paintPreview>[1]) => {
      paintPreview(canvas, b, colors)
      canvas.dataset.painted = 'true'
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        if (visible && !stop) stop = measure.want(row, paint)
      },
      { rootMargin: '120px' },
    )
    io.observe(canvas)
    return {
      destroy() {
        io.disconnect()
        stop?.()
      },
    }
  }

  function choose(row: number) {
    studio.previewRow = row
    studio.announce(`Previewing label ${row + 1} of ${total}`)
  }
</script>

<div class="previews">
  <ul class="grid" aria-label="Batch labels">
    {#each rows as row (`${row}|${colors.tape}|${colors.ink}`)}
      {@const info = measure.row(row)}
      <li>
        <button type="button" class="tile" class:current={studio.previewRow === row} aria-pressed={studio.previewRow === row} onclick={() => choose(row)}>
          <span class="thumb">
            <canvas use:thumb={row} aria-hidden="true"></canvas>
          </span>
          <span class="caption">{rowCaption(studio.doc, row)}</span>
          {#if info?.problem}<span class="problem"><Icon name="alert" size={12} />Can’t print: {info.problem}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if pages > 1}
    <nav class="pager" aria-label="Label pages">
      <button type="button" class="btn icon small" aria-label="Previous labels" disabled={first === 0} onclick={() => (page = pageOf(first, PAGE_SIZE) - 1)}><Icon name="chevron-left" size={14} /></button>
      <span>Labels {first + 1}–{first + rows.length} of {total}</span>
      <button type="button" class="btn icon small" aria-label="Next labels" disabled={first + PAGE_SIZE >= total} onclick={() => (page = pageOf(first, PAGE_SIZE) + 1)}><Icon name="chevron-right" size={14} /></button>
    </nav>
  {/if}
</div>

<style>
  .previews {
    display: grid;
    gap: var(--space-2);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tile {
    display: grid;
    gap: 4px;
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tile:hover {
    border-color: var(--border-strong);
  }
  .tile.current {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    background: var(--accent-soft);
  }
  .thumb {
    display: grid;
    place-items: center;
    height: 48px;
    border-radius: 4px;
    background: var(--canvas-bg);
    overflow: hidden;
  }
  canvas {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
    box-shadow: var(--shadow-1);
  }
  canvas:not([data-painted]) {
    width: 60%;
    height: 50%;
    background: var(--surface-3);
    box-shadow: none;
  }
  .caption {
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile.current .caption::after {
    content: ' · shown';
    font-weight: 400;
    color: var(--text-muted);
  }
  .problem {
    display: flex;
    gap: 4px;
    align-items: flex-start;
    font-size: 11px;
    color: var(--danger);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 420px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
