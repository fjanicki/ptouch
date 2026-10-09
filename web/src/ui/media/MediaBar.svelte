<!-- W4 — tape width (auto from status, manual offline), tape/ink colours, length auto/fixed,
     margins; mismatch preflight with one-click "Use loaded 12 mm tape". -->
<script lang="ts">
  import { TAPE_WIDTHS_MM, type TapeWidthMm } from '../../doc/schema'
  import Icon from '../common/Icon.svelte'
  import NumberField from '../common/NumberField.svelte'
  import Segmented from '../common/Segmented.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { DEFAULT_COLORS, TAPE_PRESETS, capitalize, formatMm, previewColors } from '../state/view-model'

  const studio = getStudio()
  const doc = $derived(studio.doc)
  const loaded = $derived(studio.conn.media)
  const colors = $derived(previewColors(studio.conn, doc))
  const presetId = $derived(
    TAPE_PRESETS.find((p) => p.tape === (doc.tape.colors ?? DEFAULT_COLORS).tape && p.ink === (doc.tape.colors ?? DEFAULT_COLORS).ink)?.id ?? 'custom',
  )
  const widthOptions = $derived(
    TAPE_WIDTHS_MM.map((w) => ({ value: w, label: loaded && Math.abs(loaded.widthMm - w) < 0.01 ? `${w} •` : String(w) })),
  )
  const maxLen = $derived(studio.target.ok && studio.target.target.area.maxLengthDots ? Math.floor((studio.target.target.area.maxLengthDots * 25.4) / studio.target.target.area.dpi) : 999)

  function setPreset(id: string) {
    const p = TAPE_PRESETS.find((x) => x.id === id)
    if (p) studio.updateDoc({ tape: { ...doc.tape, colors: { tape: p.tape, ink: p.ink } } })
  }
</script>

<section class="mediabar panel" aria-label="Tape and length">
  <div class="group width">
    <Segmented label="Tape width (mm)" options={widthOptions} value={doc.tape.widthMm} onchange={(w: TapeWidthMm) => studio.setTapeWidth(w)} size="small" />
    {#if loaded}
      <p class="hint">• loaded in the printer: {formatMm(loaded.widthMm)}</p>
    {/if}
  </div>

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
      <NumberField label="Printed length" unit="mm" min={5} max={maxLen} step={1} value={doc.length.mm} onchange={(mm) => studio.updateDoc({ length: { mode: 'fixed', mm, ...(doc.length.mode === 'fixed' && doc.length.shrink ? { shrink: true } : {}) } }, 'doc:length')} />
      {#if studio.render}
        <p class="length-hint">Cut label ≈ {formatMm(doc.length.mm + 2 * studio.render.feedMarginMm)} with the printer’s feed</p>
      {/if}
    {/if}
  </div>

  <div class="group margins">
    <NumberField label="Start margin" unit="mm" min={0} max={50} step={0.5} value={doc.marginsMm.start} onchange={(v) => studio.updateDoc({ marginsMm: { ...doc.marginsMm, start: v } }, 'doc:margin-start')} />
    <NumberField label="End margin" unit="mm" min={0} max={50} step={0.5} value={doc.marginsMm.end} onchange={(v) => studio.updateDoc({ marginsMm: { ...doc.marginsMm, end: v } }, 'doc:margin-end')} />
  </div>
</section>

{#if studio.mismatch}
  {@const m = studio.mismatch}
  <div class="mismatch" role="alert">
    <Icon name="alert" size={20} />
    <p>
      <strong>Tape mismatch.</strong> This label is designed for {formatMm(m.designMm)} tape, but the printer has {formatMm(m.loadedMm)} loaded.
    </p>
    <button type="button" class="btn small primary" onclick={() => studio.useLoadedTape()}>Use loaded {formatMm(m.loadedMm)} tape</button>
  </div>
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
  .colours {
    flex: 0 1 200px;
  }
  .length {
    flex: 0 1 220px;
    grid-template-columns: 1fr;
  }
  .length-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .margins {
    flex: 0 1 230px;
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
