<!-- W4 — properties of a text block. Edits go through Studio.updateItem (doc/ops.updateItem). -->
<script lang="ts">
  import type { FontFamilyId, FontWeight, TextItem } from '../../../doc/schema'
  import { FONTS, fontDef } from '../../../render'
  import Segmented from '../../common/Segmented.svelte'
  import SizeField from '../../common/SizeField.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'

  let { item }: { item: TextItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<TextItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<TextItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const WEIGHT_NAMES: Record<FontWeight, string> = { 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold' }
  const weights = $derived(fontDef(item.fontFamily).weights)

  function setFamily(fontFamily: FontFamilyId) {
    const ws = fontDef(fontFamily).weights
    const fontWeight = ws.includes(item.fontWeight) ? item.fontWeight : ws.reduce((a, b) => (Math.abs(b - item.fontWeight) < Math.abs(a - item.fontWeight) ? b : a), ws[0] ?? 400)
    set({ fontFamily, fontWeight })
  }
</script>

<div class="field">
  <label class="field-label" for="{id}-text">Text</label>
  <textarea id="{id}-text" class="textarea" rows="3" value={item.text} placeholder="Type the label text" oninput={(e) => set({ text: e.currentTarget.value }, 'text')}></textarea>
  <p class="hint">Press Enter for a new line.</p>
</div>

<div class="field-row">
  <div class="field">
    <label class="field-label" for="{id}-font">Font</label>
    <select id="{id}-font" class="select" value={item.fontFamily} onchange={(e) => setFamily(e.currentTarget.value as FontFamilyId)}>
      {#each FONTS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
    </select>
  </div>
  <div class="field">
    <label class="field-label" for="{id}-weight">Weight</label>
    <select id="{id}-weight" class="select" value={String(item.fontWeight)} onchange={(e) => set({ fontWeight: Number(e.currentTarget.value) as FontWeight })}>
      {#each weights as w (w)}<option value={String(w)}>{WEIGHT_NAMES[w]}</option>{/each}
    </select>
  </div>
</div>

<SizeField label="Text size" value={item.size} onchange={(size) => set({ size }, 'size')} maxMm={studio.doc.tape.widthMm} fixedLabel="Cap height" />

<Segmented
  label="Alignment"
  iconOnly
  options={[
    { value: 'start', label: 'Align left', icon: 'align-start' },
    { value: 'center', label: 'Align centre', icon: 'align-center' },
    { value: 'end', label: 'Align right', icon: 'align-end' },
  ]}
  value={item.align}
  onchange={(align) => set({ align })}
/>

<Slider label="Line spacing" min={1} max={2} step={0.05} value={item.lineHeight} format={(v) => `${v.toFixed(2)}×`} onchange={(lineHeight) => set({ lineHeight }, 'lineHeight')} />

<div class="toggles">
  <Switch label="Italic" checked={item.italic} onchange={(italic) => set({ italic })} />
  <Switch label="Inverted" hint="White text on a black block" checked={item.invert} onchange={(invert) => set({ invert })} />
</div>

<style>
  .toggles {
    display: grid;
    gap: var(--space-2);
  }
</style>
