<!-- Printer models (docs/MODELS-PLAN.md §3.6; P-core-ui) — "Design for": picks the model to
     design for while no printer is connected, which is also the virtual printer's model ("No
     printer"). A native <select> (keyboard, screen readers, the iPhone's wheel). Models a browser
     can reach (USB, Bluetooth Classic) come first: "Connects from this browser", or where they do
     connect when this browser reaches no printer at all (iPhone, Safari). Bluetooth LE and
     network-only models stay selectable for designing and exporting, and the line under the
     picker says why they can't be connected. The accessible name ("Printer model") is frozen (e2e/models-entry.spec.ts). -->
<script lang="ts">
  import { getStudio } from '../state/studio.svelte'
  import { findModel, modelPickerGroups, reachNote } from '../state/models'
  import { modelOptionText } from '../connect/copy'

  let { label = 'Printer model' }: { label?: string } = $props()

  const studio = getStudio()
  const id = $props.id()
  const groups = $derived(modelPickerGroups(studio.models, studio.support.canPrint))
  const selected = $derived(findModel(studio.models, studio.designModel))
  const note = $derived(selected ? reachNote(selected) : null)
</script>

<div class="model-picker">
  <label class="field-label" for="{id}-model">{label}</label>
  <select id="{id}-model" class="select" value={studio.designModel} disabled={!studio.models.length} aria-describedby={note ? `${id}-note` : undefined} onchange={(e) => studio.setDesignModel(e.currentTarget.value)}>
    {#if !studio.models.length}<option value={studio.designModel}>{studio.designModel}</option>{/if}
    {#each groups as g (g.label)}
      <optgroup label={g.label}>
        {#each g.models as m (m.name)}<option value={m.name}>{modelOptionText(m)}</option>{/each}
      </optgroup>
    {/each}
  </select>
  {#if note}<p class="note" id="{id}-note">{note}</p>{/if}
</div>

<style>
  .model-picker {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .select {
    width: 100%;
    min-width: 0;
  }
  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
