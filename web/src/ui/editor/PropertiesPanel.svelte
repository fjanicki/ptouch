<!-- W4 — PROPERTIES column: the selected block's editor (props/*.svelte) + label settings. -->
<script lang="ts">
  import { getStudio } from '../state/studio.svelte'
  import Icon from '../common/Icon.svelte'
  import TextProps from './props/TextProps.svelte'
  import IconProps from './props/IconProps.svelte'
  import CodeProps from './props/CodeProps.svelte'
  import ImageProps from './props/ImageProps.svelte'
  import ShapeProps from './props/ShapeProps.svelte'
  import SpacerProps from './props/SpacerProps.svelte'
  import LabelProps from './props/LabelProps.svelte'
  import { KIND_META } from '../state/view-model'

  const studio = getStudio()
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
    {:else if item.kind === 'icon'}<IconProps {item} />
    {:else if item.kind === 'code'}<CodeProps {item} />
    {:else if item.kind === 'image'}<ImageProps {item} />
    {:else if item.kind === 'shape'}<ShapeProps {item} />
    {:else if item.kind === 'spacer'}<SpacerProps {item} />
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
