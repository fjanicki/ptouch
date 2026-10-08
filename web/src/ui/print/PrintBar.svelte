<!-- W4 — print bar: copies, cut each, chain, mirror, leader note, Print button (disabled with
     the reason), progress by page/phase, cancel. Sticky at the bottom of the window. -->
<script lang="ts">
  import { tick } from 'svelte'
  import Icon from '../common/Icon.svelte'
  import Switch from '../common/Switch.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { MAX_COPIES } from '../../render'
  import { clampCopies, formatMm, modKey, printButtonText, progressFraction, progressText } from '../state/view-model'

  const studio = getStudio()
  const print = $derived(studio.doc.print)
  const copies = $derived(print.copies)
  const caps = $derived(studio.modelInfo?.caps)
  const busy = $derived(studio.printing || studio.conn.state === 'printing' || studio.conn.state === 'cancelling')
  const reason = $derived(studio.printBlocked)
  const tapeUse = $derived(studio.render ? copies * (studio.render.lengthMm + 2 * studio.render.feedMarginMm) : null)
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
        <strong>{studio.conn.state === 'cancelling' ? 'Cancelling…' : progressText(studio.conn.progress)}</strong>
      </div>
      <div class="bar" role="progressbar" aria-label="Print progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressFraction(studio.conn.progress) * 100)}>
        <span style:width="{Math.max(4, progressFraction(studio.conn.progress) * 100)}%"></span>
      </div>
      <button type="button" class="btn" bind:this={cancelBtn} aria-disabled={studio.conn.state === 'cancelling'} onclick={() => studio.conn.state !== 'cancelling' && studio.cancelPrint()}><Icon name="stop" size={16} />Cancel</button>
    </div>
  {:else}
    <button type="button" class="btn small options-toggle" aria-expanded={optionsOpen} aria-controls="print-options" onclick={() => (optionsOpen = !optionsOpen)}>
      <Icon name="settings" size={16} />{copies === 1 ? '1 copy' : `${copies} copies`}<Icon name={optionsOpen ? 'chevron-down' : 'chevron-up'} size={14} />
    </button>
    <div class="options" id="print-options" class:open={optionsOpen}>
      <div class="copies" role="group" aria-labelledby="copies-label">
        <span id="copies-label" class="field-label">Copies</span>
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
        <Switch label="Cut each" checked={print.autoCut} onchange={(autoCut) => set({ autoCut })} />
      {/if}
      {#if caps?.chain !== false}
        <span title="Saves tape: the last label stays in the printer until the next print"><Switch label="Chain" checked={print.chain} onchange={(chain) => set({ chain })} /></span>
      {/if}
      <Switch label="Mirror" checked={print.mirror} onchange={(mirror) => set({ mirror })} />
      <p class="note">
        {#if tapeUse !== null}Uses about {formatMm(tapeUse, 0)} of tape{print.chain ? '' : ' plus a ~24 mm leader once'}.{/if}
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
      <Icon name="printer" />{printButtonText(copies)}
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
  @media (max-width: 640px) {
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
