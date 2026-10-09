<!-- P1 (docs/STUDIO-V1-PLAN.md) — the batch data table: editable column names and cells, add /
     remove rows and columns, paged (TABLE_PAGE_SIZE rows) so 500 rows stay light. Keyboard:
     Tab moves along a row, ↑/↓ move between rows (across pages), Enter moves down and adds a row
     after the last one. Empty cells of columns the label uses are flagged (border + "empty"). -->
<script lang="ts">
  import { tick } from 'svelte'
  import { LIMITS, type BatchData } from '../../doc/schema'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { TABLE_PAGE_SIZE, addColumn, addRow, emptyUsedCells, nameProblem, pageCount, pageOf, removeColumn, removeRow, renameColumn, setCell } from './batch-model'

  let { batch }: { batch: BatchData } = $props()
  const studio = getStudio()
  const id = $props.id()

  let page = $state(0)
  let table: HTMLTableElement | undefined = $state()
  /** Column-name drafts that are not (yet) valid names: index → text. */
  let drafts = $state<Record<number, string>>({})

  const pages = $derived(pageCount(batch.rows.length, TABLE_PAGE_SIZE))
  const first = $derived(Math.min(page, pages - 1) * TABLE_PAGE_SIZE)
  const shown = $derived(batch.rows.slice(first, first + TABLE_PAGE_SIZE))
  const empty = $derived(emptyUsedCells(studio.doc))

  const save = (b: BatchData, key?: string) => studio.updateDoc({ batch: b }, key)

  async function focusCell(row: number, col: number) {
    page = pageOf(row, TABLE_PAGE_SIZE)
    await tick()
    table?.querySelector<HTMLInputElement>(`[data-cell="${row},${col}"]`)?.focus()
  }

  function onCellKey(e: KeyboardEvent, row: number, col: number) {
    if (e.altKey || e.metaKey || e.ctrlKey || e.isComposing) return
    if (e.key === 'ArrowUp' && row > 0) {
      e.preventDefault()
      void focusCell(row - 1, col)
    } else if (e.key === 'ArrowDown' && row < batch.rows.length - 1) {
      e.preventDefault()
      void focusCell(row + 1, col)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (row < batch.rows.length - 1) void focusCell(row + 1, col)
      else if (batch.rows.length < LIMITS.batchRows) {
        save(addRow(batch))
        void focusCell(row + 1, col)
      }
    }
  }

  function commitName(col: number, value: string) {
    const name = value.trim()
    if (name === batch.columns[col]) {
      delete drafts[col]
      return
    }
    if (nameProblem(batch, name, { col })) {
      drafts[col] = value
      return
    }
    delete drafts[col]
    save(renameColumn(batch, col, name))
    studio.announce(`Column renamed to ${name}`)
  }

  async function addCol() {
    const col = batch.columns.length
    save(addColumn(batch))
    await tick()
    const input = table?.querySelector<HTMLInputElement>(`[data-col="${col}"]`)
    input?.focus()
    input?.select()
  }

  async function removeCol(col: number) {
    const name = batch.columns[col]
    drafts = {}
    save(removeColumn(batch, col))
    studio.announce(`Column ${name} removed`)
    await tick()
    table?.querySelector<HTMLInputElement>(`[data-col="${Math.max(0, col - 1)}"]`)?.focus()
  }

  async function addRowAtEnd() {
    const row = batch.rows.length
    save(addRow(batch))
    await focusCell(row, 0)
  }

  async function removeRowAt(row: number) {
    const left = batch.rows.length - 1
    save(removeRow(batch, row))
    studio.announce(`Row ${row + 1} removed`)
    if (left > 0) await focusCell(Math.min(row, left - 1), 0)
  }
</script>

<div class="wrap">
  <div class="scroll">
    <table bind:this={table} aria-label="Batch data" aria-describedby="{id}-help">
      <thead>
        <tr>
          <th scope="col" class="num"><span aria-hidden="true">#</span><span class="visually-hidden">Row</span></th>
          {#each batch.columns as name, col (col)}
            {@const draft = drafts[col]}
            {@const problem = draft !== undefined ? nameProblem(batch, draft.trim(), { col }) : undefined}
            <th scope="col">
              <div class="colhead">
                <input
                  class="input name"
                  data-col={col}
                  value={draft ?? name}
                  aria-label="Column {col + 1} name"
                  aria-invalid={problem ? 'true' : undefined}
                  aria-describedby={problem ? `${id}-name-${col}` : undefined}
                  spellcheck="false"
                  autocomplete="off"
                  onchange={(e) => commitName(col, e.currentTarget.value)}
                  onkeydown={(e) => e.key === 'Enter' && commitName(col, e.currentTarget.value)}
                />
                <button type="button" class="btn icon small ghost" aria-label="Remove column {name}" title="Remove column" onclick={() => void removeCol(col)}><Icon name="x" size={14} /></button>
              </div>
              {#if problem}<p class="hint error" id="{id}-name-{col}">{problem}</p>{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each shown as cells, k (first + k)}
          {@const row = first + k}
          <tr>
            <th scope="row" class="num">
              <span class="rownum">{row + 1}</span>
              <button type="button" class="btn icon small ghost" aria-label="Remove row {row + 1}" title="Remove row" onclick={() => void removeRowAt(row)}><Icon name="trash" size={13} /></button>
            </th>
            {#each cells as cell, col (col)}
              {@const isEmpty = empty.has(`${row},${col}`)}
              <td>
                <input
                  class="input cell"
                  class:empty={isEmpty}
                  data-cell="{row},{col}"
                  value={cell}
                  maxlength={LIMITS.batchCellChars}
                  placeholder={isEmpty ? 'empty' : ''}
                  aria-label="{batch.columns[col]}, row {row + 1}{isEmpty ? ' (empty, used on the label)' : ''}"
                  aria-invalid={isEmpty ? 'true' : undefined}
                  autocomplete="off"
                  oninput={(e) => save(setCell(batch, row, col, e.currentTarget.value), `batch:cell:${row},${col}`)}
                  onkeydown={(e) => onCellKey(e, row, col)}
                />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hint" id="{id}-help">↑ ↓ move between rows; Enter goes to the next row (and adds one at the end).</p>
  <div class="actions">
    <button type="button" class="btn small" disabled={batch.rows.length >= LIMITS.batchRows} onclick={() => void addRowAtEnd()}><Icon name="plus" size={14} />Row</button>
    <button type="button" class="btn small" disabled={batch.columns.length >= LIMITS.batchColumns} onclick={() => void addCol()}><Icon name="plus" size={14} />Column</button>
    {#if pages > 1}
      <nav class="pager" aria-label="Table pages">
        <button type="button" class="btn icon small" aria-label="Previous rows" disabled={first === 0} onclick={() => (page = Math.max(0, pageOf(first, TABLE_PAGE_SIZE) - 1))}><Icon name="chevron-left" size={14} /></button>
        <span aria-live="polite">Rows {first + 1}–{Math.min(batch.rows.length, first + TABLE_PAGE_SIZE)} of {batch.rows.length}</span>
        <button type="button" class="btn icon small" aria-label="Next rows" disabled={first + TABLE_PAGE_SIZE >= batch.rows.length} onclick={() => (page = pageOf(first, TABLE_PAGE_SIZE) + 1)}><Icon name="chevron-right" size={14} /></button>
      </nav>
    {/if}
  </div>
  {#if batch.rows.length >= LIMITS.batchRows}
    <p class="hint warn">{LIMITS.batchRows} rows is the maximum for one batch.</p>
  {/if}
</div>

<style>
  .wrap {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .scroll {
    overflow: auto;
    max-height: 420px;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    overscroll-behavior: contain;
  }
  table {
    border-collapse: collapse;
    min-width: 100%;
    font-size: 13px;
  }
  th,
  td {
    padding: 3px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    text-align: left;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-2);
    font-weight: 600;
  }
  .num {
    width: 1%;
    white-space: nowrap;
    color: var(--text-muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  tbody .num {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: var(--space-2);
  }
  .rownum {
    min-width: 2.2em;
  }
  .colhead {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .input.name {
    min-width: 96px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }
  .input.cell {
    min-width: 120px;
    min-height: 30px;
  }
  .input.cell.empty {
    border-color: var(--danger);
    border-style: dashed;
    background: var(--danger-soft);
  }
  .input.cell.empty::placeholder {
    color: var(--danger);
    opacity: 1;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .pager {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
