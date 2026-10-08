<!-- W4 — properties of a shape block (rectangle, ellipse, line). -->
<script lang="ts">
  import type { ShapeItem } from '../../../doc/schema'
  import NumberField from '../../common/NumberField.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import SizeField from '../../common/SizeField.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'

  let { item }: { item: ShapeItem } = $props()
  const studio = getStudio()
  const set = (patch: Partial<Omit<ShapeItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<ShapeItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)
</script>

<Segmented
  label="Shape"
  options={[
    { value: 'rect', label: 'Box', icon: 'square' },
    { value: 'ellipse', label: 'Ellipse', icon: 'circle' },
    { value: 'line', label: 'Line', icon: 'line' },
  ]}
  value={item.shape}
  onchange={(shape) => set({ shape })}
/>
<div class="field-row">
  <NumberField label="Length" unit="mm" min={0.5} max={500} step={0.5} value={item.widthMm} onchange={(widthMm) => set({ widthMm }, 'width')} />
  <NumberField label="Stroke" unit="mm" min={0.1} max={10} step={0.1} value={item.strokeMm} onchange={(strokeMm) => set({ strokeMm }, 'stroke')} />
</div>
{#if item.shape !== 'line'}
  <SizeField label="Height" value={item.size} onchange={(size) => set({ size }, 'size')} maxMm={studio.doc.tape.widthMm} />
  <Switch label="Filled" checked={item.fill} onchange={(fill) => set({ fill })} />
{/if}
