<!-- W4 — properties of a text block. Edits go through Studio.updateItem (doc/ops.updateItem).
     P4 — a custom font is stored as `customFont` next to the bundled `fontFamily`, which stays
     the fallback. Fonts and size (docs/FONTS-AND-SIZE-PLAN.md): the font control is
     ui/fonts/FontPicker (P-picker), the quick sizes ui/editor/props/TextSizeQuick (P-size). -->
<script lang="ts">
  import type { FontWeight, TextItem } from '../../../doc/schema'
  import { fontDef, itemSizingBand } from '../../../render'
  import { customFontMissing } from '../../../render/fonts'
  import FontPicker from '../../fonts/FontPicker.svelte'
  import Icon from '../../common/Icon.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import SizeField from '../../common/SizeField.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'
  import VariableHint from '../../batch/VariableHint.svelte'
  import TextSizeQuick from './TextSizeQuick.svelte'
  import { defaultSizeOf, measureTextAt } from '../../../render/text-size'
  import { FALLBACK_BAND_DOTS } from '../../state/text-defaults'

  let { item }: { item: TextItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<TextItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<TextItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const WEIGHT_NAMES: Record<FontWeight, string> = { 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold' }
  const weights = $derived(fontDef(item.fontFamily).weights)

  /** Size of new text blocks (prefs.defaultTextSize, applied by the Studio): a word or {pt}. */
  const newSize = $derived(studio.prefs.defaultTextSize)
  /** "Use for new text": Fit, M and S stay relative to the next label's tape; any other size is
   * stored as its point size (render/text-size.ts `defaultSizeOf`). */
  function useForNew(): void {
    const t = studio.target
    const band = t.ok ? itemSizingBand(studio.doc, item, t.target.area).bandDots : FALLBACK_BAND_DOTS[studio.doc.tape.widthMm]
    const dpi = t.ok ? t.target.area.dpi : 180
    studio.updatePrefs({ defaultTextSize: defaultSizeOf(item.size, band, dpi, measureTextAt(item, item.size, band, dpi).emDots) })
    studio.announce('New text blocks will get this size')
  }

  /** The custom font could not be loaded on this device (re-checked after every render). */
  const customMissing = $derived.by(() => {
    void studio.render
    return !!item.customFont && customFontMissing(item.customFont)
  })
</script>

<div class="field">
  <label class="field-label" for="{id}-text">Text</label>
  <textarea id="{id}-text" class="textarea" rows="3" value={item.text} placeholder="Type the label text" oninput={(e) => set({ text: e.currentTarget.value }, 'text')}></textarea>
  <p class="hint">Press Enter for a new line.</p>
  <VariableHint text={item.text} />
</div>

<div class="field-row">
  <div class="field">
    <label class="field-label" for="{id}-font">Font</label>
    <FontPicker {item} id="{id}-font" describedby={customMissing ? `${id}-font-missing` : undefined} onchange={(patch) => set(patch)} />
  </div>
  <div class="field">
    {#if item.customFont && !customMissing}
      <span class="field-label">Weight</span>
      <p class="hint fixed">From the font file</p>
    {:else}
      <label class="field-label" for="{id}-weight">Weight</label>
      <select id="{id}-weight" class="select" value={String(item.fontWeight)} onchange={(e) => set({ fontWeight: Number(e.currentTarget.value) as FontWeight })}>
        {#each weights as w (w)}<option value={String(w)}>{WEIGHT_NAMES[w]}</option>{/each}
      </select>
    {/if}
  </div>
</div>
{#if item.customFont && customMissing}
  <div class="missing" id="{id}-font-missing" role="note">
    <Icon name="alert" size={16} />
    <p>“{item.customFont.family}” is not on this device — using {fontDef(item.fontFamily).label}.</p>
    <button type="button" class="btn small" onclick={() => studio.openDialog('fonts')}>Choose font…</button>
  </div>
{/if}

<TextSizeQuick {item} />
<SizeField label="Text size" value={item.size} onchange={(size) => set({ size }, 'size')} maxMm={studio.doc.tape.widthMm} fixedLabel="Cap height" allowPt />
<div class="new-size">
  <div class="field">
    <label class="field-label" for="{id}-new-size">Size of new text</label>
    <select id="{id}-new-size" class="select" value={typeof newSize === 'object' ? 'pt' : newSize} onchange={(e) => e.currentTarget.value !== 'pt' && studio.updatePrefs({ defaultTextSize: e.currentTarget.value as 'auto' })}>
      <option value="auto">Auto: Fit below 12 mm, else M</option>
      <option value="fit">Fit tape</option>
      <option value="half">Half height (M)</option>
      <option value="third">Third (S)</option>
      <option value="pt" hidden={typeof newSize !== 'object'}>{typeof newSize === 'object' ? newSize.pt : 12} pt</option>
    </select>
  </div>
  <button type="button" class="btn" onclick={useForNew}>Use for new text</button>
</div>

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
  .fixed {
    margin: 0;
    min-height: 36px;
    display: flex;
    align-items: center;
  }
  .missing {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
    color: var(--text);
    font-size: 13px;
  }
  .missing p {
    flex: 1;
    min-width: 12em;
    margin: 0;
  }
  .missing :global(svg) {
    flex: none;
    color: var(--warn);
  }
  .toggles {
    display: grid;
    gap: var(--space-2);
  }
  .new-size {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2);
  }
  /* The select gets the whole width (its options explain themselves); the button goes below. */
  .new-size .field {
    flex: 1 1 100%;
    min-width: 0;
  }
</style>
