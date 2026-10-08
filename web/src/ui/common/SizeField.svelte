<!-- W4 — ItemSize editor: "Fit to tape" or a fixed height in mm. -->
<script lang="ts">
  import type { ItemSize } from '../../doc/schema'
  import Segmented from './Segmented.svelte'
  import NumberField from './NumberField.svelte'

  let { label = 'Size', value, onchange, maxMm = 24, fixedLabel = 'Height' }: { label?: string; value: ItemSize; onchange: (v: ItemSize) => void; maxMm?: number; fixedLabel?: string } = $props()
  let lastMm = $state(6)
  $effect(() => {
    if (value.mode === 'mm') lastMm = value.mm
  })
</script>

<div class="size">
  <Segmented
    {label}
    options={[
      { value: 'fit', label: 'Fit tape' },
      { value: 'mm', label: 'Fixed' },
    ]}
    value={value.mode}
    onchange={(m) => onchange(m === 'fit' ? { mode: 'fit' } : { mode: 'mm', mm: Math.min(lastMm, maxMm) })}
  />
  {#if value.mode === 'mm'}
    <NumberField label={fixedLabel} unit="mm" min={0.5} max={maxMm} step={0.5} value={value.mm} onchange={(mm) => onchange({ mode: 'mm', mm })} />
  {/if}
</div>

<style>
  .size {
    display: grid;
    gap: var(--space-2);
  }
</style>
