<!-- W4 — ItemSize editor: "Fit to tape" or a fixed height in mm. Text blocks (`allowPt`, schema 3,
     docs/FONTS-AND-SIZE-PLAN.md) also offer a font size in points. P-size owns the text sizing UI
     around it (TextSizeQuick); keep the existing "Fit tape" / "Fixed" names for the other blocks. -->
<script lang="ts" generics="T extends TextSize">
  import { LIMITS, type TextSize } from '../../doc/schema'
  import Segmented from './Segmented.svelte'
  import NumberField from './NumberField.svelte'

  let {
    label = 'Size',
    value,
    onchange,
    maxMm = 24,
    fixedLabel = 'Height',
    allowPt = false,
  }: { label?: string; value: T; onchange: (v: T) => void; maxMm?: number; fixedLabel?: string; allowPt?: boolean } = $props()
  let lastMm = $state(6)
  let lastPt = $state(12)
  $effect(() => {
    if (value.mode === 'mm') lastMm = value.mm
    if (value.mode === 'pt') lastPt = value.pt
  })
  const options = $derived([
    { value: 'fit', label: 'Fit tape' },
    { value: 'mm', label: 'Fixed' },
    ...(allowPt ? [{ value: 'pt', label: 'Points' }] : []),
  ])
  function pick(mode: string) {
    const v: TextSize = mode === 'fit' ? { mode: 'fit' } : mode === 'pt' ? { mode: 'pt', pt: lastPt } : { mode: 'mm', mm: Math.min(lastMm, maxMm) }
    onchange(v as T)
  }
</script>

<div class="size">
  <Segmented {label} {options} value={value.mode} onchange={pick} />
  {#if value.mode === 'mm'}
    <NumberField label={fixedLabel} unit="mm" min={0.5} max={maxMm} step={0.5} value={value.mm} onchange={(mm) => onchange({ mode: 'mm', mm } as T)} />
  {:else if value.mode === 'pt'}
    <NumberField label="Font size" unit="pt" min={LIMITS.sizePt.min} max={LIMITS.sizePt.max} step={0.5} value={value.pt} onchange={(pt) => onchange({ mode: 'pt', pt } as T)} />
  {/if}
</div>

<style>
  .size {
    display: grid;
    gap: var(--space-2);
  }
</style>
