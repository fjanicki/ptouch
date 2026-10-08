<!-- W4 — ordered block list (flow order, left → right): select, reorder (drag, Alt+↑/↓,
     buttons), duplicate, delete. Focus follows a moved block. -->
<script lang="ts">
  import { tick } from 'svelte'
  import { iconById } from '../../render'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { KIND_META, itemSummary } from '../state/view-model'

  const studio = getStudio()
  const items = $derived(studio.doc.items)
  let list: HTMLOListElement | undefined = $state()
  let dragId = $state<string | null>(null)
  let dropAt = $state<number | null>(null)

  const warningsByItem = $derived.by(() => {
    const m = new Map<string, string>()
    for (const w of studio.render?.warnings ?? []) if (w.itemId && !m.has(w.itemId)) m.set(w.itemId, w.message)
    return m
  })

  let emptyEl: HTMLParagraphElement | undefined = $state()

  async function focusRow(id: string) {
    await tick()
    list?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"]`)?.focus()
  }

  /** Delete and keep the keyboard user's place: the next (or previous) row, else the empty note. */
  async function remove(id: string) {
    studio.removeItem(id)
    if (studio.selectedId) await focusRow(studio.selectedId)
    else {
      await tick()
      emptyEl?.focus()
    }
  }

  function onkeydown(e: KeyboardEvent, id: string) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      studio.select(id)
      studio.move(id, e.key === 'ArrowUp' ? -1 : 1)
      void focusRow(id)
    } else if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const at = items.findIndex((i) => i.id === id)
      const next = items[at + (e.key === 'ArrowUp' ? -1 : 1)]
      if (next) {
        studio.select(next.id)
        void focusRow(next.id)
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      void remove(id)
    }
  }

  function ondragstart(e: DragEvent, id: string) {
    dragId = id
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function ondragover(e: DragEvent, index: number) {
    if (!dragId) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    dropAt = e.clientY > r.top + r.height / 2 ? index + 1 : index
  }
  function ondrop(e: DragEvent) {
    e.preventDefault()
    if (dragId !== null && dropAt !== null) {
      const from = items.findIndex((i) => i.id === dragId)
      const to = dropAt > from ? dropAt - 1 : dropAt
      studio.moveTo(dragId, to)
      studio.select(dragId)
    }
    dragId = null
    dropAt = null
  }
</script>

<section class="blocks-panel" aria-labelledby="blocks-title">
  <div class="head">
    <h2 class="panel-title" id="blocks-title">Blocks</h2>
    <span class="count">{items.length}</span>
  </div>
  {#if items.length === 0}
    <p class="empty" tabindex="-1" bind:this={emptyEl}>The label is empty. Insert text, an icon or a QR code to start.</p>
  {:else}
    <ol class="blocks" bind:this={list} aria-describedby="blocks-help" data-shortcut-scope>
      {#each items as item, i (item.id)}
        {@const s = itemSummary(item, (id) => iconById(id)?.label)}
        {@const selected = studio.selectedId === item.id}
        {@const warn = warningsByItem.get(item.id)}
        <li class:selected class:drop-before={dropAt === i && dragId !== item.id} class:drop-after={dropAt === i + 1 && i === items.length - 1} class:dragging={dragId === item.id}>
          <button
            type="button"
            class="row"
            data-id={item.id}
            draggable="true"
            aria-pressed={selected}
            aria-label="{s.title}: {s.summary}, block {i + 1} of {items.length}{warn ? `. Warning: ${warn}` : ''}"
            onclick={() => studio.select(item.id)}
            onfocus={() => studio.select(item.id)}
            onkeydown={(e) => onkeydown(e, item.id)}
            ondragstart={(e) => ondragstart(e, item.id)}
            ondragover={(e) => ondragover(e, i)}
            ondrop={ondrop}
            ondragend={() => {
              dragId = null
              dropAt = null
            }}
          >
            <span class="grip" aria-hidden="true"><Icon name="grip" size={16} /></span>
            <span class="kind" aria-hidden="true"><Icon name={item.kind === 'code' && item.symbology !== 'qr' ? 'barcode' : KIND_META[item.kind].icon} size={16} /></span>
            <span class="text">
              <span class="title">{s.title}</span>
              <span class="summary">{s.summary}</span>
            </span>
            {#if warn}<span class="warn" title={warn} aria-hidden="true"><Icon name="alert" size={16} /></span>{/if}
          </button>
          <div class="actions">
            <button type="button" class="btn ghost icon small" disabled={i === 0} aria-label="Move {s.title} earlier" title="Move earlier (Alt+↑)" onclick={() => studio.move(item.id, -1)}><Icon name="arrow-up" size={15} /></button>
            <button type="button" class="btn ghost icon small" disabled={i === items.length - 1} aria-label="Move {s.title} later" title="Move later (Alt+↓)" onclick={() => studio.move(item.id, 1)}><Icon name="arrow-down" size={15} /></button>
            <button type="button" class="btn ghost icon small" aria-label="Duplicate {s.title}" title="Duplicate" onclick={() => studio.duplicate(item.id)}><Icon name="copy" size={15} /></button>
            <button type="button" class="btn ghost icon small del" aria-label="Delete {s.title}" title="Delete (Del)" onclick={() => void remove(item.id)}><Icon name="trash" size={15} /></button>
          </div>
        </li>
      {/each}
    </ol>
    <p class="visually-hidden" id="blocks-help">Arrow keys move between blocks. Alt plus arrow keys reorder. Delete removes the block.</p>
  {/if}
</section>

<style>
  .blocks-panel {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .count {
    padding: 0 7px;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 700;
  }
  .empty {
    margin: 0;
    padding: var(--space-3);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-m);
    color: var(--text-muted);
    font-size: 13px;
  }
  .blocks {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 4px;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    transition: border-color 120ms var(--ease);
  }
  li:hover {
    border-color: var(--border-strong);
  }
  li.selected {
    border-color: var(--selection);
    box-shadow: 0 0 0 1px var(--selection);
    background: var(--accent-soft);
  }
  li.dragging {
    opacity: 0.5;
  }
  li.drop-before::before,
  li.drop-after::after {
    content: '';
    position: absolute;
    left: 6px;
    right: 6px;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  li.drop-before::before {
    top: -4px;
  }
  li.drop-after::after {
    bottom: -4px;
  }
  .row {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    min-height: 44px;
    padding: var(--space-1) var(--space-1) var(--space-1) 2px;
    border: 0;
    border-radius: var(--radius-m);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .row:focus-visible {
    outline-offset: -2px;
  }
  .grip {
    display: flex;
    color: var(--text-muted);
    cursor: grab;
    opacity: 0.6;
  }
  .kind {
    display: grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-s);
    background: var(--surface-2);
    color: var(--accent);
  }
  .text {
    display: grid;
    min-width: 0;
    line-height: 1.25;
  }
  .title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn {
    display: flex;
    color: var(--warn);
  }
  .actions {
    display: flex;
    padding-right: 4px;
    opacity: 0;
    transition: opacity 120ms var(--ease);
  }
  li:hover .actions,
  li.selected .actions,
  li:focus-within .actions {
    opacity: 1;
  }
  @media (hover: none) {
    .actions {
      opacity: 1;
    }
  }
  .del:hover:not(:disabled) {
    color: var(--danger);
  }
</style>
