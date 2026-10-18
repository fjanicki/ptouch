<!-- Tables (docs/TABLE-PLAN.md §4, §12) — the cell grid of the "Table cells" card (lazy, with
     TableProps): one input per cell ("Row 2, column 3"), each column as wide as its longest cell
     (within limits), a remove button on every column and row (not on a phone, where the rows go
     with the toolbar's "− Row n" so seven columns fit), "Ω Symbols" (insert special character) at
     the caret, Add row / Add column, and the "Remove row / column" of the current cell for the
     keyboard. Keys: Tab / Shift+Tab = next / previous cell (row by row), ↑ / ↓ = the row above /
     below, Enter = the cell below, then the top of the next column (adding one after the last:
     "DO ⏎ C ⏎ RE ⏎ D …" types notes in pairs), Shift+Enter = the cell above. Pasting text with a
     tab or a line break fills the grid from the cell. A grid wider than the card scrolls in its own
     box, with a visible scroll bar, faded edges on the sides that have more columns and a hint;
     the focused cell is kept in view. -->
<script lang="ts">
  import { tick } from 'svelte'
  import { LIMITS } from '../../../doc/schema'
  import { detectDelimiter } from '../../../doc/csv'
  import { colCount, insertColumn, insertRow, moveFrom, parseCells, pasteCells, removeColumn, removeRow, type Cells } from '../../../doc/table'
  import Icon from '../../common/Icon.svelte'
  import SymbolButton from '../SymbolButton.svelte'

  let {
    cells,
    oncell,
    oncells,
  }: {
    cells: Cells
    /** One cell typed (coalesced per cell by the caller); `step`: its own undo step (a symbol). */
    oncell: (r: number, c: number, value: string, step?: boolean) => void
    /** A structural change (one undo step); `message` is announced, `notices` shown. */
    oncells: (cells: Cells, message: string, notices?: string[]) => void
  } = $props()

  const rows = $derived(cells.length)
  const cols = $derived(colCount(cells))
  let grid: HTMLDivElement | undefined = $state()
  /** The cell the toolbar acts on (last focused). */
  let cur = $state({ r: 0, c: 0 })
  const r0 = $derived(Math.min(cur.r, rows - 1))
  const c0 = $derived(Math.min(cur.c, cols - 1))

  async function focusCell(r: number, c: number, select = true): Promise<void> {
    await tick()
    const el = grid?.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`)
    if (!el) return
    el.focus()
    if (select) el.select()
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  function change(next: Cells, message: string, at?: { r: number; c: number }, notices?: string[]): void {
    oncells(next, message, notices)
    if (at) {
      cur = at
      void focusCell(at.r, at.c)
    }
  }

  function onkeydown(e: KeyboardEvent, r: number, c: number): void {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
    const key = e.key === 'Enter' ? (e.shiftKey ? 'shift-enter' : 'enter') : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'Tab' ? (e.shiftKey ? 'prev' : 'next') : undefined
    if (!key) return
    const to = moveFrom(rows, cols, r, c, key)
    // Tab past the first / last cell leaves the grid as usual.
    if (!to) {
      if (key !== 'next' && key !== 'prev') e.preventDefault()
      return
    }
    e.preventDefault()
    if (to.addColumn) change(insertColumn(cells, cols), `Column ${cols + 1} added`, to)
    else {
      cur = to
      void focusCell(to.r, to.c)
    }
  }

  function onpaste(e: ClipboardEvent, r: number, c: number): void {
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const body = text.replace(/[\r\n]+$/, '')
    // A tab or a line break fills the grid; so does one line of a comma or semicolon list
    // ("DO,RE,MI") that splits into several cells. Anything else is pasted into the cell.
    const multi = /[\t\n\r]/.test(body)
    const parsed = multi || detectDelimiter(body) ? parseCells(text) : null
    if (!parsed || (!multi && parsed.cells.length * colCount(parsed.cells) < 2)) return
    e.preventDefault()
    const pasted = pasteCells(cells, r, c, parsed.cells)
    change(pasted.cells, `Pasted ${parsed.cells.length} × ${colCount(parsed.cells)} cells`, { r, c }, [...parsed.notices, ...pasted.notices])
  }

  /** The current cell's input (the field "Insert special character" writes into). */
  const curInput = (): HTMLInputElement | null | undefined => grid?.querySelector<HTMLInputElement>(`input[data-r="${r0}"][data-c="${c0}"]`)

  /** Each column as wide as its longest cell, in characters (2 to 14; longer cells scroll). */
  const widths = $derived(Array.from({ length: cols }, (_, c) => Math.min(14, Math.max(2, ...cells.map((row) => [...(row[c] ?? '')].length)))))

  // More columns than the card is wide: which sides have more (faded edges, the hint).
  let more = $state({ left: false, right: false })
  function edges(): void {
    if (!grid) return
    const { scrollLeft, scrollWidth, clientWidth } = grid
    const left = scrollLeft > 1
    const right = scrollLeft + clientWidth < scrollWidth - 1
    if (left !== more.left || right !== more.right) more = { left, right }
  }
  $effect(() => {
    void cells
    edges()
    if (!grid || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(edges)
    ro.observe(grid)
    const table = grid.firstElementChild
    if (table) ro.observe(table)
    return () => ro.disconnect()
  })

  const fullRows = $derived(rows >= LIMITS.tableRows)
  const fullCols = $derived(cols >= LIMITS.tableCols)
  /** The only row / column cannot be removed (a table keeps at least one cell). */
  const lastRow = $derived(rows <= 1)
  const lastCol = $derived(cols <= 1)
  const uid = $props.id()
</script>

<div class="table-grid">
  <div class="scroll-wrap" class:fade-l={more.left} class:fade-r={more.right}>
  <div class="scroll" bind:this={grid} onscroll={edges} role="group" aria-label="Table cells, {rows} {rows === 1 ? 'row' : 'rows'} × {cols} {cols === 1 ? 'column' : 'columns'}">
    <table>
      <thead>
        <tr>
          <td class="rowx"></td>
          {#each { length: cols } as _, c (c)}
            <th scope="col">
              <button type="button" class="btn ghost icon small rm" tabindex="-1" aria-label="Remove column {c + 1}" title={lastCol ? 'A table has at least one column' : `Remove column ${c + 1}`} disabled={lastCol} onclick={() => change(removeColumn(cells, c), `Column ${c + 1} removed`, { r: r0, c: Math.max(0, Math.min(c, cols - 2)) })}><Icon name="x" size={14} /></button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each cells as row, r (r)}
          <tr>
            <th scope="row" class="rowx">
              <button type="button" class="btn ghost icon small rm" tabindex="-1" aria-label="Remove row {r + 1}" title={lastRow ? 'A table has at least one row' : `Remove row ${r + 1}`} disabled={lastRow} onclick={() => change(removeRow(cells, r), `Row ${r + 1} removed`, { r: Math.max(0, Math.min(r, rows - 2)), c: c0 })}><Icon name="x" size={14} /></button>
            </th>
            {#each row as value, c (c)}
              <td>
                <input
                  class="input cell"
                  type="text"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck="false"
                  enterkeyhint="next"
                  maxlength={LIMITS.tableCellChars}
                  data-r={r}
                  data-c={c}
                  aria-label="Row {r + 1}, column {c + 1}"
                  style:width="calc({widths[c] ?? 2}ch + 14px)"
                  data-cur={r === r0 && c === c0 ? '' : undefined}
                  {value}
                  onfocus={() => (cur = { r, c })}
                  oninput={(e) => oncell(r, c, e.currentTarget.value)}
                  onkeydown={(e) => onkeydown(e, r, c)}
                  onpaste={(e) => onpaste(e, r, c)}
                />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  </div>
  {#if more.left || more.right}<p class="hint more" aria-hidden="true">{more.right ? 'More columns →' : '← More columns'} · scroll sideways</p>{/if}
  <div class="tools">
    <SymbolButton labelled field={curInput} oninsert={(text) => oncell(r0, c0, text, true)} />
    <button type="button" class="btn small" aria-label="Add row" aria-describedby={fullRows ? `${uid}-limits` : undefined} disabled={fullRows} title={fullRows ? `A table has at most ${LIMITS.tableRows} rows` : undefined} onclick={() => change(insertRow(cells, rows), `Row ${rows + 1} added`, { r: rows, c: c0 })}><Icon name="plus" size={14} />Row</button>
    <button type="button" class="btn small" aria-label="Add column" aria-describedby={fullCols ? `${uid}-limits` : undefined} disabled={fullCols} title={fullCols ? `A table has at most ${LIMITS.tableCols} columns` : undefined} onclick={() => change(insertColumn(cells, cols), `Column ${cols + 1} added`, { r: r0, c: cols })}><Icon name="plus" size={14} />Column</button>
    <button type="button" class="btn small" aria-label="Remove row {r0 + 1}" disabled={lastRow} title={lastRow ? 'A table has at least one row' : undefined} onclick={() => change(removeRow(cells, r0), `Row ${r0 + 1} removed`, { r: Math.max(0, Math.min(r0, rows - 2)), c: c0 })}><Icon name="minus" size={14} />Row {r0 + 1}</button>
    <button type="button" class="btn small" aria-label="Remove column {c0 + 1}" disabled={lastCol} title={lastCol ? 'A table has at least one column' : undefined} onclick={() => change(removeColumn(cells, c0), `Column ${c0 + 1} removed`, { r: r0, c: Math.max(0, Math.min(c0, cols - 2)) })}><Icon name="minus" size={14} />Column {c0 + 1}</button>
  </div>
  {#if fullRows || fullCols}<p class="hint" id="{uid}-limits">{[fullRows ? `A table has at most ${LIMITS.tableRows} rows.` : '', fullCols ? `A table has at most ${LIMITS.tableCols} columns.` : ''].filter(Boolean).join(' ')}</p>{/if}
  <p class="hint">Tab: next cell · Enter: cell below, then the next column · paste from a spreadsheet, or a list like DO,RE,MI, to fill the grid.</p>
</div>

<style>
  .table-grid {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .scroll-wrap {
    position: relative;
    min-width: 0;
  }
  /* Faded edges where more columns are hidden (above the cells, not over the scroll bar). */
  .scroll-wrap::before,
  .scroll-wrap::after {
    content: '';
    position: absolute;
    top: 1px;
    bottom: 13px;
    width: 40px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 1;
  }
  .scroll-wrap::before {
    left: 1px;
    border-radius: var(--radius-m) 0 0 0;
    background: linear-gradient(to right, var(--surface), transparent);
  }
  .scroll-wrap::after {
    right: 1px;
    border-radius: 0 var(--radius-m) 0 0;
    background: linear-gradient(to left, var(--surface), transparent);
  }
  .fade-l::before,
  .fade-r::after {
    opacity: 1;
  }
  .scroll {
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    padding: 2px;
    /* The focused cell scrolls clear of the faded edges. */
    scroll-padding-inline: 44px;
  }
  /* An always-visible scroll bar (macOS hides overlay ones until you scroll). */
  .scroll::-webkit-scrollbar {
    height: 10px;
  }
  .scroll::-webkit-scrollbar-track {
    background: var(--surface-2);
    border-radius: 5px;
  }
  .scroll::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 5px;
  }
  @supports (-moz-appearance: none) {
    .scroll {
      scrollbar-color: var(--border-strong) var(--surface-2);
    }
  }
  .more {
    color: var(--text-muted);
  }
  table {
    border-collapse: separate;
    border-spacing: 2px;
  }
  th,
  td {
    padding: 0;
    text-align: center;
  }
  .cell {
    min-width: 40px;
    max-width: 180px;
    height: 32px;
    padding: 0 4px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .rm {
    width: 24px;
    height: 24px;
    min-height: 0;
    padding: 0;
    color: var(--text-muted);
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .hint {
    margin: 0;
  }
  /* A phone: every column of a 7-note row fits in 375 px. Rows are removed with "− Row n" in the
     toolbar (the current cell's row), so the column of row × buttons goes; no inner padding. */
  @media (max-width: 600px) {
    .rowx {
      display: none;
    }
    .scroll {
      padding: 0;
      scroll-padding-inline: 32px;
    }
    .scroll-wrap::before,
    .scroll-wrap::after {
      width: 24px;
    }
  }
  @media (pointer: coarse) {
    .cell {
      min-width: 44px;
      height: 44px;
      font-size: 16px;
    }
    .rm,
    .tools .btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
