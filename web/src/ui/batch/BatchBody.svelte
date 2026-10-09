<!-- P1 (docs/STUDIO-V1-PLAN.md) — the expanded part of the batch panel: data table (paste
     text/CSV or type rows), counters, date format, per-row preview grid, row cap message, tape
     estimate. A separate chunk that BatchPanel loads on first expand (entry-chunk budget). -->
<script lang="ts">
  import { tick } from 'svelte'
  import { LIMITS, type BatchData, type DateFormat } from '../../doc/schema'
  import { parseTable } from '../../doc/csv'
  import { missingVariables } from '../../doc/variables'
  import Icon from '../common/Icon.svelte'
  import NumberField from '../common/NumberField.svelte'
  import Switch from '../common/Switch.svelte'
  import { getStudio } from '../state/studio.svelte'
  import BatchCounters from './BatchCounters.svelte'
  import BatchPreviews from './BatchPreviews.svelte'
  import BatchTable from './BatchTable.svelte'
  import type { BatchMeasure } from './batch-measure.svelte'
  import { DATE_FORMATS, addColumn, batchOf, batchTape, clampRow, dateExamples, dateFormatLabel, emptyUsedCells, formatTape, replaceTable } from './batch-model'
  import { copiesOf } from '../../render'
  import { BATCH_PANEL_ID } from './panel-state.svelte'

  let { id, measure }: { id: string; measure: BatchMeasure } = $props()

  /** Largest file "Open CSV file…" reads (500 rows × 20 columns of text fit easily). */
  const MAX_FILE_BYTES = 2 * 1024 * 1024

  const studio = getStudio()

  const doc = $derived(studio.doc)
  const batch = $derived(batchOf(doc))
  const total = $derived(studio.batchCount)
  const missing = $derived(missingVariables(doc))
  const emptyCells = $derived(emptyUsedCells(doc).size)
  const rowsInData = $derived(Math.max(batch.rows.length, 1))
  const now = new Date()

  let pasted = $state('')
  let notices = $state<string[]>([])
  let fileInput: HTMLInputElement | undefined = $state()

  const save = (b: BatchData, key?: string) => studio.updateDoc({ batch: b }, key)

  // Notices belong to the label they were made for.
  let lastId = ''
  $effect(() => {
    if (doc.id === lastId) return
    lastId = doc.id
    notices = []
  })

  const tape = $derived(
    total > 0 ? batchTape(measure.lengths, total, copiesOf(doc), measure.feedMarginMm || (studio.render?.feedMarginMm ?? 0), studio.tapeLeader, studio.render?.lengthMm ?? 0) : null,
  )

  function load(text: string) {
    const t = parseTable(text)
    notices = t.notices
    if (!t.columns.length) return
    save({ ...replaceTable(batch, t.columns, t.rows), enabled: true })
    pasted = ''
    studio.previewRow = 0
    studio.announce(`Loaded ${t.rows.length} ${t.rows.length === 1 ? 'row' : 'rows'} with ${t.columns.length} ${t.columns.length === 1 ? 'column' : 'columns'}: ${t.columns.join(', ')}`)
  }

  async function openFile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      notices = [`“${file.name}” is too large (over 2 MB). A batch holds at most ${LIMITS.batchRows} rows.`]
      return
    }
    try {
      load(await file.text())
    } catch {
      notices = [`“${file.name}” could not be read.`]
    }
  }

  /** An empty one-column table to type into; its column name is selected for renaming. */
  async function newTable() {
    save({ ...addColumn(batch), enabled: true })
    await tick()
    const name = document.querySelector<HTMLInputElement>(`#${BATCH_PANEL_ID} [data-col="0"]`)
    name?.focus()
    name?.select()
  }

  function clearData() {
    save({ ...batch, columns: [], rows: [] })
    notices = []
    studio.announce('Data table cleared')
  }

  function step(delta: number) {
    const row = clampRow(doc, studio.previewRow + delta)
    studio.previewRow = row
    studio.announce(`Previewing label ${row + 1} of ${Math.max(total, rowsInData)}`)
  }
</script>

  <div class="body" id="{id}-body">
    <p class="hint intro">
      Write <code>{'{{name}}'}</code> in a text or code block, where <em>name</em> is a column of the data below. Each row prints one label, all in one job, so the ~24 mm leader is fed only once.
    </p>

    <Switch label="Print as a batch" checked={batch.enabled} onchange={(enabled) => save({ ...batch, enabled })} hint={batch.enabled ? `${total} ${total === 1 ? 'label' : 'labels'}${batch.rows.length ? ', one per row' : ''}.` : 'Off: Print makes one label showing the row below.'} />

    {#if missing.length}
      <div class="missing" role="status">
        <p>
          <Icon name="alert" size={14} />
          <strong>{missing.length === 1 ? 'Unknown variable' : 'Unknown variables'}:</strong>
          {#each missing as m, k (m)}<code>{`{{${m}}}`}</code>{k < missing.length - 1 ? ', ' : ''}{/each}. {missing.length === 1 ? 'It prints' : 'They print'} as written. Add a column or counter with that name, or fix the spelling.
        </p>
        <div class="fixes">
          {#each missing.filter((m) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(m)) as m (m)}
            <button type="button" class="btn small" disabled={batch.columns.length >= LIMITS.batchColumns} onclick={() => save(addColumn(batch, m))}><Icon name="plus" size={14} />Column {m}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if total > 1 || batch.rows.length > 1}
      <div class="stepper" role="group" aria-label="Previewed label">
        <button type="button" class="btn icon small" aria-label="Previous label" disabled={studio.previewRow <= 0} onclick={() => step(-1)}><Icon name="chevron-left" size={16} /></button>
        <span class="which">Preview: label {studio.previewRow + 1} of {Math.max(total, batch.rows.length)}</span>
        <button type="button" class="btn icon small" aria-label="Next label" disabled={studio.previewRow >= Math.max(total, batch.rows.length) - 1} onclick={() => step(1)}><Icon name="chevron-right" size={16} /></button>
      </div>
    {/if}

    <div class="section">
      <h3>Data</h3>
      {#if batch.columns.length}
        <BatchTable {batch} />
        {#if emptyCells}
          <p class="hint error"><Icon name="alert" size={12} />{emptyCells} {emptyCells === 1 ? 'cell is' : 'cells are'} empty in columns the label uses.</p>
        {/if}
      {:else}
        <p class="hint">No data yet. Paste a table or open a CSV file (its first row names the columns), or type one.</p>
        <div class="row">
          <button type="button" class="btn small" onclick={() => void newTable()}><Icon name="table" size={14} />New table</button>
        </div>
      {/if}

      <details class="paste" open={!batch.columns.length}>
        <summary>{batch.columns.length ? 'Replace with pasted data…' : 'Paste data'}</summary>
        <label class="field-label" for="{id}-paste">Paste from a spreadsheet or CSV (first row = column names)</label>
        <textarea id="{id}-paste" class="textarea mono" rows="4" placeholder={'name,room\nAda,Lab 1\nGrace,Lab 2'} bind:value={pasted}></textarea>
        <div class="row">
          <button type="button" class="btn small primary" disabled={!pasted.trim()} onclick={() => load(pasted)}>Use pasted data</button>
        </div>
      </details>
      <div class="row">
        <button type="button" class="btn small" onclick={() => fileInput?.click()}><Icon name="upload" size={14} />Open CSV file…</button>
        <input bind:this={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden onchange={(e) => void openFile(e)} />
        {#if batch.columns.length}
          <button type="button" class="btn small ghost danger" onclick={clearData}><Icon name="trash" size={14} />Clear data</button>
        {/if}
      </div>
      {#if notices.length}
        <ul class="notices" role="status">
          {#each notices as n (n)}<li>{n}</li>{/each}
        </ul>
      {/if}
      {#if !batch.rows.length}
        <div class="count">
          <NumberField label="Labels to print (without data)" value={batch.count} min={LIMITS.batchCount.min} max={LIMITS.batchCount.max} onchange={(count) => save({ ...batch, count: Math.round(count) }, 'batch:count')} hint="With counters only, e.g. asset tags 0001–0050." />
        </div>
      {/if}
    </div>

    <div class="section">
      <h3>Counters</h3>
      <BatchCounters {batch} />
    </div>

    <div class="section">
      <h3>Dates</h3>
      <div class="field">
        <label class="field-label" for="{id}-date">Date format</label>
        <select id="{id}-date" class="select" value={batch.dateFormat} onchange={(e) => save({ ...batch, dateFormat: e.currentTarget.value as DateFormat })}>
          {#each DATE_FORMATS as f (f.value)}<option value={f.value}>{dateFormatLabel(f.value, now)}</option>{/each}
        </select>
      </div>
      <p class="hint">
        {#each dateExamples(batch, now) as ex, k (ex.name)}<code>{`{{${ex.name}}}`}</code> → {ex.value}{k === 0 ? '; ' : ''}{/each}. Also <code>{'{{today-7d}}'}</code>. Local time, the day you print.
      </p>
    </div>

    {#if total > 0}
      <div class="section">
        <h3>Labels</h3>
        <p class="summary" aria-live="polite">
          <strong>Labels: {total}</strong>
          {#if copiesOf(doc) > 1}× {copiesOf(doc)} copies{/if}
          {#if tape}· {tape.exact ? '' : '≈ '}{formatTape(tape.totalMm)} of tape{studio.tapeLeader ? ' incl. the leader' : ''}{tape.exact ? '' : ' (estimated)'}{/if}
        </p>
        {#if measure.problems.length}
          {@const [row, message] = measure.problems[0] ?? [0, '']}
          <p class="hint error"><Icon name="alert" size={12} />{measure.problems.length === 1 ? '1 label can’t' : `${measure.problems.length} labels can’t`} be printed. Label {row + 1}: {message}</p>
        {/if}
        {#if measure.notices.length}
          {@const [row, message] = measure.notices[0] ?? [0, '']}
          <p class="hint warn"><Icon name="alert" size={12} />{measure.notices.length === 1 ? '1 label doesn’t' : `${measure.notices.length} labels don’t`} print as designed. Label {row + 1}: {message}</p>
        {/if}
        <BatchPreviews {total} />
      </div>
    {/if}
  </div>

<style>
  .body {
    display: grid;
    gap: var(--space-4);
    padding: 0 var(--space-4) var(--space-4);
    min-width: 0;
  }
  .intro code,
  .hint code,
  .missing code,
  .mono {
    font-family: var(--font-mono);
  }
  .section {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 650;
  }
  .missing {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-m);
    background: var(--danger-soft);
    color: var(--text);
    font-size: 13px;
  }
  .missing p {
    margin: 0;
  }
  .missing :global(svg) {
    color: var(--danger);
    vertical-align: -2px;
  }
  .fixes,
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .paste {
    display: grid;
    gap: var(--space-2);
  }
  .paste summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    min-height: 28px;
    display: flex;
    align-items: center;
  }
  .paste[open] > :not(summary) {
    margin-top: var(--space-2);
  }
  .notices {
    margin: 0;
    padding-left: 1.2em;
    font-size: 12px;
    color: var(--warn);
  }
  .count {
    max-width: 260px;
  }
  .summary {
    margin: 0;
    font-size: 13px;
  }
  .hint :global(svg) {
    vertical-align: -2px;
    margin-right: 3px;
  }
  .danger {
    color: var(--danger);
  }
</style>
