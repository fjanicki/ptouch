<!-- W4 — tape width (auto from status, manual offline), tape/ink colours, length auto/fixed,
     margins; mismatch preflight with one-click "Use loaded 12 mm tape".
     Printer models (docs/MODELS-PLAN.md §3.4–§3.7; P-core-ui): the widths are the active model's,
     "Printer model" (Design for) while no printer is connected, the connected printer's model
     otherwise; the unsupported-width notice with "Fit to 24 mm" replaces the mismatch banner, and
     a real printer of an untested model gets a dismissible note (loaded on demand). -->
<script lang="ts">
  import { tick } from 'svelte'
  import type { TapeWidthMm } from '../../doc/schema'
  import Icon from '../common/Icon.svelte'
  import NumberField from '../common/NumberField.svelte'
  import Segmented from '../common/Segmented.svelte'
  import { getStudio } from '../state/studio.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import UnsupportedWidthNotice from './UnsupportedWidthNotice.svelte'
  import { connectedModelText } from '../connect/copy'
  import { DEFAULT_COLORS, TAPE_PRESETS, capitalize, formatMm, pieceLengthHint, previewColors } from '../state/view-model'

  const studio = getStudio()
  const doc = $derived(studio.doc)
  const loaded = $derived(studio.conn.media)
  const colors = $derived(previewColors(studio.conn, doc))
  const presetId = $derived(
    TAPE_PRESETS.find((p) => p.tape === (doc.tape.colors ?? DEFAULT_COLORS).tape && p.ink === (doc.tape.colors ?? DEFAULT_COLORS).ink)?.id ?? 'custom',
  )
  const widthOptions = $derived(
    studio.tapeWidths.map((w) => ({ value: w, label: loaded && Math.abs(loaded.widthMm - w) < 0.01 ? `${w} •` : String(w) })),
  )
  const support = $derived(studio.widthSupport)
  /** The label has a kept Cut block: a fixed length is the length of each piece (docs/CUT-PLAN.md C7). */
  const pieced = $derived(!!studio.render?.cutItems?.some((c) => c.how !== 'ignored'))
  const maxLen = $derived(studio.target.ok && studio.target.target.area.maxLengthDots ? Math.floor((studio.target.target.area.maxLengthDots * 25.4) / studio.target.target.area.dpi) : 999)

  // After "Fit to …" or "Dismiss" the pressed button is gone: keep keyboard focus nearby, on the
  // tape width now checked.
  let widthEl: HTMLDivElement | undefined = $state()
  function focusWidth() {
    void tick().then(() => widthEl?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus())
  }
  const loadUntested = () => import('./UntestedModelNotice.svelte')

  function setPreset(id: string) {
    const p = TAPE_PRESETS.find((x) => x.id === id)
    if (p) studio.updateDoc({ tape: { ...doc.tape, colors: { tape: p.tape, ink: p.ink } } })
  }
</script>

<section class="mediabar panel" aria-label="Tape and length">
  <div class="group width" bind:this={widthEl}>
    <Segmented label="Tape width (mm)" options={widthOptions} value={doc.tape.widthMm} onchange={(w: TapeWidthMm) => studio.setTapeWidth(w)} size="small" />
    {#if loaded}
      <p class="hint">• loaded in the printer: {formatMm(loaded.widthMm)}</p>
    {/if}
  </div>

  {#if studio.modelSource === 'design'}
    <div class="group model"><ModelPicker /></div>
  {:else}
    <div class="group model">
      <span class="field-label">Designing for</span>
      <span class="model-name">{connectedModelText(studio.model, studio.conn.transport?.kind)}</span>
    </div>
  {/if}

  <div class="group colours">
    {#if colors.fromPrinter}
      <span class="field-label">Colours</span>
      <span class="from-printer" title="Reported by the printer">
        <span class="swatch" style:background={colors.tape} style:color={colors.ink} aria-hidden="true">Aa</span>
        {capitalize(`${studio.conn.status?.textColor.name} on ${studio.conn.status?.tapeColor.name}`)}
      </span>
    {:else}
      <label class="field-label" for="tape-colours">Colours</label>
      <div class="colour-select">
        <span class="swatch" style:background={colors.tape} style:color={colors.ink} aria-hidden="true">Aa</span>
        <select id="tape-colours" class="select" value={presetId} onchange={(e) => setPreset(e.currentTarget.value)}>
          {#if presetId === 'custom'}<option value="custom">Custom</option>{/if}
          {#each TAPE_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
        </select>
      </div>
    {/if}
  </div>

  <div class="group length">
    <Segmented
      label="Length"
      size="small"
      options={[
        { value: 'auto', label: 'Auto' },
        { value: 'fixed', label: 'Fixed' },
      ]}
      value={doc.length.mode}
      onchange={(m) =>
        studio.updateDoc({ length: m === 'auto' ? { mode: 'auto' } : { mode: 'fixed', mm: Math.max(10, Math.round(studio.render?.lengthMm ?? 50)) } })}
    />
    {#if doc.length.mode === 'fixed'}
      <!-- The printer feeds ~2 mm before and after the printed part: say so, so "50 mm" isn't a
           surprise when the cut label measures 54 mm. -->
      <NumberField label={pieced ? 'Length of each piece' : 'Printed length'} unit="mm" min={5} max={maxLen} step={1} value={doc.length.mm} onchange={(mm) => studio.updateDoc({ length: { mode: 'fixed', mm, ...(doc.length.mode === 'fixed' && doc.length.shrink ? { shrink: true } : {}) } }, 'doc:length')} />
      {#if studio.render}
        <p class="length-hint">{(pieced && pieceLengthHint(studio.render, doc.length.mm)) || `Cut label ≈ ${formatMm(doc.length.mm + 2 * studio.render.feedMarginMm)} with the printer’s feed`}</p>
      {/if}
    {/if}
  </div>

  <div class="group margins">
    <NumberField label="Start margin" unit="mm" min={0} max={50} step={0.5} value={doc.marginsMm.start} onchange={(v) => studio.updateDoc({ marginsMm: { ...doc.marginsMm, start: v } }, 'doc:margin-start')} />
    <NumberField label="End margin" unit="mm" min={0} max={50} step={0.5} value={doc.marginsMm.end} onchange={(v) => studio.updateDoc({ marginsMm: { ...doc.marginsMm, end: v } }, 'doc:margin-end')} />
  </div>
</section>

{#if !support.ok}
  <UnsupportedWidthNotice {support} onfit={focusWidth} />
{:else if studio.mismatch}
  {@const m = studio.mismatch}
  <div class="mismatch" role="alert">
    <Icon name="alert" size={20} />
    <p>
      <strong>Tape mismatch.</strong> This label is designed for {formatMm(m.designMm)} tape, but the printer has {formatMm(m.loadedMm)} loaded.
    </p>
    <button type="button" class="btn small primary" onclick={() => studio.useLoadedTape()}>Use loaded {formatMm(m.loadedMm)} tape</button>
  </div>
{/if}

{#if studio.untestedModel}
  {#await loadUntested() then { default: UntestedModelNotice }}
    <UntestedModelNotice model={studio.untestedModel} ondismiss={focusWidth} />
  {/await}
{/if}

<style>
  .mediabar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-3) var(--space-5);
    padding: var(--space-3) var(--space-4);
  }
  .group {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .width {
    flex: 1 1 260px;
    max-width: 340px;
  }
  /* Colours, length and margins may narrow a little (to their max otherwise) so that, next to the
     model picker, the bar keeps two rows on 1024–1400 px laptops. */
  .colours {
    flex: 1 1 170px;
    max-width: 200px;
  }
  .model {
    /* Room for the longest option ("PT-P710BT · up to 24 mm · tested") without clipping. */
    flex: 0 1 264px;
  }
  .model-name {
    display: flex;
    align-items: center;
    min-height: 34px;
    font-weight: 600;
  }
  .length {
    flex: 1 1 170px;
    max-width: 220px;
    grid-template-columns: 1fr;
  }
  .length-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .margins {
    flex: 1 1 200px;
    max-width: 230px;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }
  .colour-select {
    position: relative;
    display: flex;
    align-items: center;
  }
  .colour-select .swatch {
    position: absolute;
    left: 6px;
    pointer-events: none;
  }
  .colour-select .select {
    padding-left: 42px;
  }
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    font: 700 11px/1 var(--font-ui);
  }
  .from-printer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 34px;
  }
  /* Phones: up to seven widths (3.5–36 mm on the 360 dpi models) keep 44 px touch targets at
     360 px, with a little less padding around them. */
  @media (max-width: 420px) {
    .mediabar {
      padding-inline: var(--space-2);
    }
    .width,
    .model {
      flex-basis: 100%;
      max-width: none;
    }
    .width :global(.seg) {
      gap: 0;
    }
  }
  .mismatch {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-4);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border));
    border-left: 4px solid var(--warn);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
    color: var(--text);
  }
  .mismatch :global(svg) {
    color: var(--warn);
  }
  .mismatch p {
    flex: 1;
    margin: 0;
    min-width: 200px;
  }
</style>
