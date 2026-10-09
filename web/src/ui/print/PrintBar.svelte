<!-- W4 — print bar: copies, cut each, chain, mirror, leader note, Print button (disabled with
     the reason), progress by page/phase, cancel. Sticky at the bottom of the window.
     P1 (docs/STUDIO-V1-PLAN.md): with a batch, "Print 25 labels" (copies are per label), the
     tape estimate from BatchMeasure ("≈ … (estimated)" until every label was measured), a clear
     "Cut each" (full cut; no half cut) and "Preparing label 12 of 25" while the batch renders.
     Without a batch it behaves exactly as before. -->
<script lang="ts">
  import { tick } from 'svelte'
  import Icon from '../common/Icon.svelte'
  import Switch from '../common/Switch.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { MAX_COPIES } from '../../render'
  import { clampCopies, modKey, printButtonText, progressFraction, progressText } from '../state/view-model'
  import { batchMeasure } from '../batch/batch-measure.svelte'
  import { batchBlocker } from '../batch/batch-job'
  import { batchPrintText, batchTape, formatTape, singleTapeNote } from '../batch/batch-model'

  const studio = getStudio()
  const print = $derived(studio.doc.print)
  const copies = $derived(print.copies)
  const caps = $derived(studio.modelInfo?.caps)
  const busy = $derived(studio.printing || studio.conn.state === 'printing' || studio.conn.state === 'cancelling')
  const measure = batchMeasure(studio)
  /** Labels of the batch (0 = a plain label). */
  const batchN = $derived(studio.batchCount)
  const batchProblem = $derived.by(() => {
    if (batchN === 0) return null
    const why = batchBlocker(studio.doc)
    if (why) return why
    const [row, message] = measure.problems[0] ?? []
    return row !== undefined ? `Label ${row + 1} can’t be printed: ${message}` : null
  })
  const reason = $derived(studio.printBlocked ?? batchProblem)
  const singleNote = $derived(studio.render ? singleTapeNote(studio.render.lengthMm, studio.render.feedMarginMm, copies, studio.tapeLeader) : null)
  const batchTapeUse = $derived(
    batchN > 0 ? batchTape(measure.lengths, batchN, copies, measure.feedMarginMm || (studio.render?.feedMarginMm ?? 0), studio.tapeLeader, studio.render?.lengthMm ?? 0) : null,
  )
  const batchNote = $derived.by(() => {
    const t = batchTapeUse
    if (!t) return null
    const what = `${batchN} ${batchN === 1 ? 'label' : 'labels'}${copies > 1 ? ` × ${copies}` : ''} in one job`
    return `${what}: uses ${t.exact ? '' : 'about '}${formatTape(t.totalMm)} of tape${studio.tapeLeader ? ' incl. the ~24 mm leader' : ''}${t.exact ? '' : ' (estimated)'}.`
  })
  const preparing = $derived(studio.batchProgress)
  const halfCut = $derived(caps?.halfCut === true)
  const mod = modKey(studio.isMac ? 'mac' : 'other')
  let barH = $state(72)
  let optionsOpen = $state(false)

  $effect(() => {
    document.documentElement.style.setProperty('--printbar-h', `${barH}px`)
  })

  const set = (patch: Partial<typeof print>) => studio.updateDoc({ print: { ...print, ...patch } })

  // Keyboard focus follows the print: Print is disabled while busy, so focus moves to Cancel,
  // and back to Print when the job ends (only if focus was in the bar, i.e. would be lost).
  let footer: HTMLElement | undefined = $state()
  let cancelBtn: HTMLButtonElement | undefined = $state()
  let printBtn: HTMLButtonElement | undefined = $state()
  let wasBusy = false
  let focusInBar = false
  $effect(() => {
    const now = busy
    if (now === wasBusy) return
    wasBusy = now
    const active = document.activeElement
    const lost = !active || active === document.body || (!!footer && footer.contains(active))
    if (now) focusInBar = lost
    if (!lost && !focusInBar) return
    void tick().then(() => {
      if (now) cancelBtn?.focus()
      else {
        // Print may now be disabled (a problem): keep focus in the bar rather than on <body>.
        if (printBtn && !printBtn.disabled) printBtn.focus()
        else footer?.focus()
        focusInBar = false
      }
    })
  })
</script>

<footer class="printbar" bind:clientHeight={barH} bind:this={footer} aria-label="Print" tabindex="-1">
  {#if busy}
    <div class="progress">
      <div class="progress-text" role="status" aria-live="polite">
        <span class="spin"><Icon name="printer" size={18} /></span>
        <strong>{studio.conn.state === 'cancelling' ? 'Cancelling…' : preparing ? `Preparing label ${Math.min(preparing.total, preparing.done + 1)} of ${preparing.total}…` : progressText(studio.conn.progress)}</strong>
      </div>
      {#if preparing}
        <div class="bar" role="progressbar" aria-label="Print progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((preparing.done / Math.max(1, preparing.total)) * 100)}>
          <span style:width="{Math.max(4, (preparing.done / Math.max(1, preparing.total)) * 100)}%"></span>
        </div>
      {:else}
        <div class="bar" role="progressbar" aria-label="Print progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressFraction(studio.conn.progress) * 100)}>
          <span style:width="{Math.max(4, progressFraction(studio.conn.progress) * 100)}%"></span>
        </div>
      {/if}
      <!-- Nothing is sent while a batch is being prepared, so there is nothing to cancel yet. -->
      <button type="button" class="btn" bind:this={cancelBtn} aria-disabled={studio.conn.state === 'cancelling'} onclick={() => studio.conn.state !== 'cancelling' && studio.cancelPrint()}><Icon name="stop" size={16} />Cancel</button>
    </div>
  {:else}
    <button type="button" class="btn small options-toggle" aria-expanded={optionsOpen} aria-controls="print-options" onclick={() => (optionsOpen = !optionsOpen)}>
      <Icon name="settings" size={16} />{batchN > 0 ? `${batchN} × ${copies === 1 ? '1 copy' : `${copies} copies`}` : copies === 1 ? '1 copy' : `${copies} copies`}<Icon name={optionsOpen ? 'chevron-down' : 'chevron-up'} size={14} />
    </button>
    <div class="options" id="print-options" class:open={optionsOpen}>
      <div class="copies" role="group" aria-labelledby="copies-label">
        <span id="copies-label" class="field-label">{batchN > 0 ? 'Copies of each' : 'Copies'}</span>
        <div class="stepper">
          <button type="button" class="btn icon small" aria-label="Fewer copies" disabled={copies <= 1} onclick={() => studio.setCopies(copies - 1)}><Icon name="minus" size={14} /></button>
          <input
            class="input"
            type="number"
            min="1"
            max={MAX_COPIES}
            inputmode="numeric"
            aria-labelledby="copies-label"
            value={copies}
            onchange={(e) => studio.setCopies(clampCopies(Number(e.currentTarget.value)))}
          />
          <button type="button" class="btn icon small" aria-label="More copies" disabled={copies >= MAX_COPIES} onclick={() => studio.setCopies(copies + 1)}><Icon name="plus" size={14} /></button>
        </div>
      </div>
      {#if caps?.autoCut !== false}
        {#if batchN > 0}
          <Switch
            label="Cut each"
            checked={print.autoCut}
            onchange={(autoCut) => set({ autoCut })}
            hint={print.autoCut ? `Full cut after every label${halfCut ? '' : ' (this printer has no half cut)'}.` : 'Off: one strip; cut the labels apart yourself.'}
          />
        {:else}
          <Switch label="Cut each" checked={print.autoCut} onchange={(autoCut) => set({ autoCut })} />
        {/if}
      {/if}
      {#if caps?.chain !== false}
        <span title="Saves tape: the last label stays in the printer until the next print"><Switch label="Chain" checked={print.chain} onchange={(chain) => set({ chain })} /></span>
      {/if}
      <Switch label="Mirror" checked={print.mirror} onchange={(mirror) => set({ mirror })} />
      <p class="note">
        {#if batchNote}
          {batchNote}
        {:else if singleNote}{singleNote}{/if}
      </p>
    </div>
  {/if}

  <div class="go">
    {#if reason && !busy}
      <p class="reason" id="print-reason">{reason}</p>
    {/if}
    <button
      bind:this={printBtn}
      type="button"
      class="btn primary print"
      disabled={!!reason || busy}
      aria-describedby={reason && !busy ? 'print-reason' : undefined}
      title={reason ?? `Print (${mod}+P)`}
      onclick={() => void studio.print()}
    >
      <Icon name="printer" />{batchN > 0 ? batchPrintText(batchN, copies) : printButtonText(copies)}
    </button>
  </div>
</footer>

<style>
  .printbar:focus {
    outline: none;
  }
  .printbar {
    position: sticky;
    bottom: 0;
    z-index: 15;
    display: flex;
    align-items: center;
    gap: var(--space-3) var(--space-5);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    backdrop-filter: blur(8px);
    border-top: 1px solid var(--border);
    box-shadow: 0 -4px 16px rgb(16 24 40 / 6%);
  }
  .options {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    min-width: 0;
  }
  .copies {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .stepper .input {
    width: 54px;
    min-height: 30px;
    text-align: center;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .stepper .input::-webkit-inner-spin-button {
    display: none;
  }
  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .go {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-left: auto;
    min-width: 0;
  }
  .reason {
    margin: 0;
    max-width: 340px;
    color: var(--text-muted);
    font-size: 13px;
    text-align: right;
  }
  .print {
    min-height: 44px;
    padding: 0 var(--space-5);
    font-size: 15px;
    border-radius: var(--radius-m);
  }
  .progress {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .progress-text {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    white-space: nowrap;
  }
  .spin {
    display: flex;
    color: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .bar {
    flex: 1;
    height: 8px;
    min-width: 80px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 400ms var(--ease);
  }
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }
  .options-toggle {
    display: none;
  }
  /* Phones, also in landscape (667–932 px wide but only ~340–430 px tall): the options fold
     behind the "1 copy" toggle so the sticky bar never covers the editor. */
  @media (max-width: 640px), (max-height: 500px) {
    .printbar {
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
    }
    .options-toggle {
      display: inline-flex;
    }
    .options {
      display: none;
      order: 3;
      width: 100%;
      flex-basis: 100%;
      padding-top: var(--space-2);
      border-top: 1px solid var(--border);
    }
    .options.open {
      display: flex;
    }
    .go {
      flex: 1;
      justify-content: flex-end;
    }
    .reason {
      max-width: 42vw;
      font-size: 12px;
      line-height: 1.3;
    }
    .print {
      min-height: 40px;
      padding: 0 var(--space-4);
    }
  }
</style>
