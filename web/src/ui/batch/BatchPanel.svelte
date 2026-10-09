<!-- P1 (docs/STUDIO-V1-PLAN.md) — variables + batch: data table (paste text/CSV or type rows),
     counters, date format, per-row preview grid (studio.previewRow), row cap message, tape
     estimate; turns doc.batch on/off. Mounted by App.svelte under the preview. Collapsed by
     default (its header still shows the label count and unknown variables); opens by itself for
     a label that prints as a batch, and from VariableHint's "Edit data…". The expanded part
     (BatchBody) is a separate chunk loaded on first expand. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { findVariables, missingVariables } from '../../doc/variables'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { batchMeasure } from './batch-measure.svelte'
  import { clampRow } from './batch-model'
  import { BATCH_PANEL_ID, batchPanel } from './panel-state.svelte'

  const loadBody = () => import('./BatchBody.svelte')

  const studio = getStudio()
  const measure = batchMeasure(studio)
  const id = $props.id()

  const doc = $derived(studio.doc)
  const total = $derived(studio.batchCount)
  const used = $derived(findVariables(doc))
  const missing = $derived(missingVariables(doc))

  // Opening a label that prints as a batch shows its data.
  let lastId = ''
  $effect(() => {
    if (doc.id === lastId) return
    lastId = doc.id
    if (doc.batch?.enabled) batchPanel.open = true
  })

  // The preview row stays inside the batch (rows removed, batch turned off…).
  $effect(() => {
    const row = clampRow(doc, studio.previewRow)
    if (row !== studio.previewRow) studio.previewRow = row
  })

  // Background measuring + thumbnails follow the doc (shared with the print bar).
  $effect(() => {
    measure.sync(doc, studio.target.ok ? studio.target.target : null, studio.fontsVersion)
  })
  onDestroy(() => measure.dispose())
</script>

<section class="panel batch" id={BATCH_PANEL_ID} aria-labelledby="{id}-title">
  <h2 class="head">
    <button type="button" class="toggle" data-batch-toggle aria-expanded={batchPanel.open} aria-controls="{id}-body" onclick={() => (batchPanel.open = !batchPanel.open)}>
      <Icon name="table" size={18} />
      <span id="{id}-title" class="title">Variables &amp; batch</span>
      {#if missing.length}
        <span class="badge error"><Icon name="alert" size={12} />{missing.length} unknown</span>
      {/if}
      {#if total > 0}
        <span class="badge on">{total} {total === 1 ? 'label' : 'labels'}</span>
      {:else if used.length}
        <span class="badge">{used.length} {used.length === 1 ? 'variable' : 'variables'}</span>
      {/if}
      <span class="chev"><Icon name={batchPanel.open ? 'chevron-up' : 'chevron-down'} size={16} /></span>
    </button>
  </h2>

  {#if batchPanel.open}
    {#await loadBody()}
      <p class="loading" id="{id}-body" role="status">Loading…</p>
    {:then { default: BatchBody }}
      <BatchBody {id} {measure} />
    {:catch}
      <p class="loading" id="{id}-body" role="alert">The data table could not be loaded. Check your connection and reload the page.</p>
    {/await}
  {/if}
</section>

<style>
  .batch {
    min-width: 0;
  }
  .head {
    margin: 0;
    font-size: inherit;
  }
  .toggle {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    width: 100%;
    min-height: 44px;
    padding: var(--space-2) var(--space-4);
    border: 0;
    border-radius: var(--radius-l);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .toggle:hover {
    background: var(--surface-2);
  }
  .title {
    font-size: 14px;
    font-weight: 650;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .badge.on {
    background: var(--accent-soft);
    color: var(--text);
  }
  .badge.error {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .chev {
    display: flex;
    margin-left: auto;
    color: var(--text-muted);
  }
  .loading {
    margin: 0;
    padding: 0 var(--space-4) var(--space-4);
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
