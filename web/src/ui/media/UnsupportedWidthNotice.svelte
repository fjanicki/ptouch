<!-- Printer models (docs/MODELS-PLAN.md §3.4; P-core-ui) — the label's tape width is not one the
     active model takes. Nothing changes on its own: the label keeps its width (the preview renders
     it with a stand-in model), Print is blocked, and this notice offers "Fit to 24 mm" (one undo
     step) and, while designing without a printer, "Design for PT-P910BT" when the model the label
     was made for takes the width. The alert text and "Fit to …" name are frozen
     (e2e/models-entry.spec.ts). -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import { findModel, type WidthUnsupported } from '../state/models'
  import { getStudio } from '../state/studio.svelte'
  import { formatMm } from '../state/view-model'

  /** `onfit`: after either action (the notice, and the pressed button with it, goes away): the
   * media bar moves keyboard focus to the tape width now checked. */
  let { support, onfit }: { support: WidthUnsupported; onfit?: () => void } = $props()

  const studio = getStudio()
  // The model the label was made for (tape.model), when it takes the width and only the "Design
  // for" pick stands in the way (a connected printer always wins).
  const madeFor = $derived.by(() => {
    if (studio.modelSource !== 'design' || !support.standIn) return null
    const info = findModel(studio.models, studio.doc.tape.model)
    return info && info.name === support.standIn && info.name !== support.model ? info.name : null
  })

  function fit() {
    studio.fitToModel()
    onfit?.()
  }

  function designFor(model: string) {
    studio.setDesignModel(model)
    studio.announce(`Designing for ${model}`)
    onfit?.()
  }
</script>

<div class="unsupported" role="alert">
  <Icon name="alert" size={20} />
  <p>
    <strong>{support.message}</strong>
    The label keeps its width until you change it; it can’t be printed on the {support.model}.
  </p>
  <div class="actions">
    {#if madeFor}
      <button type="button" class="btn small" onclick={() => designFor(madeFor)}>Design for {madeFor}</button>
    {/if}
    <button type="button" class="btn small primary" onclick={fit}>Fit to {formatMm(support.nearest)}</button>
  </div>
</div>

<style>
  .unsupported {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-4);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border));
    border-left: 4px solid var(--warn);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
    color: var(--text);
  }
  .unsupported :global(svg) {
    color: var(--warn);
  }
  p {
    flex: 1;
    margin: 0;
    min-width: 200px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
