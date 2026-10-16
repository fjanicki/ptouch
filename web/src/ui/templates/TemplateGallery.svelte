<!-- P2 (docs/STUDIO-V1-PLAN.md) — "New from template" gallery: Wi-Fi stickers (12/24/36 mm),
     cable flag, cable wrap, shelf/bin/drawer (Gridfinity 12 mm), asset tag, folder spine, name tag.
     Cards are grouped by use, show a live to-scale thumbnail, the tape width and the label
     length as the editor shows it (measured by the thumbnail render), and say when they fit the loaded tape. Arrow keys move between cards (Home/End too); choosing one opens a
     new label (studio.newFromTemplate) with its main block selected.
     Printer models (docs/MODELS-PLAN.md §3.9): the sections list the templates whose width the
     active model takes; the others sit behind "Show templates for other tape widths", marked
     "Needs 36 mm tape · PT-P710BT takes up to 24 mm". Opening one is allowed: the editor shows the
     unsupported-width notice with "Fit to …". While no printer is connected the "Printer model"
     picker sits on top, so the gallery can be switched to another model. -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import Modal from '../common/Modal.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { formatMm, previewColors } from '../state/view-model'
  import ModelPicker from '../media/ModelPicker.svelte'
  import { mediaForWidth, printArea } from '../../wasm'
  import { createTaskQueue, gridMove } from './gallery'
  import TemplateThumb from './TemplateThumb.svelte'
  import { TEMPLATES, TEMPLATE_CATEGORIES, fitsLoadedTape, needsWidthText, primaryItemId, templateFits, templateModel, templatesIn, type TemplateBand, type TemplateDef } from './templates'

  const studio = getStudio()
  const id = $props.id()
  /** Thumbnails render two at a time (each one is a full label render). */
  const queue = createTaskQueue(2)
  /** Label length per model and template (`<model>|<id>`; mm, printed + 2 × feed: the editor's
   * headline), once its thumbnail has rendered. */
  let lengths = $state<Record<string, number>>({})
  /** "Show templates for other tape widths" is open. */
  let showOthers = $state(false)
  /** The thumbnail shows a sample network (Wi-Fi codes open empty in the editor). */
  const sampled = (t: TemplateDef): boolean => t.build().items.some((i) => i.kind === 'code' && i.content === 'wifi')

  let grid: HTMLElement | undefined = $state()
  const open = $derived(studio.dialog === 'templates')
  const loadedMm = $derived(studio.conn.media?.widthMm ?? null)
  const fitting = $derived(TEMPLATES.filter((t) => fitsLoadedTape(t, loadedMm)).length)
  /** Templates for widths the active model does not take (none before the table is loaded). */
  const others = $derived(studio.modelInfo ? TEMPLATES.filter((t) => !templateFits(t, studio.tapeWidths)) : [])
  const shown = (t: TemplateDef): boolean => !others.includes(t)
  const lengthKey = (t: TemplateDef): string => `${studio.model}|${t.id}`

  const cards = (): HTMLButtonElement[] => [...(grid?.querySelectorAll<HTMLButtonElement>('[data-template]') ?? [])]

  // Opening: focus the first card that fits the loaded tape (else the first card) once the
  // native dialog has run its own focusing steps.
  $effect(() => {
    if (!open || !grid) return
    const raf = requestAnimationFrame(() => {
      const all = cards()
      ;(all.find((c) => c.dataset['fits'] === 'true') ?? all[0])?.focus()
    })
    return () => cancelAnimationFrame(raf)
  })

  function onkeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const all = cards()
    const from = all.indexOf(e.target as HTMLButtonElement)
    if (from < 0) return
    const points = all.map((c) => {
      const r = c.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const to = gridMove(points, from, e.key)
    if (to < 0) return
    e.preventDefault()
    all[to]?.focus()
    all[to]?.scrollIntoView({ block: 'nearest' })
  }

  /** The model `t` opens with (the active one, else the stand-in) and its band of `t`'s tape, so
   * quick sizes are that band's ("M" stays M on a 360 dpi model). Without the table: today's. */
  function opening(t: TemplateDef): { model: string | null; band?: TemplateBand } {
    if (studio.wasm !== 'ready') return { model: null }
    const model = templateModel(t, studio.model, studio.models)
    if (!model) return { model: null }
    try {
      const area = printArea(model, mediaForWidth(model, t.tapeWidthMm).id)
      return { model, band: { bandDots: area.heightDots, dpi: area.dpi } }
    } catch {
      return { model: null }
    }
  }

  function choose(t: TemplateDef): void {
    const { model, band } = opening(t)
    const doc = t.build(band)
    // `tape.model` (schema 4): the model the width was chosen for, as for any new label; for a
    // width the active model lacks, the stand-in ("Design for PT-P910BT" in the notice).
    studio.newFromTemplate(model ? { ...doc, tape: { ...doc.tape, model } } : doc)
    studio.selectedId = primaryItemId(studio.doc)
  }

  const colorsFor = (t: TemplateDef) => previewColors(studio.conn, { tape: { widthMm: t.tapeWidthMm } })
</script>

<Modal {open} title="New from template" size="l" description="Start a new label from a ready-made design. Your current label stays in Your labels." onclose={() => studio.closeDialog()}>
  {#if studio.modelSource === 'design' && studio.models.length}
    <div class="model"><ModelPicker /></div>
  {/if}
  <p class="loaded" class:fits={fitting > 0}>
    {#if loadedMm === null && studio.designOnly}
      <Icon name="info" size={16} />Pick the template for the tape you will print on; you can change the tape width later.
    {:else if loadedMm === null}
      <Icon name="info" size={16} />Connect your printer to see which templates fit the loaded tape.
    {:else if fitting > 0}
      <Icon name="check" size={16} />{loadedMm} mm tape is loaded: templates marked “Fits the loaded tape” print on it as they are.
    {:else}
      <Icon name="info" size={16} />{loadedMm} mm tape is loaded. No template is made for it; you can change the tape width after choosing one.
    {/if}
  </p>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sections" bind:this={grid} {onkeydown}>
    {#each TEMPLATE_CATEGORIES as cat (cat.id)}
      {@const list = templatesIn(cat.id).filter(shown)}
      {#if list.length}
        <section aria-labelledby="{id}-{cat.id}">
          <h3 id="{id}-{cat.id}">{cat.label}</h3>
          <ul class="grid">
            {#each list as t (t.id)}
              {@render card(t, null)}
            {/each}
          </ul>
        </section>
      {/if}
    {/each}
    {#if others.length}
      <section class="others" aria-labelledby="{id}-others">
        <button type="button" class="btn ghost toggle" id="{id}-others" aria-expanded={showOthers} aria-controls="{id}-others-list" onclick={() => (showOthers = !showOthers)}>
          <Icon name={showOthers ? 'chevron-down' : 'chevron-right'} size={16} />Show templates for other tape widths ({others.length})
        </button>
        {#if showOthers}
          <div id="{id}-others-list">
            <p class="hint">{studio.model} doesn’t take these tape widths. You can still open one: the editor offers to fit it to a width {studio.model} takes.</p>
            <ul class="grid">
              {#each others as t (t.id)}
                {@render card(t, needsWidthText(t.tapeWidthMm, studio.model, studio.tapeWidths))}
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    {/if}
  </div>
</Modal>

{#snippet card(t: TemplateDef, needs: string | null)}
  {@const fits = fitsLoadedTape(t, loadedMm)}
  {@const length = lengths[lengthKey(t)]}
  <li>
    <button
      type="button"
      class="card"
      class:fits
      data-template={t.id}
      data-fits={fits}
      aria-labelledby="{id}-{t.id}-name"
      aria-describedby="{id}-{t.id}-tape {id}-{t.id}-desc"
      onclick={() => choose(t)}
    >
      {#key studio.model}
        <TemplateThumb template={t} model={studio.model} colors={colorsFor(t)} {queue} onrender={(mm) => (lengths[lengthKey(t)] = mm)} />
      {/key}
      <span class="name" id="{id}-{t.id}-name">{t.name}</span>
      <span class="chips" id="{id}-{t.id}-tape">
        {#if needs}<span class="chip warn" data-needs>{needs}</span>{:else}<span class="chip">{t.tapeWidthMm} mm tape</span>{/if}
        {#if length !== undefined}<span class="chip" data-length>{formatMm(length)} label{sampled(t) ? ' with a sample network' : ''}</span>{/if}
        {#if fits}<span class="chip ok"><Icon name="check" size={14} />Fits the loaded tape</span>{/if}
      </span>
      <span class="desc" id="{id}-{t.id}-desc">{t.description}</span>
    </button>
  </li>
{/snippet}

<style>
  .loaded {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    color: var(--text-muted);
    font-size: 13px;
  }
  .loaded :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .loaded.fits {
    color: var(--ok);
  }
  section + section {
    margin-top: var(--space-4);
  }
  h3 {
    margin: 0 0 var(--space-2);
    font-size: 14px;
    color: var(--text-muted);
    font-weight: 600;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
    gap: var(--space-3);
  }
  li {
    display: flex;
    min-width: 0;
  }
  .card {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.12s var(--ease), background-color 0.12s var(--ease);
  }
  .card:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }
  .card.fits {
    border-color: var(--ok);
  }
  .card :global(.thumb) {
    background: var(--canvas-bg);
    border-radius: var(--radius-s);
  }
  .name {
    font-weight: 600;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--text);
    font-size: 12px;
    line-height: 20px;
  }
  .chip.ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .chip.warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .model {
    max-width: 360px;
    margin-bottom: var(--space-3);
  }
  .toggle {
    gap: var(--space-1);
    max-width: 100%;
    min-height: 44px;
    padding-left: var(--space-1);
    white-space: normal;
    text-align: left;
  }
  .toggle :global(svg) {
    flex: none;
  }
  .others .hint {
    margin: var(--space-2) 0;
  }
  .desc {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.4;
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      transition: none;
    }
  }
</style>
