<!-- P2 (docs/STUDIO-V1-PLAN.md) — "New from template" gallery: Wi-Fi stickers (12/24 mm), cable
     flag, cable wrap, shelf/bin/drawer (Gridfinity 12 mm), asset tag, folder spine, name tag.
     Cards are grouped by use, show a live to-scale thumbnail, the tape width and the label
     length as the editor shows it (measured by the thumbnail render), and say when they fit the loaded tape. Arrow keys move between cards (Home/End too); choosing one opens a
     new label (studio.newFromTemplate) with its main block selected. -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import Modal from '../common/Modal.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { formatMm, previewColors } from '../state/view-model'
  import { createTaskQueue, gridMove } from './gallery'
  import TemplateThumb from './TemplateThumb.svelte'
  import { TEMPLATES, TEMPLATE_CATEGORIES, fitsLoadedTape, primaryItemId, templatesIn, type TemplateDef } from './templates'

  const studio = getStudio()
  const id = $props.id()
  /** Thumbnails render two at a time (each one is a full label render). */
  const queue = createTaskQueue(2)
  /** Label length per template (mm, printed + 2 × feed: the editor's headline), once its
   * thumbnail has rendered. */
  let lengths = $state<Record<string, number>>({})
  /** The thumbnail shows a sample network (Wi-Fi codes open empty in the editor). */
  const sampled = (t: TemplateDef): boolean => t.build().items.some((i) => i.kind === 'code' && i.content === 'wifi')

  let grid: HTMLElement | undefined = $state()
  const open = $derived(studio.dialog === 'templates')
  const loadedMm = $derived(studio.conn.media?.widthMm ?? null)
  const fitting = $derived(TEMPLATES.filter((t) => fitsLoadedTape(t, loadedMm)).length)

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

  function choose(t: TemplateDef): void {
    studio.newFromTemplate(t.build())
    studio.selectedId = primaryItemId(studio.doc)
  }

  const colorsFor = (t: TemplateDef) => previewColors(studio.conn, { tape: { widthMm: t.tapeWidthMm } })
</script>

<Modal {open} title="New from template" size="l" description="Start a new label from a ready-made design. Your current label stays in Your labels." onclose={() => studio.closeDialog()}>
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
      <section aria-labelledby="{id}-{cat.id}">
        <h3 id="{id}-{cat.id}">{cat.label}</h3>
        <ul class="grid">
          {#each templatesIn(cat.id) as t (t.id)}
            {@const fits = fitsLoadedTape(t, loadedMm)}
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
                <TemplateThumb template={t} model={studio.model} colors={colorsFor(t)} {queue} onrender={(mm) => (lengths[t.id] = mm)} />
                <span class="name" id="{id}-{t.id}-name">{t.name}</span>
                <span class="chips" id="{id}-{t.id}-tape">
                  <span class="chip">{t.tapeWidthMm} mm tape</span>
                  {#if lengths[t.id] !== undefined}<span class="chip" data-length>{formatMm(lengths[t.id] ?? 0)} label{sampled(t) ? ' with a sample network' : ''}</span>{/if}
                  {#if fits}<span class="chip ok"><Icon name="check" size={14} />Fits the loaded tape</span>{/if}
                </span>
                <span class="desc" id="{id}-{t.id}-desc">{t.description}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</Modal>

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
