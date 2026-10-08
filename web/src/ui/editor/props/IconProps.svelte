<!-- W4 — properties of an icon block: searchable icon picker (render/icons.ts) + size. -->
<script lang="ts">
  import type { IconItem } from '../../../doc/schema'
  import { ICONS, type IconDef } from '../../../render'
  import SizeField from '../../common/SizeField.svelte'
  import { getStudio } from '../../state/studio.svelte'

  let { item }: { item: IconItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  let query = $state('')
  let category = $state<IconDef['category'] | 'all'>('all')

  const CATEGORY_LABEL: Record<IconDef['category'], string> = { electrical: 'Electrical', tools: 'Tools', arrows: 'Arrows', hazard: 'Hazard', home: 'Home', misc: 'Misc' }
  const categories = $derived([...new Set(ICONS.map((i) => i.category))])
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return ICONS.filter((i) => (category === 'all' || i.category === category) && (!q || i.label.toLowerCase().includes(q) || i.keywords.some((k) => k.includes(q))))
  })
</script>

<div class="field">
  <div class="search-row">
    <input class="input" type="search" placeholder="Search icons" aria-label="Search icons" bind:value={query} />
    {#if categories.length > 1}
      <select class="select" aria-label="Icon category" bind:value={category}>
        <option value="all">All</option>
        {#each categories as c (c)}<option value={c}>{CATEGORY_LABEL[c]}</option>{/each}
      </select>
    {/if}
  </div>
  <div class="grid" role="radiogroup" aria-label="Icon" id="{id}-grid">
    {#each shown as icon (icon.id)}
      <button
        type="button"
        role="radio"
        aria-checked={icon.id === item.iconId}
        aria-label={icon.label}
        title={icon.label}
        onclick={() => studio.updateItem<IconItem>(item.id, { iconId: icon.id })}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#each icon.paths as d, i (i)}<path {d} />{/each}
        </svg>
      </button>
    {:else}
      <p class="hint">No icon matches “{query}”.</p>
    {/each}
  </div>
</div>

<SizeField label="Icon size" value={item.size} onchange={(size) => studio.updateItem<IconItem>(item.id, { size }, `${item.id}:size`)} maxMm={studio.doc.tape.widthMm} />

<style>
  .search-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-2);
  }
  .search-row .select {
    width: auto;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 4px;
    max-height: 220px;
    overflow: auto;
    padding: 2px;
  }
  .grid button {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .grid button:hover {
    border-color: var(--accent);
  }
  .grid button[aria-checked='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
</style>
