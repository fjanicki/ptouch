<!-- Quick text sizes XS S M L Fit (docs/FONTS-AND-SIZE-PLAN.md §3.3, P-size). Mounted by
     TextProps (variant 'props', above the detailed size field) and by App.svelte under the
     preview while a text block is selected (variant 'compact'). Props are frozen: `item`,
     `variant`. Sizes come from render/text-size.ts `quickTextSizes` for the band the block is
     sized in (`itemSizingBand`), and are stored as ordinary mm sizes.

     Each button shows the label length that size gives: the block is measured at every size with
     the renderer's own sizing (text-size.ts `quickReadouts`; placeholders filled like the preview), and the
     difference to the current size is added to the rendered length ("≈"; the current size shows
     the rendered length itself). On a fixed-length label, or for a block in a free-layout frame,
     the label does not grow, so the buttons show the length of the text instead. Sizes under the
     2 mm readable minimum say so in words. Kept lean: it is in the initial JS. -->
<script lang="ts">
  import type { TextItem } from '../../../doc/schema'
  import { resolveDoc } from '../../../doc/variables'
  import { itemSizingBand } from '../../../render'
  import { matchQuickSize, quickReadouts, quickTextSizes } from '../../../render/text-size'
  import { dotsToMm } from '../../../render/units'
  import { getStudio } from '../../state/studio.svelte'
  import { FALLBACK_BAND_DOTS } from '../../state/text-defaults'

  let { item, variant = 'props' }: { item: TextItem; variant?: 'props' | 'compact' } = $props()
  const studio = getStudio()
  const id = $props.id()

  const band = $derived.by(() => {
    const t = studio.target
    if (t.ok) return { dots: itemSizingBand(studio.doc, item, t.target.area).bandDots, dpi: t.target.area.dpi, minMm: dotsToMm(t.target.area.minLengthDots, t.target.area.dpi) }
    return { dots: FALLBACK_BAND_DOTS[studio.doc.tape.widthMm], dpi: 180, minMm: 0 }
  })
  const sizes = $derived(quickTextSizes(band.dots, band.dpi))
  const current = $derived(matchQuickSize(item.size, band.dots, band.dpi))
  /** The label grows with the text (auto length, flow): readouts are label lengths. */
  const grows = $derived(studio.doc.length.mode === 'auto' && !(studio.doc.layout.mode === 'free' && item.frame))

  /** Readout per quick size ("≈ 31 mm"; the current size exact), once this block has rendered. */
  const readouts = $derived.by((): string[] => {
    const render = studio.render
    // The preview shows placeholders filled with the preview row: measure the same text.
    const shown = render && resolveDoc({ ...studio.doc, items: [item] }, studio.previewRow, { now: new Date() }).doc.items[0]
    return shown?.kind === 'text' && render ? quickReadouts({ shown, size: item.size, current, sizes, band, render, grows }) : []
  })
  const hint = $derived(
    `Each size shows the ${grows ? 'label length it gives' : 'length of this text'}.${sizes
      .filter((q) => q.tooSmall)
      .map((q) => ` ${q.label} is under 2 mm on this tape and may be hard to read.`)
      .join('')}`,
  )
</script>

<div class="quick {variant}">
  <span class="title" aria-hidden="true">Text size</span>
  <div class="buttons" role="group" aria-label={variant === 'compact' ? 'Text size of the selected block' : 'Quick text size'}>
    {#each sizes as q, i (q.id)}
      <button type="button" class="btn small" class:tiny={q.tooSmall} aria-pressed={current === q.id} title={q.name} aria-label={q.name} aria-describedby="{id}-{q.id}" onclick={() => studio.updateItem<TextItem>(item.id, { size: q.size })}>
        <b>{q.label}</b><span id="{id}-{q.id}">{[readouts[i], q.tooSmall && 'hard to read'].filter(Boolean).join(', ')}</span>
      </button>
    {/each}
  </div>
  <p class="hint">{hint}</p>
</div>

<style>
  .quick {
    display: grid;
    gap: var(--space-1);
  }
  .compact {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .props .title,
  .compact .hint {
    display: none;
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .buttons {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--space-1);
  }
  .compact .buttons {
    flex: 1;
    max-width: 420px;
  }
  button {
    flex-direction: column;
    gap: 0;
    min-width: 0;
    padding: 2px var(--space-1);
    line-height: 1.15;
    /* .btn is nowrap: the readout must wrap inside the button, never spill over its border. */
    white-space: normal;
    text-align: center;
  }
  button span {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    /* Wraps between words ("≈ 18" over "mm", "hard to read" on its own lines) where five buttons
       share a phone's width, instead of hiding the unit or the warning. */
    white-space: normal;
    overflow-wrap: break-word;
    max-width: 100%;
    min-height: 1.15em;
  }
  .tiny b {
    text-decoration: underline dotted;
  }
  button[aria-pressed='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  button[aria-pressed='true'] span {
    color: var(--text);
  }
</style>
