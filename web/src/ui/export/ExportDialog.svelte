<!-- P4 (docs/STUDIO-V1-PLAN.md) — export the exact print bitmap (studio.render.bitmap) as PNG
     (1-bit, 180 dpi pHYs) or PDF (true physical size). Open while studio.dialog === 'export'.
     The bitmap is cloned while it is encoded (the preview may re-render meanwhile). -->
<script lang="ts">
  import { FILE_EXTENSION, downloadBytes, labelFileName } from '../../doc/persist-files'
  import { mmToDots } from '../../render/units'
  import { exportPdf, exportPng, pdfPageMm } from '../../render/export'
  import Icon from '../common/Icon.svelte'
  import Modal from '../common/Modal.svelte'
  import { errorMessage, getStudio } from '../state/studio.svelte'
  import { formatMm } from '../state/view-model'

  const studio = getStudio()
  let busy = $state<'png' | 'pdf' | null>(null)
  let status = $state('')

  const render = $derived(studio.render)
  const area = $derived(studio.target.ok ? studio.target.target.area : null)
  const ready = $derived(!!render && !!area && render.lengthDots > 0 && !studio.renderError)
  const marginDots = $derived(render && area ? mmToDots(render.feedMarginMm, area.dpi) : 0)
  const pageMm = $derived(render && area ? pdfPageMm({ length: render.lengthDots }, { dpi: area.dpi, tapeWidthDots: area.tapeWidthDots, marginDots }) : null)

  /** "52.3" (formatMm without the unit). */
  const num = (mm: number, digits = 1): string => formatMm(mm, digits).slice(0, -3)

  /** "cable-tags", "cable-tags-3" for batch label 3. */
  function baseName(): string {
    const slug = labelFileName(studio.doc.name).slice(0, -FILE_EXTENSION.length)
    return studio.batchCount > 0 ? `${slug}-${studio.previewRow + 1}` : slug
  }

  async function save(kind: 'png' | 'pdf'): Promise<void> {
    const r = studio.render
    const a = area
    if (!r || !a || busy) return
    busy = kind
    const bitmap = r.bitmap.clone()
    try {
      const blob =
        kind === 'png'
          ? await exportPng(bitmap, { dpi: a.dpi })
          : await exportPdf(bitmap, { dpi: a.dpi, tapeWidthDots: a.tapeWidthDots, marginDots: mmToDots(r.feedMarginMm, a.dpi), title: studio.doc.name })
      const name = `${baseName()}.${kind}`
      downloadBytes(blob, name, blob.type)
      status = `Saved ${name}`
      studio.announce(status)
    } catch (e) {
      studio.toast('error', `Could not export the ${kind.toUpperCase()}`, errorMessage(e))
    } finally {
      bitmap.free()
      busy = null
    }
  }
</script>

<Modal open={studio.dialog === 'export'} title="Export image" description="The exact dots that are printed, as an image file." onclose={() => studio.closeDialog()}>
  {#if !ready || !render || !area}
    <p class="hint" role="status">{studio.renderError ? `The label cannot be drawn: ${studio.renderError}` : 'The preview is still being prepared…'}</p>
  {:else}
    <dl class="facts">
      <div><dt>Printed area</dt><dd>{num((render.lengthDots * 25.4) / area.dpi)} × {formatMm((render.heightDots * 25.4) / area.dpi)} ({render.lengthDots} × {render.heightDots} dots)</dd></div>
      <div><dt>Resolution</dt><dd>{area.dpi} dpi (1 dot = {formatMm(25.4 / area.dpi, 3)})</dd></div>
      {#if pageMm}<div><dt>Cut label</dt><dd>{num(pageMm[0])} × {formatMm(pageMm[1])} on {studio.doc.tape.widthMm} mm tape</dd></div>{/if}
    </dl>
    {#if studio.batchCount > 0}
      <p class="hint note"><Icon name="table" size={14} />This label has a batch: the export shows label {studio.previewRow + 1} of {studio.batchCount}, the one in the preview.</p>
    {/if}
    <div class="choices">
      <button type="button" class="choice" disabled={busy !== null} onclick={() => void save('png')}>
        <Icon name="image" size={22} />
        <span><strong>{busy === 'png' ? 'Saving PNG…' : 'Download PNG'}</strong><span>Black and white image of the printed area. Opens at real size ({area.dpi} dpi).</span></span>
      </button>
      <button type="button" class="choice" disabled={busy !== null} onclick={() => void save('pdf')}>
        <Icon name="download" size={22} />
        <span><strong>{busy === 'pdf' ? 'Saving PDF…' : 'Download PDF'}</strong><span>The whole label at true size, tape width included. Print it at 100 % to check the size.</span></span>
      </button>
    </div>
  {/if}
  <p class="visually-hidden" role="status">{status}</p>
</Modal>

<style>
  .facts {
    display: grid;
    gap: var(--space-1);
    margin: 0 0 var(--space-3);
  }
  .facts div {
    display: grid;
  }
  dt {
    color: var(--text-muted);
    font-size: 13px;
  }
  dd {
    margin: 0;
  }
  .note {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .choices {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-m);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .choice:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .choice:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .choice :global(svg) {
    flex: none;
    color: var(--accent);
  }
  .choice > span {
    display: grid;
    gap: 2px;
  }
  .choice > span > span {
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
