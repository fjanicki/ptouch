<!-- W4 — "Open label" dialog: saved labels (W5 LabelStore) with thumbnails, newest first. -->
<script lang="ts">
  import type { LabelSummary } from '../../doc/persist'
  import Icon from '../common/Icon.svelte'
  import { errorMessage, getStudio } from '../state/studio.svelte'

  const studio = getStudio()
  let dialog: HTMLDialogElement | undefined = $state()
  let labels = $state<LabelSummary[] | null>(null)
  let error = $state<string | null>(null)
  let filter = $state('')

  const shown = $derived((labels ?? []).filter((l) => l.name.toLowerCase().includes(filter.trim().toLowerCase())))

  $effect(() => {
    if (studio.libraryOpen) {
      if (!dialog?.open) dialog?.showModal()
      void refresh()
    } else if (dialog?.open) dialog.close()
  })

  async function refresh() {
    try {
      error = null
      await studio.autosave.flush().catch(() => {})
      labels = await studio.store.list()
    } catch (e) {
      error = errorMessage(e)
      labels = []
    }
  }

  async function remove(l: LabelSummary) {
    if (!confirm(`Delete “${l.name}”? This cannot be undone.`)) return
    try {
      await studio.store.remove(l.id)
      if (l.id === studio.doc.id) studio.newLabel()
      await refresh()
    } catch (e) {
      studio.toast('error', 'Could not delete the label', errorMessage(e))
    }
  }

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  function when(iso: string): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : fmt.format(d)
  }
</script>

<dialog class="modal library" bind:this={dialog} onclose={() => (studio.libraryOpen = false)} aria-labelledby="library-title">
  <header>
    <h2 id="library-title">Your labels</h2>
    <button type="button" class="btn ghost icon" aria-label="Close" onclick={() => (studio.libraryOpen = false)}><Icon name="x" /></button>
  </header>
  <div class="tools">
    <label class="search">
      <Icon name="search" size={16} />
      <input class="input" type="search" placeholder="Search labels" aria-label="Search labels" bind:value={filter} />
    </label>
    <button
      type="button"
      class="btn primary"
      onclick={() => {
        studio.newLabel()
        studio.libraryOpen = false
      }}><Icon name="file-plus" size={16} />New label</button
    >
  </div>
  {#if error}<p class="hint error">{error}</p>{/if}
  {#if labels === null}
    <p class="empty">Loading…</p>
  {:else if shown.length === 0}
    <p class="empty">{labels.length ? 'No label matches.' : 'Labels you make are saved in this browser automatically. They will show up here.'}</p>
  {:else}
    <ul class="grid">
      {#each shown as l (l.id)}
        <li class:current={l.id === studio.doc.id}>
          <button type="button" class="open" onclick={() => void studio.openFromLibrary(l.id)} aria-label="Open {l.name}">
            <span class="thumb">
              {#if l.thumbUrl}<img src={l.thumbUrl} alt="" />{:else}<Icon name="tag" size={22} />{/if}
            </span>
            <span class="meta">
              <strong>{l.name}</strong>
              <span>{l.tapeWidthMm} mm · {when(l.updatedAt)}</span>
            </span>
          </button>
          <button type="button" class="btn ghost icon small del" aria-label="Delete {l.name}" onclick={() => void remove(l)}><Icon name="trash" size={16} /></button>
        </li>
      {/each}
    </ul>
  {/if}
</dialog>

<style>
  .library {
    width: min(680px, calc(100% - 32px));
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-4) 0 var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .tools {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
  }
  .search {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    color: var(--text-muted);
  }
  .search :global(svg) {
    position: absolute;
    left: 10px;
  }
  .search input {
    padding-left: 34px;
  }
  .empty {
    padding: var(--space-5);
    margin: 0;
    color: var(--text-muted);
    text-align: center;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0 var(--space-5) var(--space-5);
    display: grid;
    gap: var(--space-2);
    max-height: 60vh;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    padding-right: var(--space-2);
  }
  li.current {
    border-color: var(--accent);
  }
  li:hover {
    background: var(--surface-2);
  }
  .open {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-2);
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-m);
  }
  .thumb {
    flex: none;
    display: grid;
    place-items: center;
    width: 120px;
    height: 44px;
    border-radius: 4px;
    background: #fff;
    color: #555;
    overflow: hidden;
    box-shadow: var(--shadow-1);
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
  }
  .meta {
    display: grid;
    min-width: 0;
  }
  .meta strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta span {
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
