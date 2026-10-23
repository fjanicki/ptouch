<!-- W4 — a Cut block (docs/CUT-PLAN.md §4): nothing to set. Says what happens here (the printer
     cuts, a cut mark is printed, or the cut is ignored), the pieces on either side and the whole
     strip, the per-piece settings, and the short-piece hint (C11, not yet checked on a printer). -->
<script lang="ts">
  import type { CutItem } from '../../../doc/schema'
  import { handPiecesMm, pageLengthsMm } from '../../../render'
  import { getStudio } from '../../state/studio.svelte'
  import { cutFate, cutNeighbours, formatMm, handPiecesText, pieceListText, piecesText, shortPieceHintFor } from '../../state/view-model'

  let { item }: { item: CutItem } = $props()
  const studio = getStudio()

  const doc = $derived(studio.doc)
  const cutter = $derived(studio.cutterFor(studio.model))
  const render = $derived(studio.render)
  const info = $derived(render?.cutItems?.find((c) => c.itemId === item.id))
  const around = $derived(render && info ? cutNeighbours(render, info) : undefined)
  const feedMm = $derived(render?.feedMarginMm ?? 2)
  const dpi = $derived(studio.target.ok ? studio.target.target.area.dpi : 180)
  const pages = $derived(render?.cuts ? pageLengthsMm(render) : [])
  const whole = $derived(render ? (render.cuts ? (pieceListText(pages, feedMm) ?? piecesText(pages, feedMm)) : render.marks ? handPiecesText(handPiecesMm(render)) : null) : null)
  const short = $derived(render ? shortPieceHintFor(render, dpi, doc.length.mode === 'fixed') : null)
  const lengthText = $derived(doc.length.mode === 'fixed' ? `${formatMm(doc.length.mm)} each` : 'auto')
  const settings = $derived.by(() => {
    const parts = [`start and end margins (${formatMm(doc.marginsMm.start)} / ${formatMm(doc.marginsMm.end)})`, `length (${lengthText})`, ...(doc.frame ? ['the frame'] : [])]
    return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  })
  /**
   * What happens at this cut, from the render (the lengths below come from it too), so the live
   * region changes once per render and never pairs a new state with old lengths. Before the first
   * render of this cut it follows the document (`cutFate`: ignored when no printed block follows
   * it, as after the usual insert at the end) and the settings, which the render then confirms (no
   * change, so a newly inserted cut is not announced twice: Studio.insertCut announces it).
   */
  const how = $derived(info?.how ?? (cutFate(doc, item.id, render?.boxes) !== 'kept' ? 'ignored' : !cutter || !doc.print.autoCut ? 'mark' : 'printer'))
  const stateText = $derived(
    how === 'ignored'
      ? 'This cut is ignored, so the strip is not cut here.'
      : how === 'printer'
        ? 'The printer cuts here.'
        : cutter
          ? 'Cut each is off: the strip won’t be cut. A cut mark is printed here instead.'
          : 'This printer has no cutter: a cut mark (short ticks at both tape edges) is printed here. Cut the strip with scissors.',
  )

  // The button goes away once Cut each is on: keep keyboard focus nearby, on the line that
  // follows it. The status line announces the new state once the strip has been redrawn.
  let afterEl: HTMLParagraphElement | undefined = $state()
  function turnOnCutEach(): void {
    afterEl?.focus()
    studio.updateDoc({ print: { ...doc.print, autoCut: true } })
  }
</script>

<div class="status">
  <p role="status" class:strong={how === 'printer'}>{stateText}</p>
  {#if around}
    <p class="hint">
      Piece before: about {formatMm(around.before)} · piece after: about {formatMm(around.after)}{info?.how === 'printer' ? ` (each with the printer’s ${formatMm(feedMm)} feed at both ends)` : ''}.
    </p>
  {/if}
</div>
{#if cutter && !doc.print.autoCut}
  <button type="button" class="btn turn-on" onclick={turnOnCutEach}>Turn on Cut each</button>
{/if}

<p class="hint" tabindex="-1" bind:this={afterEl}>
  Each piece is laid out like a label on its own: {settings} apply to every piece.
</p>
{#if whole}<p class="hint whole">{whole}.</p>{/if}
{#if short}<p class="hint short" role="note">{short}</p>{/if}

<style>
  .status {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-m);
    background: var(--surface-2);
    font-size: 13px;
  }
  .status p {
    margin: 0;
  }
  .strong {
    font-weight: 700;
  }
  .turn-on {
    justify-self: start;
  }
  .hint {
    margin: 0;
  }
  @media (pointer: coarse) {
    .turn-on {
      min-height: 44px;
    }
  }
</style>
