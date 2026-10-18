<!-- Tables (docs/TABLE-PLAN.md §4, §12) — the "Table cells" card: the selected table's cells, under
     the preview in the centre column (App.svelte; on a phone right under the preview), where the
     grid has the width of the label editor instead of the narrow inspector. Lazy, in the same
     chunk as TableProps (props/table-editor.ts). The cell grid (TableGrid) and "type or paste the
     whole table". Typing coalesces per cell; a symbol, a paste, Fill table and every add / remove
     are one undo step each. With two tables the card edits the selected one (its grid and paste
     box start afresh). -->
<script lang="ts">
  import type { TableItem } from '../../../doc/schema'
  import { cellsToText, colCount, parseCells, setCell, type Cells } from '../../../doc/table'
  import { getStudio } from '../../state/studio.svelte'
  import TableGrid from './TableGrid.svelte'

  let { item }: { item: TableItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const rows = $derived(item.cells.length)
  const cols = $derived(colCount(item.cells))

  function setCells(cells: Cells, message: string, notices?: string[]): void {
    studio.updateItem<TableItem>(item.id, { cells })
    studio.announce(notices?.length ? `${message}. ${notices.join(' ')}` : message)
    if (notices?.length) studio.toast('info', notices[0] ?? '', notices.slice(1).join(' ') || undefined)
  }

  // "Type or paste the whole table" (the path on a phone): replaces every cell. The draft belongs
  // to the table and the cells it was typed over: selecting another table (the same editor is
  // reused) or changing the cells elsewhere (the grid, undo / redo) drops it, so it can never be
  // written into the wrong table or over newer cells.
  let draft = $state.raw<{ id: string; cells: Cells; text: string } | null>(null)
  const ownDraft = $derived(draft && draft.id === item.id && draft.cells === item.cells ? draft.text : null)
  const shownDraft = $derived(ownDraft ?? cellsToText(item.cells))
  function fill(): void {
    // Unchanged text is the table itself (cellsToText reads back the same): nothing to do.
    if (ownDraft === null) return
    const parsed = parseCells(ownDraft)
    draft = null
    setCells(parsed.cells, `Table filled: ${parsed.cells.length} × ${colCount(parsed.cells)}`, parsed.notices)
  }
  const index = $derived(studio.doc.items.findIndex((i) => i.id === item.id))
  const tables = $derived(studio.doc.items.filter((i) => i.kind === 'table').length)
</script>

<section class="panel table-cells" id="table-cells" aria-labelledby="{id}-title">
  <header>
    <h2 class="panel-title" id="{id}-title">Table cells{#if tables > 1}<span class="which">{` · block ${index + 1}`}</span>{/if}</h2>
    <span class="dims">{rows} {rows === 1 ? 'row' : 'rows'} × {cols} {cols === 1 ? 'column' : 'columns'}</span>
  </header>
  <!-- Another table reuses this card: start its grid (current cell) and paste box (closed) afresh. -->
  {#key item.id}
    <TableGrid cells={item.cells} oncell={(r, c, v, step) => studio.updateItem<TableItem>(item.id, { cells: setCell(item.cells, r, c, v) }, step ? undefined : `${item.id}:cell:${r}:${c}`)} oncells={setCells} />

    <details class="paste">
      <summary>Type or paste the whole table</summary>
      <label class="field-label" for="{id}-paste">One line per row; cells separated by tabs, commas or semicolons, or by spaces when there are none (“quote a cell” to keep its spaces)</label>
      <textarea id="{id}-paste" class="textarea" rows="3" spellcheck="false" autocapitalize="characters" value={shownDraft} oninput={(e) => (draft = { id: item.id, cells: item.cells, text: e.currentTarget.value })}></textarea>
      <div class="paste-actions">
        <button type="button" class="btn small primary" disabled={ownDraft === null} title={ownDraft === null ? 'Change the text first' : undefined} onclick={fill}>Fill table</button>
        {#if ownDraft !== null}<button type="button" class="btn small ghost" onclick={() => (draft = null)}>Reset</button>{/if}
      </div>
    </details>
  {/key}
</section>

<style>
  .table-cells {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-4);
    min-width: 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-height: 24px;
  }
  .which {
    font-weight: 500;
    letter-spacing: 0;
  }
  .dims {
    font-size: 13px;
    color: var(--text-muted);
  }
  .paste {
    display: grid;
    gap: var(--space-2);
  }
  .paste summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--accent);
    min-height: 28px;
    display: flex;
    align-items: center;
  }
  .paste[open] {
    padding-bottom: var(--space-1);
  }
  .paste-actions {
    display: flex;
    gap: var(--space-2);
  }
  @media (max-width: 860px) {
    .table-cells {
      padding: var(--space-3);
    }
  }
  @media (max-width: 600px) {
    .table-cells {
      padding: var(--space-3) var(--space-2) var(--space-2);
    }
  }
  @media (pointer: coarse) {
    .paste summary {
      min-height: 44px;
    }
  }
</style>
