<!-- W4 — properties of a code block (QR / Code 128 / EAN-13). Codes are encoded in wasm
     (render/codes.ts); this editor only validates input shape for friendly hints. -->
<script lang="ts">
  import type { CodeItem, QrEcc, Symbology } from '../../../doc/schema'
  import { codeMatrix, dotsToMm, maxModuleDots, tapeMarginDots } from '../../../render'
  import NumberField from '../../common/NumberField.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'

  let { item }: { item: CodeItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<CodeItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<CodeItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const band = $derived(studio.target.ok ? studio.target.target.area.heightDots : 128)
  const dpi = $derived(studio.target.ok ? studio.target.target.area.dpi : 180)
  // Same rule as the renderer: unprinted tape counts as quiet zone unless a frame borders the band.
  const marginDots = $derived(studio.target.ok && !studio.doc.frame && !(studio.doc.layout.mode === 'free' && item.frame) ? tapeMarginDots(studio.target.target.area) : 0)
  const matrix = $derived.by(() => {
    if (studio.wasm !== 'ready' || !item.data) return null
    try {
      return codeMatrix(item)
    } catch {
      return null
    }
  })
  const maxModule = $derived.by(() => {
    if (!matrix) return 12
    if (matrix.height <= 1) return 8 // linear codes: the label length is the limit, not the band
    try {
      return Math.max(1, maxModuleDots(matrix, band, item.quietZone, marginDots))
    } catch {
      return 12
    }
  })
  const widthMm = $derived(matrix ? dotsToMm(matrix.width * item.moduleDots, dpi) : null)

  const dataHint = $derived.by((): { text: string; tone: '' | 'error' } => {
    const d = item.data
    if (item.symbology === 'ean13') {
      if (!/^\d*$/.test(d)) return { text: 'EAN-13 takes digits only.', tone: 'error' }
      if (d.length !== 12 && d.length !== 13) return { text: `Enter 12 digits (the check digit is added) or 13. Now: ${d.length}.`, tone: 'error' }
      return { text: d.length === 12 ? 'The check digit is added automatically.' : '13 digits including the check digit.', tone: '' }
    }
    if (item.symbology === 'code128') {
      // eslint-disable-next-line no-control-regex
      if (!/^[\x00-\x7f]*$/.test(d)) return { text: 'Code 128 supports plain ASCII characters only.', tone: 'error' }
      return { text: 'Letters, digits and symbols. Short is better on narrow tape.', tone: '' }
    }
    return { text: `${new TextEncoder().encode(d).length} bytes. URLs, Wi-Fi codes and plain text all work.`, tone: '' }
  })

  function setSymbology(symbology: Symbology) {
    if (symbology === item.symbology) return
    const patch: Partial<CodeItem> = { symbology, showText: symbology !== 'qr' }
    if (symbology === 'ean13' && !/^\d{12,13}$/.test(item.data)) patch.data = '400638133393'
    if (symbology !== 'qr' && item.moduleDots > 3) patch.moduleDots = 2
    set(patch)
  }
  const ECC: { value: QrEcc; label: string }[] = [
    { value: 'L', label: 'Low (7 %)' },
    { value: 'M', label: 'Medium (15 %)' },
    { value: 'Q', label: 'Quartile (25 %)' },
    { value: 'H', label: 'High (30 %)' },
  ]
</script>

<Segmented
  label="Code type"
  options={[
    { value: 'qr', label: 'QR' },
    { value: 'code128', label: 'Code 128' },
    { value: 'ean13', label: 'EAN-13' },
  ]}
  value={item.symbology}
  onchange={setSymbology}
/>

<div class="field">
  <label class="field-label" for="{id}-data">{item.symbology === 'qr' ? 'Content' : 'Data'}</label>
  {#if item.symbology === 'qr'}
    <textarea id="{id}-data" class="textarea" rows="2" value={item.data} aria-describedby="{id}-data-hint" aria-invalid={dataHint.tone === 'error'} oninput={(e) => set({ data: e.currentTarget.value }, 'data')}></textarea>
  {:else}
    <input
      id="{id}-data"
      class="input"
      value={item.data}
      inputmode={item.symbology === 'ean13' ? 'numeric' : 'text'}
      aria-describedby="{id}-data-hint"
      aria-invalid={dataHint.tone === 'error'}
      oninput={(e) => set({ data: e.currentTarget.value }, 'data')}
    />
  {/if}
  <p class="hint {dataHint.tone}" id="{id}-data-hint">{dataHint.text}</p>
</div>

<NumberField
  label="Module size"
  unit="dots"
  min={1}
  max={maxModule}
  step={1}
  value={item.moduleDots}
  onchange={(moduleDots) => set({ moduleDots: Math.round(moduleDots) }, 'module')}
  hint={[widthMm ? `Code is about ${widthMm.toFixed(1)} mm long.` : '', matrix && matrix.height > 1 ? `Up to ${maxModule} dots fit this tape.` : 'Wider bars scan more reliably.'].filter(Boolean).join(' ')}
/>

{#if item.symbology === 'qr'}
  <div class="field">
    <label class="field-label" for="{id}-ecc">Error correction</label>
    <select id="{id}-ecc" class="select" value={item.ecc} onchange={(e) => set({ ecc: e.currentTarget.value as QrEcc })}>
      {#each ECC as e (e.value)}<option value={e.value}>{e.label}</option>{/each}
    </select>
  </div>
{/if}

<div class="toggles">
  <Switch label="Quiet zone" hint="Blank margin scanners need around the code" checked={item.quietZone} onchange={(quietZone) => set({ quietZone })} />
  {#if item.symbology !== 'qr'}
    <Switch label="Show text" hint="Print the data under the bars" checked={item.showText} onchange={(showText) => set({ showText })} />
  {/if}
</div>

<style>
  .toggles {
    display: grid;
    gap: var(--space-2);
  }
</style>
