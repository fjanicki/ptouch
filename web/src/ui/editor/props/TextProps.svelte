<!-- W4 — properties of a text block. Edits go through Studio.updateItem (doc/ops.updateItem).
     P4 — the Font list also offers "Your fonts" (uploaded, studio.fonts), "This computer"
     (local fonts, once listed from the font manager) and "Manage fonts…"; a custom font is
     stored as `customFont` next to the bundled `fontFamily`, which stays the fallback. -->
<script lang="ts">
  import type { FontFamilyId, FontWeight, TextItem } from '../../../doc/schema'
  import type { UserFontInfo } from '../../../doc/persist-fonts'
  import { FONTS, fontDef } from '../../../render'
  import { customFontMissing } from '../../../render/fonts'
  import { localFonts } from '../../fonts/local-fonts.svelte'
  import Icon from '../../common/Icon.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import SizeField from '../../common/SizeField.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'
  import VariableHint from '../../batch/VariableHint.svelte'

  let { item }: { item: TextItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<TextItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<TextItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const WEIGHT_NAMES: Record<FontWeight, string> = { 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold' }
  const weights = $derived(fontDef(item.fontFamily).weights)

  function setFamily(fontFamily: FontFamilyId) {
    const ws = fontDef(fontFamily).weights
    const fontWeight = ws.includes(item.fontWeight) ? item.fontWeight : ws.reduce((a, b) => (Math.abs(b - item.fontWeight) < Math.abs(a - item.fontWeight) ? b : a), ws[0] ?? 400)
    set({ fontFamily, fontWeight, customFont: undefined })
  }

  // Uploaded fonts, reloaded when the font manager changes them.
  let userFonts = $state<UserFontInfo[]>([])
  $effect(() => {
    void studio.fontsVersion
    let live = true
    studio.fonts.list().then(
      (l) => live && (userFonts = l),
      () => {},
    )
    return () => (live = false)
  })

  /** Font list value: `b:<bundled id>`, `u:<ref>`, `l:<postscript name>`. */
  const fontValue = $derived(item.customFont ? (item.customFont.kind === 'user' ? `u:${item.customFont.ref}` : `l:${item.customFont.postscriptName}`) : `b:${item.fontFamily}`)
  /** The custom font is not in the lists (opened from a share link, removed, other computer). */
  const customListed = $derived(
    !item.customFont ||
      (item.customFont.kind === 'user' ? userFonts.some((f) => f.ref === (item.customFont as { ref: string }).ref) : localFonts.fonts.some((f) => f.postscriptName === (item.customFont as { postscriptName: string }).postscriptName)),
  )
  /** The custom font could not be loaded on this device (re-checked after every render). */
  const customMissing = $derived.by(() => {
    void studio.render
    return !!item.customFont && customFontMissing(item.customFont)
  })

  function pickFont(value: string, select: HTMLSelectElement) {
    if (value === 'manage') {
      select.value = fontValue
      studio.openDialog('fonts')
      return
    }
    const rest = value.slice(2)
    if (value.startsWith('b:')) setFamily(rest as FontFamilyId)
    else if (value.startsWith('u:')) {
      const f = userFonts.find((u) => u.ref === rest)
      if (f) set({ customFont: { kind: 'user', ref: f.ref, family: f.family } })
    } else if (value.startsWith('l:')) {
      const f = localFonts.fonts.find((l) => l.postscriptName === rest)
      if (f) set({ customFont: { kind: 'local', postscriptName: f.postscriptName, family: f.name } })
    }
  }
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
    <!-- `selected` per option (not the select's value): the lists load asynchronously, and a
         stand-in option is replaced by the real one with the same value. -->
    <select id="{id}-font" class="select" aria-describedby={customMissing ? `${id}-font-missing` : undefined} onchange={(e) => pickFont(e.currentTarget.value, e.currentTarget)}>
      <optgroup label="Built in">
        {#each FONTS as f (f.id)}<option value="b:{f.id}" selected={fontValue === `b:${f.id}`}>{f.label}</option>{/each}
      </optgroup>
      {#if userFonts.length || (item.customFont?.kind === 'user' && !customListed)}
        <optgroup label="Your fonts">
          {#each userFonts as f (f.ref)}<option value="u:{f.ref}" selected={fontValue === `u:${f.ref}`}>{f.family}</option>{/each}
          {#if item.customFont?.kind === 'user' && !customListed}<option value={fontValue} selected>{item.customFont.family} (not on this device)</option>{/if}
        </optgroup>
      {/if}
      {#if localFonts.fonts.length || (item.customFont?.kind === 'local' && !customListed)}
        <optgroup label="This computer (varies by machine)">
          {#if item.customFont?.kind === 'local' && !customListed}<option value={fontValue} selected>{item.customFont.family}{customMissing ? ' (not on this device)' : ''}</option>{/if}
          {#each localFonts.fonts as f (f.postscriptName)}<option value="l:{f.postscriptName}" selected={fontValue === `l:${f.postscriptName}`}>{f.name}</option>{/each}
        </optgroup>
      {/if}
      <option value="manage">Manage fonts…</option>
    </select>
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
</style>
