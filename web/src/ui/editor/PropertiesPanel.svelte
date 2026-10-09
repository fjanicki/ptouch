<!-- W4 — PROPERTIES column: the selected block's editor (props/*.svelte) + label settings.
     Entry-chunk budget (docs/FONTS-AND-SIZE-PLAN.md §2.8): only the text editor (the block every
     label starts with) is in the entry chunk; the other editors load the first time a block of
     their kind is selected and then stay cached (the service worker precaches their chunks). -->
<script lang="ts">
  import type { Component } from 'svelte'
  import type { Item, ItemKind } from '../../doc/schema'
  import { getStudio } from '../state/studio.svelte'
  import Icon from '../common/Icon.svelte'
  import TextProps from './props/TextProps.svelte'
  import LabelProps from './props/LabelProps.svelte'
  import { KIND_META } from '../state/view-model'

  type Editor = Component<{ item: Item }>
  const LAZY: Record<Exclude<ItemKind, 'text'>, () => Promise<{ default: unknown }>> = {
    icon: () => import('./props/IconProps.svelte'),
    code: () => import('./props/CodeProps.svelte'),
    image: () => import('./props/ImageProps.svelte'),
    shape: () => import('./props/ShapeProps.svelte'),
    spacer: () => import('./props/SpacerProps.svelte'),
  }

  const studio = getStudio()
  let editors = $state<Partial<Record<ItemKind, Editor>>>({})
  let failed = $state<ItemKind | null>(null)
  const loading = new Set<ItemKind>()
  $effect(() => {
    const kind = studio.selected?.kind
    if (!kind || kind === 'text' || editors[kind] || loading.has(kind)) return
    loading.add(kind)
    failed = null
    LAZY[kind]()
      .then((m) => {
        editors[kind] = m.default as Editor
      })
      .catch(() => {
        failed = kind
      })
      .finally(() => loading.delete(kind))
  })
  const item = $derived(studio.selected)
  const warnings = $derived(item ? (studio.render?.warnings ?? []).filter((w) => w.itemId === item.id) : [])
  const index = $derived(item ? studio.doc.items.findIndex((i) => i.id === item.id) : -1)
</script>

<aside class="props" aria-label="Properties">
  <section class="panel card" aria-labelledby="block-props-title">
    <header>
      <h2 class="panel-title" id="block-props-title">
        {#if item}{KIND_META[item.kind].label} block <span class="pos">{index + 1}/{studio.doc.items.length}</span>{:else}Block{/if}
      </h2>
      {#if item}
        <div class="head-actions">
          <button type="button" class="btn ghost icon small" aria-label="Duplicate block" title="Duplicate" onclick={() => item && studio.duplicate(item.id)}><Icon name="copy" size={16} /></button>
          <button type="button" class="btn ghost icon small" aria-label="Delete block" title="Delete" onclick={() => item && studio.removeItem(item.id)}><Icon name="trash" size={16} /></button>
        </div>
      {/if}
    </header>
    {#if warnings.length}
      <ul class="warnings">
        {#each warnings as w, i (i)}<li><Icon name="alert" size={14} />{w.message}</li>{/each}
      </ul>
    {/if}
    {#if !item}
      <p class="none">Select a block in the list or on the preview to edit it.</p>
    {:else if item.kind === 'text'}<TextProps {item} />
    {:else if editors[item.kind]}
      {@const Editor = editors[item.kind] as Editor}
      <Editor {item} />
    {:else if failed === item.kind}
      <p class="none" role="alert">This editor could not be loaded. Check your connection and reload the page.</p>
    {:else}
      <p class="none" role="status">Loading…</p>
    {/if}
  </section>
  <section class="panel card" aria-labelledby="label-props-title">
    <header><h2 class="panel-title" id="label-props-title">Label</h2></header>
    <LabelProps />
  </section>
</aside>

<style>
  .props {
    display: grid;
    gap: var(--space-3);
    align-content: start;
    min-width: 0;
  }
  .card {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 28px;
  }
  .pos {
    margin-left: 4px;
    font-weight: 500;
    letter-spacing: 0;
  }
  .head-actions {
    display: flex;
  }
  .none {
    margin: 0;
    color: var(--text-muted);
  }
  .warnings {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-s);
    background: var(--warn-soft);
    color: var(--text);
    font-size: 13px;
    display: grid;
    gap: 2px;
  }
  .warnings li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .warnings :global(svg) {
    color: var(--warn);
    transform: translateY(2px);
  }
</style>
