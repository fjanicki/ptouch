<!-- P4 (docs/STUDIO-V1-PLAN.md) — print history (last 50 labels: thumbnail, date, tape, copies;
     reprint / open; clear) and the tape usage counter (studio.usage, resettable). Open while
     studio.dialog === 'history'.
     "Open" reopens the label as printed: as itself when the library still holds that version
     (or no longer holds the label), else as a copy, so later edits are never overwritten. -->
<script lang="ts">
  import { tick } from 'svelte'
  import type { PrintRecord } from '../../doc/persist-history'
  import { usageRows } from '../../doc/persist-usage'
  import { newId, type LabelDoc } from '../../doc/schema'
  import Icon from '../common/Icon.svelte'
  import Modal from '../common/Modal.svelte'
  import { errorMessage, getStudio } from '../state/studio.svelte'
  import { formatTape } from '../batch/batch-model'

  const studio = getStudio()
  const open = $derived(studio.dialog === 'history')
  let records = $state<PrintRecord[] | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  const rows = $derived(usageRows(studio.usage))
  const totalMm = $derived(rows.reduce((s, r) => s + r.entry.mm, 0))

  $effect(() => {
    if (open) void refresh()
  })

  async function refresh(): Promise<void> {
    try {
      error = null
      records = await studio.printHistory.list()
    } catch (e) {
      error = errorMessage(e)
      records = []
    }
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  function when(iso: string, fmt = dateFmt): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : fmt.format(d)
  }

  function labelsText(r: PrintRecord): string {
    if (r.batchRows !== undefined) return `${r.batchRows} batch ${r.batchRows === 1 ? 'label' : 'labels'}${r.copies > 1 ? ` × ${r.copies}` : ''}`
    return r.labels === 1 ? '1 label' : `${r.labels} labels`
  }

  /** Same design (timestamps aside)? */
  function sameDesign(a: LabelDoc, b: LabelDoc): boolean {
    const strip = (d: LabelDoc) => JSON.stringify({ ...d, createdAt: '', updatedAt: '' })
    return strip(a) === strip(b)
  }

  /** Opens the printed label; resolves false when nothing could be opened. */
  async function openRecord(r: PrintRecord): Promise<boolean> {
    try {
      await studio.autosave.flush().catch(() => {})
      if (studio.doc.id === r.doc.id && sameDesign(studio.doc, r.doc)) return true
      const saved = await studio.store.load(r.doc.id).catch(() => undefined)
      if (!saved || sameDesign(saved.doc, r.doc)) {
        studio.openDoc(saved?.doc ?? r.doc)
        studio.announce(`Opened “${r.name}”`)
      } else {
        // The label changed since this print: open the printed version as a new copy.
        const now = new Date().toISOString()
        studio.openDoc({ ...structuredClone(r.doc), id: newId(), name: `${r.doc.name} (printed ${when(r.printedAt, dayFmt)})`, createdAt: now, updatedAt: now })
        studio.toast('info', 'Opened as a copy', 'The label was changed after this print, so the printed version opens as a new label.')
      }
      return true
    } catch (e) {
      studio.toast('error', 'Could not open the label', errorMessage(e))
      return false
    }
  }

  async function reopen(r: PrintRecord): Promise<void> {
    if (await openRecord(r)) studio.closeDialog()
  }

  async function reprint(r: PrintRecord): Promise<void> {
    if (busy) return
    busy = true
    try {
      if (!(await openRecord(r))) return
      await tick() // the studio schedules the render of the reopened label
      studio.closeDialog()
      // Let that render land first, so the print gate judges the reopened label (bounded).
      const end = performance.now() + 10_000
      while (studio.rendering && performance.now() < end) await new Promise((r) => setTimeout(r, 16))
      // An image of the printed label is gone (e.g. removed from this browser's storage): never
      // reprint without it. The label stays open so it can be added again.
      if (studio.render?.warnings.some((w) => w.code === 'image-missing')) {
        studio.toast('error', 'Not reprinted', 'An image of this label is no longer available. The label is open: add the image again, then print.')
        return
      }
      await studio.print()
      if (studio.printBlocked && !studio.printing) studio.toast('info', 'Can’t print yet', studio.printBlocked)
    } finally {
      busy = false
    }
  }

  async function remove(r: PrintRecord): Promise<void> {
    try {
      await studio.printHistory.remove(r.id)
      await refresh()
      studio.announce(`Removed “${r.name}” from the history`)
    } catch (e) {
      error = errorMessage(e)
    }
  }

  async function clearAll(): Promise<void> {
    if (!confirm('Clear the whole print history? Your saved labels are not affected.')) return
    try {
      await studio.printHistory.clear()
      await refresh()
      studio.announce('Print history cleared')
    } catch (e) {
      error = errorMessage(e)
    }
  }

  function resetCounter(): void {
    if (!confirm('Reset the tape usage counter to zero?')) return
    studio.resetUsage()
    studio.announce('Tape usage counter reset')
  }
</script>

<Modal {open} title="Print history" size="l" description="Labels printed from this browser, newest first." onclose={() => studio.closeDialog()}>
  <section class="usage" aria-labelledby="usage-title">
    <div class="head">
      <h3 id="usage-title">Tape used</h3>
      <button type="button" class="btn small" disabled={rows.length === 0} onclick={resetCounter}>Reset counter</button>
    </div>
    {#if rows.length === 0}
      <p class="hint">Nothing printed since {when(studio.usage.since, dayFmt)}.</p>
    {:else}
      <table>
        <caption class="visually-hidden">Tape used per tape width since {when(studio.usage.since, dayFmt)}</caption>
        <thead><tr><th scope="col">Tape</th><th scope="col">Used</th><th scope="col">Labels</th><th scope="col">Jobs</th></tr></thead>
        <tbody>
          {#each rows as r (r.widthMm)}
            <tr><th scope="row">{r.widthMm} mm</th><td>{formatTape(r.entry.mm)}</td><td>{r.entry.labels}</td><td>{r.entry.jobs}</td></tr>
          {/each}
        </tbody>
      </table>
      <p class="hint">{formatTape(totalMm)} in total since {when(studio.usage.since, dayFmt)}, leaders included (about 24 mm per job).</p>
    {/if}
  </section>

  <section aria-labelledby="history-title">
    <div class="head">
      <h3 id="history-title">Printed labels</h3>
      <button type="button" class="btn small" disabled={!records?.length} onclick={() => void clearAll()}><Icon name="trash" size={14} />Clear history</button>
    </div>
    {#if error}<p class="hint error" role="alert">{error}</p>{/if}
    {#if records === null}
      <p class="empty">Loading…</p>
    {:else if records.length === 0}
      <p class="empty">Labels you print show up here, so you can print them again in one click. The last 50 are kept.</p>
    {:else}
      <ul class="list" aria-label="Printed labels">
        {#each records as r (r.id)}
          <li>
            <span class="thumb">{#if r.thumbUrl}<img src={r.thumbUrl} alt="" />{:else}<Icon name="tag" size={22} />{/if}</span>
            <span class="meta">
              <strong>{r.name}</strong>
              <span>{when(r.printedAt)}</span>
              <span>{r.tapeWidthMm} mm tape · {labelsText(r)} · {formatTape(r.tapeMm)}</span>
            </span>
            <span class="actions">
              <button type="button" class="btn small" aria-label="Open {r.name}" onclick={() => void reopen(r)}>Open</button>
              {#if !studio.designOnly}
                <button type="button" class="btn small primary" aria-label="Reprint {r.name}" disabled={busy || studio.printing} onclick={() => void reprint(r)}><Icon name="printer" size={14} />Reprint</button>
              {/if}
              <button type="button" class="btn ghost icon small" aria-label="Remove {r.name} from the history" onclick={() => void remove(r)}><Icon name="x" size={16} /></button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</Modal>

<style>
  section + section {
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    max-width: 420px;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: var(--space-1) var(--space-2) var(--space-1) 0;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  thead th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 13px;
  }
  .empty {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    padding: var(--space-2);
  }
  .thumb {
    flex: none;
    display: grid;
    place-items: center;
    width: 96px;
    height: 40px;
    border-radius: var(--radius-s);
    background: var(--canvas-bg);
    color: var(--text-muted);
    overflow: hidden;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
  }
  .meta {
    flex: 1;
    min-width: 10em;
    display: grid;
    gap: 2px;
  }
  .meta strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta span {
    color: var(--text-muted);
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-left: auto;
  }
</style>
