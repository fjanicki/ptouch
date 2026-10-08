<!-- W4 — "Connect your printer" dialog (ARCHITECTURE.md §6.4): Bluetooth (default), Choose port…
     (unfiltered; always next to Bluetooth on Chromium), USB cable, No printer (virtual).
     Each option calls studio.connect(path) synchronously from its click handler (user gesture).
     Shows openProgress ("Waking printer… attempt 2 of 3"), the connected printer, and Problems. -->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { describeSupport, type ConnectPath } from '../../printer'
  import Icon from '../common/Icon.svelte'
  import ProblemBanner from '../common/ProblemBanner.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { batteryText, chipView, isConnected, openProgressText, tapeText, transportKindLabel } from '../state/view-model'

  const studio = getStudio()
  let dialog: HTMLDialogElement | undefined = $state()
  let content: HTMLDivElement | undefined = $state()
  let progressEl: HTMLDivElement | undefined = $state()
  let cardEl: HTMLDivElement | undefined = $state()

  $effect(() => {
    if (studio.connectOpen) {
      if (!dialog?.open) dialog?.showModal()
    } else if (dialog?.open) dialog.close()
  })

  const conn = $derived(studio.conn)
  const connecting = $derived(conn.state === 'opening' || conn.state === 'waking' || conn.state === 'handshaking')
  const connected = $derived(isConnected(conn.state))
  const gecko = $derived(studio.support.engine === 'gecko')
  const paths = $derived(studio.support.paths)
  const hasBluetooth = $derived(paths.includes('bluetooth'))
  const hasPort = $derived(paths.includes('serial-port'))
  const hasUsb = $derived(paths.includes('usb'))
  const usbFirst = $derived(paths[0] === 'usb')

  // Copy follows the paths this browser really offers (Firefox: ports only; Safari: none).
  const subtitle = $derived.by(() => {
    if (!studio.support.canPrint) return 'This browser can’t connect to printers. Use “No printer” to design and test with a virtual PT-P710BT.'
    const ways = [hasBluetooth ? 'Bluetooth' : hasPort ? 'its Bluetooth serial port' : null, hasUsb ? 'USB' : null].filter(Boolean)
    return `Brother PT-P710BT over ${ways.join(' or ')}. Nothing is installed and nothing leaves this browser.`
  })
  // Browser caveats (Firefox ports, Brave, Safari) shown up front, until dismissed.
  let supportDismissed = $state(false)
  const supportNote = $derived(supportDismissed ? null : describeSupport(studio.support))

  // Close shortly after a connection attempt started here succeeds.
  let attempted = $state(false)
  $effect(() => {
    if (attempted && conn.state === 'ready' && studio.connectOpen) {
      untrack(() => {
        attempted = false
        setTimeout(() => (studio.connectOpen = false), 900)
      })
    }
  })

  // Keep keyboard focus inside the dialog when its content swaps (the pressed option is
  // disabled while connecting, the progress block is replaced by the printer card or a problem).
  let phase = ''
  $effect(() => {
    const next = connecting ? 'connecting' : connected ? 'connected' : conn.problem ? 'problem' : 'idle'
    if (!studio.connectOpen) {
      phase = next
      return
    }
    const prev = phase
    phase = next
    if (prev === next || prev === '') return
    void tick().then(() => {
      if (next === 'connecting') progressEl?.focus()
      else if (next === 'connected') cardEl?.focus()
      else if (prev === 'connecting') {
        const target = content?.querySelector<HTMLElement>('.banner .btn.primary') ?? content?.querySelector<HTMLElement>('.banner .btn') ?? content?.querySelector<HTMLElement>('.option')
        target?.focus()
      }
    })
  })

  interface Option {
    path: ConnectPath
    title: string
    hint: string
    icon: string
    recommended?: boolean
  }
  const OPTIONS: Option[] = $derived([
    {
      path: 'bluetooth',
      title: 'Bluetooth',
      icon: 'bluetooth',
      recommended: !usbFirst,
      hint: gecko ? 'Pair the printer in system settings, then pick “cu.PT-P710BT…”.' : 'Pair the printer in system settings first, then pick “PT-P710BT…”.',
    },
    {
      path: 'serial-port',
      title: 'Choose port…',
      icon: 'cable',
      recommended: !hasBluetooth && !usbFirst,
      hint: hasBluetooth
        ? 'Shows every serial port. Pick “PT-P710BT…” or “cu.PT-P710BT…” if Bluetooth shows nothing.'
        : 'Pair the printer in system settings first, then pick “cu.PT-P710BT…” (macOS) or its COM port.',
    },
    { path: 'usb', title: 'USB cable', icon: 'usb', recommended: usbFirst, hint: 'Most reliable: answers instantly, no pairing or waking. Close P-touch Editor first.' },
    { path: 'virtual', title: 'No printer', icon: 'monitor', hint: 'Design and test with a virtual PT-P710BT.' },
  ])
  // Shown in the order support.paths recommends (USB first where it is the dependable path).
  const available = $derived(paths.flatMap((p) => OPTIONS.filter((o) => o.path === p)))

  function choose(path: ConnectPath) {
    attempted = true
    studio.connect(path) // synchronous: requestPort() runs inside this click
  }

  const progressHint = $derived.by(() => {
    if (conn.state === 'handshaking') return 'Reading the loaded tape and printer status.'
    if (conn.state === 'waking')
      return conn.openProgress && conn.openProgress.attempt > 1
        ? 'The first Bluetooth connection after the printer was idle often fails; trying again automatically.'
        : 'The printer may be asleep. The first Bluetooth connection can take up to 10 seconds, then it is retried automatically.'
    return conn.transport?.kind === 'virtual' ? 'Starting the virtual printer.' : `Opening the ${transportKindLabel(conn.transport?.kind).toLowerCase() || 'printer'} connection.`
  })
</script>

<dialog class="modal connect" bind:this={dialog} onclose={() => (studio.connectOpen = false)} aria-labelledby="connect-title" aria-describedby="connect-desc">
  <header>
    <div>
      <h2 id="connect-title">{connected ? 'Printer connected' : 'Connect your printer'}</h2>
      <p id="connect-desc" class="sub">
        {#if connected}
          {transportKindLabel(conn.transport?.kind)}{conn.transport?.label ? ` · ${conn.transport.label}` : ''}
        {:else}
          {subtitle}
        {/if}
      </p>
    </div>
    <button type="button" class="btn ghost icon" aria-label="Close" onclick={() => (studio.connectOpen = false)}><Icon name="x" /></button>
  </header>

  <div class="content" bind:this={content}>
    {#if conn.problem}
      <ProblemBanner problem={conn.problem} compact onaction={(a) => studio.handleProblemAction(a)} />
    {:else if supportNote && !connected && !connecting}
      <ProblemBanner problem={supportNote} compact onaction={() => (supportDismissed = true)} />
    {/if}

    {#if connecting}
      <div class="progress" tabindex="-1" bind:this={progressEl} aria-labelledby="connect-progress-text">
        <span class="spin" aria-hidden="true"><Icon name="loader" size={22} /></span>
        <div class="progress-body" role="status" aria-live="polite">
          <strong id="connect-progress-text">{conn.state === 'handshaking' ? 'Talking to the printer…' : openProgressText(conn.openProgress, conn.state)}</strong>
          <p class="hint">{progressHint}</p>
        </div>
        <button type="button" class="btn small" onclick={() => studio.cancelConnect()}>Cancel</button>
      </div>
    {:else if connected}
      {@const chip = chipView(conn)}
      <div class="printer-card" tabindex="-1" bind:this={cardEl} aria-label="Connected printer">
        <span class="printer-icon"><Icon name="printer" size={28} /></span>
        <div class="printer-info">
          <strong>{conn.model ?? 'Printer'}</strong>
          <dl>
            <dt>Tape</dt>
            <dd>{tapeText(conn) ?? 'No tape detected'}</dd>
            {#if batteryText(conn.status?.battery)}
              <dt>Power</dt>
              <dd>{batteryText(conn.status?.battery)}</dd>
            {/if}
            <dt>Status</dt>
            <dd class={chip.tone}>{conn.state === 'printing' ? 'Printing' : conn.status?.error ? 'Needs attention' : 'Ready'}</dd>
          </dl>
        </div>
      </div>
      <div class="row-actions">
        <button type="button" class="btn" disabled={conn.state !== 'ready'} onclick={() => void studio.connection.refreshStatus().catch(() => {})}><Icon name="refresh" size={16} />Refresh status</button>
        <button type="button" class="btn" disabled={conn.state === 'printing'} onclick={() => studio.disconnect()}><Icon name="eject" size={16} />Disconnect</button>
        {#if conn.transport?.kind !== 'virtual'}
          <button type="button" class="btn ghost danger" disabled={conn.state === 'printing'} onclick={() => studio.disconnect(true)}>Forget printer</button>
        {/if}
      </div>
    {/if}

    {#if !connected}
      <ul class="options" aria-label="Connection type">
        {#each available as o (o.path)}
          <li>
            <button type="button" class="option" class:recommended={o.recommended} disabled={connecting} onclick={() => choose(o.path)}>
              <span class="opt-icon"><Icon name={o.icon} size={22} /></span>
              <span class="opt-text">
                <span class="opt-title">{o.title}{#if o.recommended}<span class="badge">Recommended</span>{/if}</span>
                <span class="opt-hint">{o.hint}</span>
              </span>
              <Icon name="chevron-right" size={18} />
            </button>
          </li>
        {/each}
      </ul>

      {#if hasBluetooth || hasPort}
        <details class="help">
          <summary>First time? How to pair the printer</summary>
          <ol>
            <li>Turn the printer on and press its Bluetooth button until the Bluetooth light is on.</li>
            <li>Pair <strong>PT-P710BTxxxx</strong> in your computer’s Bluetooth settings (no PIN, or 0000).</li>
            {#if hasBluetooth}
              <li>Come back here and choose <strong>Bluetooth</strong>. On a Mac the first attempt can take a few seconds while the printer wakes up.</li>
              {#if hasPort}<li>Bluetooth list empty? Use <strong>Choose port…</strong> instead.</li>{/if}
            {:else}
              <li>Come back here, choose <strong>Choose port…</strong> and pick <strong>cu.PT-P710BTxxxx</strong> (macOS) or the printer’s serial port.</li>
            {/if}
          </ol>
        </details>
      {/if}
    {/if}
  </div>
</dialog>

<style>
  .connect {
    width: min(560px, calc(100% - 32px));
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-4) var(--space-2) var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: 19px;
  }
  .sub {
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
  }
  .content {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-5) var(--space-5);
  }
  .options {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 120ms var(--ease),
      background-color 120ms var(--ease);
  }
  .option:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .option:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .option.recommended {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .opt-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 42px;
    height: 42px;
    border-radius: var(--radius-m);
    background: var(--surface-2);
    color: var(--accent);
  }
  .opt-text {
    flex: 1;
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .opt-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
  }
  .opt-hint {
    color: var(--text-muted);
    font-size: 13px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
    font-weight: 700;
  }
  .progress {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-m);
    background: var(--accent-soft);
  }
  .progress p {
    margin: 2px 0 0;
  }
  .progress-body {
    flex: 1;
    min-width: 0;
  }
  .progress:focus-visible,
  .printer-card:focus-visible {
    outline: 2px solid var(--focus, var(--accent));
    outline-offset: 2px;
  }
  .spin {
    display: flex;
    color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  .printer-card {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface-2);
  }
  .printer-icon {
    color: var(--ok);
  }
  .printer-info strong {
    font-size: 16px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px var(--space-3);
    margin: var(--space-2) 0 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
  }
  dd.ok {
    color: var(--ok);
    font-weight: 600;
  }
  dd.warn,
  dd.error {
    color: var(--warn);
    font-weight: 600;
  }
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .help {
    color: var(--text-muted);
  }
  .help summary {
    cursor: pointer;
    color: var(--text);
    font-weight: 600;
  }
  .help ol {
    margin: var(--space-2) 0 0;
    padding-left: 20px;
    display: grid;
    gap: var(--space-1);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
