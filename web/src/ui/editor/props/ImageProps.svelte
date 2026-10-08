<!-- W4 — properties of an image block: source (W5 blob store), dithering and tone adjustments
     (applied in wasm by Raster.blitTone), size. -->
<script lang="ts">
  import type { DitherKind, ImageItem } from '../../../doc/schema'
  import Icon from '../../common/Icon.svelte'
  import SizeField from '../../common/SizeField.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { errorMessage, getStudio } from '../../state/studio.svelte'

  let { item }: { item: ImageItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  let fileInput: HTMLInputElement | undefined = $state()
  let thumb = $state<string | null>(null)

  const set = (patch: Partial<Omit<ImageItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<ImageItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)
  const setAdjust = (patch: Partial<ImageItem['adjust']>, key: string) => set({ adjust: { ...item.adjust, ...patch } }, key)

  $effect(() => {
    const ref = item.blobRef
    const inline = item.dataUrl
    let url: string | null = null
    let cancelled = false
    if (inline) thumb = inline
    else if (ref) {
      studio.store
        .getBlob(ref)
        .then((b) => {
          if (cancelled || !b) return
          url = URL.createObjectURL(b)
          thumb = url
        })
        .catch(() => {})
    } else thumb = null
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  })

  async function onfile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    try {
      const blobRef = await studio.store.putBlob(file)
      set({ blobRef })
    } catch (err) {
      studio.toast('error', 'Could not use this image', errorMessage(err))
    }
  }

  const DITHER: { value: DitherKind; label: string }[] = [
    { value: 'threshold', label: 'Threshold (line art, logos)' },
    { value: 'floyd-steinberg', label: 'Floyd–Steinberg (photos)' },
    { value: 'atkinson', label: 'Atkinson (high contrast)' },
    { value: 'bayer4', label: 'Ordered 4×4 (pattern)' },
    { value: 'bayer8', label: 'Ordered 8×8 (fine pattern)' },
  ]
</script>

<div class="source">
  <span class="thumb">
    {#if thumb}<img src={thumb} alt="Selected" />{:else}<Icon name="image" size={24} />{/if}
  </span>
  <button type="button" class="btn small" onclick={() => fileInput?.click()}><Icon name="upload" size={16} />{item.blobRef || item.dataUrl ? 'Replace image…' : 'Choose image…'}</button>
  <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={onfile} />
</div>

<div class="field">
  <label class="field-label" for="{id}-dither">Dithering</label>
  <select id="{id}-dither" class="select" value={item.dither} onchange={(e) => set({ dither: e.currentTarget.value as DitherKind })}>
    {#each DITHER as d (d.value)}<option value={d.value}>{d.label}</option>{/each}
  </select>
</div>

{#if item.dither === 'threshold'}
  <Slider label="Threshold" min={0} max={255} value={item.adjust.level} onchange={(level) => setAdjust({ level }, 'level')} />
{/if}
<Slider label="Brightness" min={-100} max={100} value={item.adjust.brightness} format={(v) => (v > 0 ? `+${v}` : String(v))} onchange={(brightness) => setAdjust({ brightness }, 'brightness')} />
<Slider label="Contrast" min={-100} max={100} value={item.adjust.contrast} format={(v) => (v > 0 ? `+${v}` : String(v))} onchange={(contrast) => setAdjust({ contrast }, 'contrast')} />
<Slider label="Gamma" min={30} max={300} step={5} value={item.adjust.gammaX100} format={(v) => (v / 100).toFixed(2)} onchange={(gammaX100) => setAdjust({ gammaX100 }, 'gamma')} />
<Switch label="Invert" checked={item.adjust.invert} onchange={(invert) => setAdjust({ invert }, 'invert')} />

<SizeField label="Image size" value={item.size} onchange={(size) => set({ size }, 'size')} maxMm={studio.doc.tape.widthMm} />

<style>
  .source {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 64px;
    height: 48px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface-2);
    color: var(--text-muted);
    overflow: hidden;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
