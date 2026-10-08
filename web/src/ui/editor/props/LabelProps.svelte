<!-- W4 — label-level settings: flow gap/alignment, frame, threshold ("boldness"). Margins and
     length live in the media bar; copies/cut/chain/mirror in the print bar. -->
<script lang="ts">
  import type { Align } from '../../../doc/schema'
  import NumberField from '../../common/NumberField.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'

  const studio = getStudio()
  const doc = $derived(studio.doc)
  const layout = $derived(doc.layout)
  const DEFAULT_FRAME = { thicknessMm: 0.5, radiusMm: 1, insetMm: 0.5 }

  function boldnessText(v: number): string {
    const step = Math.round((v - 128) / 16)
    return step === 0 ? 'Normal' : step > 0 ? `Bolder +${step}` : `Lighter ${step}`
  }
</script>

{#if layout.mode === 'flow'}
  <NumberField label="Gap between blocks" unit="mm" min={0} max={50} step={0.5} value={layout.gapMm} onchange={(gapMm) => studio.updateDoc({ layout: { ...layout, gapMm } }, 'doc:gap')} />
  <Segmented
    label="Vertical alignment"
    iconOnly
    options={[
      { value: 'start' as Align, label: 'Top', icon: 'valign-start' },
      { value: 'center' as Align, label: 'Middle', icon: 'valign-center' },
      { value: 'end' as Align, label: 'Bottom', icon: 'valign-end' },
    ]}
    value={layout.align}
    onchange={(align) => studio.updateDoc({ layout: { ...layout, align } })}
  />
{:else}
  <p class="hint">This label uses free placement (made with a newer editor). Blocks keep their saved positions.</p>
{/if}

<Slider
  label="Boldness"
  min={32}
  max={224}
  step={16}
  value={256 - doc.print.threshold}
  format={boldnessText}
  hint="Thickens or thins text and lines at 180 dpi."
  onchange={(v) => studio.updateDoc({ print: { ...doc.print, threshold: 256 - v } }, 'doc:threshold')}
/>

<Switch label="Frame" hint="Border around the whole label" checked={!!doc.frame} onchange={(on) => studio.updateDoc({ frame: on ? DEFAULT_FRAME : undefined })} />
{#if doc.frame}
  {@const frame = doc.frame}
  <div class="field-row three">
    <NumberField label="Line" unit="mm" min={0.1} max={3} step={0.1} value={frame.thicknessMm} onchange={(thicknessMm) => studio.updateDoc({ frame: { ...frame, thicknessMm } }, 'doc:frame-t')} />
    <NumberField label="Corners" unit="mm" min={0} max={10} step={0.5} value={frame.radiusMm} onchange={(radiusMm) => studio.updateDoc({ frame: { ...frame, radiusMm } }, 'doc:frame-r')} />
    <NumberField label="Inset" unit="mm" min={0} max={5} step={0.1} value={frame.insetMm} onchange={(insetMm) => studio.updateDoc({ frame: { ...frame, insetMm } }, 'doc:frame-i')} />
  </div>
{/if}

<style>
  .three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
</style>
