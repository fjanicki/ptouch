<!-- P-web (docs/SETTINGS-PLAN.md §4) — "Printer settings": Auto power on / Auto power off (external
     power, battery) stored in the printer. A lazy chunk: ConnectDialog shows it in place of its
     main view, Diagnostics embeds it as a card. Reads on open (a spinner per row; deferred while a
     print the user asked for is being prepared or sent). Choosing a duration only stages it: an
     explicit Apply opens the confirmation (arrow keys on a closed select change its value at once on
     Windows/Linux/ChromeOS, so `change` must not ask). A confirmed change is written, read back,
     and the outcome is shown (verified, still the old value + Try again (asks again), or the error
     + Read again). One change at a time; every control is disabled while a transaction runs or a
     print is in progress, and focus returns to the row's control afterwards. Where it is
     unverified which timer a setting controls (PT-P710BT, `SettingInfo.selectorUnverified`), rows
     are named by Brother's label and a note says so. USB, Bluetooth and the virtual printer all go
     through ConnectionManager → PrinterClient, so nothing here depends on the link. -->
<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { isUserCancel, type Problem } from '../../printer'
  import { settingsFor, type SettingId, type SettingInfo, type SettingReport, type SettingValue } from '../../wasm'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { brotherNote, choiceIndex, confirmText, displayText, readingText, rowHint, rowLabel, sameValue, savedText, settingsNotes, shortName } from './settings-view'

  const studio = getStudio()
  const id = $props.id()

  const conn = $derived(studio.conn)
  const model = $derived(conn.model ?? '')
  const infos = $derived.by<SettingInfo[]>(() => {
    if (!model) return []
    try {
      return settingsFor(model)
    } catch {
      return []
    }
  })
  /** The connection's last read (ConnectionManager keeps it per connection). */
  const readings = $derived<SettingReport[]>(conn.settings ?? [])
  const reportOf = (sid: SettingId): SettingReport | undefined => readings.find((r) => r.id === sid)
  const notes = $derived(settingsNotes(model, conn.transport?.kind, infos))

  type Phase = 'idle' | 'reading' | 'writing'
  let phase = $state<Phase>('idle')
  /** The setting being written (its row shows the spinner). */
  let writingId = $state<SettingId | null>(null)
  interface Pending {
    info: SettingInfo
    value: SettingValue
    label: string
    from: SettingReport | undefined
  }
  type Outcome = { kind: 'ok'; text: string } | { kind: 'mismatch'; text: string; retry: Pending } | { kind: 'error'; problem: Problem; afterWrite: boolean }
  let outcome = $state.raw<Outcome | null>(null)
  let pending = $state.raw<Pending | null>(null)
  let confirmEl: HTMLDialogElement | undefined = $state()
  let cancelBtn: HTMLButtonElement | undefined = $state()
  /** Durations chosen in a select but not applied yet (choice index per setting). */
  let drafts = $state.raw<Partial<Record<SettingId, number>>>({})
  /** Id of the element to give focus back to when a transaction ends (a control that gets
   * disabled while focused drops focus to <body>). */
  let focusAfter: string | null = null
  /** The read on open has not run yet (it waits while a print is in progress). */
  let initialRead = $state(true)
  let readCtrl: AbortController | null = null
  let destroyed = false

  const ready = $derived(conn.state === 'ready')
  /** A print the user already asked for (preparing a batch, or sending it) comes first. */
  const printing = $derived(studio.printing)
  const canRun = $derived(ready && !printing)
  const busy = $derived(phase !== 'idle')
  const disabled = $derived(busy || !canRun)
  const busyText = $derived(
    printing || conn.state === 'printing' || conn.state === 'cancelling'
      ? 'A label is printing. Settings are available when the printer is idle.'
      : !ready && phase === 'idle'
        ? 'The printer isn’t ready.'
        : '',
  )
  const controlId = (info: SettingInfo): string => `${id}-${info.id}-control`
  const readId = `${id}-read`

  function dropDraft(sid: SettingId): void {
    if (drafts[sid] === undefined) return
    const next = { ...drafts }
    delete next[sid]
    drafts = next
  }

  function setDraft(info: SettingInfo, index: number, stored: number): void {
    if (index === stored) dropDraft(info.id)
    else drafts = { ...drafts, [info.id]: index }
  }

  /** Gives focus back to `focusAfter` once it is enabled again, if focus was lost. */
  function restoreFocus(): void {
    const target = focusAfter
    focusAfter = null
    if (!target || destroyed) return
    void tick().then(() => {
      const el = document.getElementById(target) as HTMLButtonElement | HTMLSelectElement | null
      const active = document.activeElement
      if (el && !el.disabled && (!active || active === document.body)) el.focus()
    })
  }

  async function read(focusId: string | null = null): Promise<void> {
    if (busy || !canRun) return
    initialRead = false
    phase = 'reading'
    focusAfter = focusId
    outcome = null
    readCtrl = new AbortController()
    try {
      await studio.connection.readSettings(undefined, readCtrl.signal)
    } catch (e) {
      if (!destroyed && !isUserCancel(e)) outcome = { kind: 'error', problem: studio.connection.settingsProblem(e), afterWrite: false }
    } finally {
      readCtrl = null
      phase = 'idle'
      restoreFocus()
    }
  }

  function ask(info: SettingInfo, index: number): void {
    const value = info.choices[index]
    const from = reportOf(info.id)
    if (!value || disabled) return
    if (sameValue(from?.value, value)) {
      dropDraft(info.id)
      return
    }
    pending = { info, value, label: info.choiceLabels[index] ?? '', from }
    void tick().then(() => {
      confirmEl?.showModal()
      cancelBtn?.focus()
    })
  }

  function cancelConfirm(): void {
    const p = pending
    pending = null
    if (p) {
      // The select shows the stored value again; focus goes back to it (Apply disappears).
      dropDraft(p.info.id)
      focusAfter = controlId(p.info)
    }
    if (confirmEl?.open) confirmEl.close()
    restoreFocus()
  }

  function confirmChange(): void {
    const p = pending
    pending = null
    if (confirmEl?.open) confirmEl.close()
    if (p) void write(p)
  }

  async function write(p: Pending): Promise<void> {
    if (busy || !canRun) return
    phase = 'writing'
    writingId = p.info.id
    focusAfter = controlId(p.info)
    outcome = null
    try {
      const r = await studio.connection.writeSettings([{ id: p.info.id, value: p.value }])
      const got = r.report.find((x) => x.id === p.info.id)
      outcome = r.verified ? { kind: 'ok', text: savedText(p.info, p.label) } : { kind: 'mismatch', text: `The printer still reports ${got?.text ?? 'the old value'}.`, retry: p }
    } catch (e) {
      // A cancelled write may have reached the printer too: always offer to read again.
      if (!destroyed) outcome = { kind: 'error', problem: studio.connection.settingsProblem(e), afterWrite: true }
    } finally {
      dropDraft(p.info.id)
      writingId = null
      phase = 'idle'
      restoreFocus()
    }
  }

  // Read on open, or as soon as a print in progress is over.
  $effect(() => {
    if (initialRead && canRun && !busy) void read()
  })
  onDestroy(() => {
    destroyed = true
    // A read is harmless to stop; a write is left to finish (and verify) on its own.
    readCtrl?.abort()
  })
</script>

<div class="settings" aria-busy={busy}>
  {#if !infos.length}
    <p class="hint">This printer model has no settings the studio can change.</p>
  {:else}
    <ul class="rows" aria-label="Printer settings">
      {#each infos as info (info.id)}
        {@const report = reportOf(info.id)}
        {@const idx = choiceIndex(info, report?.value)}
        {@const spinning = phase === 'reading' || writingId === info.id}
        <li class="row" class:stack={info.kind === 'duration'}>
          <div class="text">
            <span class="label" id="{id}-{info.id}">{rowLabel(info)}</span>
            <span class="hint" id="{id}-{info.id}-hint">{rowHint(info)} {brotherNote(info)}</span>
          </div>
          <div class="control">
            {#if spinning}
              <span class="spin" aria-hidden="true"><Icon name="loader" size={16} /></span>
              <span class="visually-hidden">{phase === 'reading' ? 'Reading…' : 'Saving…'}</span>
            {/if}
            {#if info.kind === 'toggle'}
              {@const on = report?.value?.kind === 'enabled' && report.value.enabled}
              <button
                type="button"
                class="switch"
                id={controlId(info)}
                role="switch"
                aria-checked={on}
                aria-labelledby="{id}-{info.id}"
                aria-describedby="{id}-{info.id}-hint {id}-{info.id}-value"
                disabled={disabled || !report}
                onclick={() => ask(info, choiceIndex(info, { kind: 'enabled', enabled: !on }))}
              >
                <span class="track" aria-hidden="true"><span class="thumb"></span></span>
              </button>
              <span class="value" id="{id}-{info.id}-value">{report ? readingText(report) : spinning ? '' : '—'}</span>
            {:else}
              {@const draft = drafts[info.id]}
              <select
                class="select"
                id={controlId(info)}
                aria-labelledby="{id}-{info.id}"
                aria-describedby="{id}-{info.id}-hint"
                disabled={disabled || !report}
                value={String(draft ?? idx)}
                onchange={(e) => setDraft(info, Number(e.currentTarget.value), idx)}
              >
                {#if idx < 0}
                  <option value="-1" disabled>{report ? readingText(report) : spinning ? 'Reading…' : '—'}</option>
                {/if}
                {#each info.choiceLabels as label, i (i)}
                  <option value={String(i)}>{displayText(label)}</option>
                {/each}
              </select>
              {#if draft !== undefined && draft !== idx}
                <button type="button" class="btn small primary apply" aria-label="Apply {shortName(info)}" {disabled} onclick={() => ask(info, draft)}>Apply</button>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <div class="outcome" role="status" aria-live="polite">
      {#if outcome?.kind === 'ok'}
        <p class="ok"><Icon name="check" size={16} />{outcome.text}</p>
      {:else if outcome?.kind === 'mismatch'}
        {@const retry = outcome.retry}
        <div class="warn">
          <p><Icon name="alert" size={16} />{outcome.text}</p>
          <button type="button" class="btn small" {disabled} onclick={() => ask(retry.info, choiceIndex(retry.info, retry.value))}>Try again</button>
        </div>
      {:else if busyText}
        <p class="muted">{busyText}</p>
      {/if}
    </div>
    {#if outcome?.kind === 'error'}
      <div class="error" role="alert">
        <p><Icon name="x" size={16} /><strong>{outcome.problem.title}</strong></p>
        <p class="detail">{outcome.problem.detail}{outcome.afterWrite ? ' The printer may have stored the new value. Read again.' : ''}</p>
      </div>
    {/if}

    <div class="actions">
      <button type="button" class="btn small" id={readId} {disabled} onclick={() => void read(readId)}><Icon name="refresh" size={16} />Read again</button>
    </div>
    {#each notes as note (note)}
      <p class="hint note">{note}</p>
    {/each}
  {/if}
</div>

<dialog
  class="modal confirm"
  role="alertdialog"
  aria-labelledby="{id}-confirm-title"
  aria-describedby="{id}-confirm-desc"
  bind:this={confirmEl}
  oncancel={(e) => {
    e.preventDefault()
    cancelConfirm()
  }}
>
  {#if pending}
    <h3 id="{id}-confirm-title">{confirmText(pending.info, pending.from, pending.label)}</h3>
    <p id="{id}-confirm-desc">The printer stores this setting. It is read back afterwards to check it.</p>
    <div class="confirm-actions">
      <button type="button" class="btn" bind:this={cancelBtn} onclick={cancelConfirm}>Cancel</button>
      <button type="button" class="btn primary" onclick={confirmChange}>Change</button>
    </div>
  {/if}
</dialog>

<style>
  .settings {
    display: grid;
    gap: var(--space-3);
    min-width: 0;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-3);
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  .text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .label {
    font-weight: 600;
  }
  .control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    min-width: 0;
  }
  .control .select {
    width: auto;
    min-width: 128px;
  }
  .value {
    min-width: 3.5em;
    color: var(--text-muted);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .switch:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .track {
    position: relative;
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: var(--surface-3);
    border: 1px solid var(--control-border);
    transition: background-color 150ms var(--ease);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: var(--shadow-1);
    transition: transform 150ms var(--ease);
  }
  .switch[aria-checked='true'] .track {
    background: var(--accent);
    border-color: var(--accent);
  }
  .switch[aria-checked='true'] .thumb {
    transform: translateX(14px);
    background: var(--accent-text);
  }
  .switch:focus-visible {
    outline: none;
  }
  .switch:focus-visible .track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .spin {
    display: flex;
    color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  .outcome:empty {
    display: none;
  }
  .outcome p,
  .error p {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
  }
  .outcome :global(svg),
  .error :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .ok {
    color: var(--ok);
    font-weight: 600;
  }
  .warn {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-m);
    background: var(--danger-soft);
  }
  .error strong {
    color: var(--danger);
  }
  .error .detail {
    padding-left: 24px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .note {
    margin: 0;
  }
  .confirm {
    width: min(420px, calc(100% - 32px));
    padding: var(--space-5);
  }
  .confirm h3 {
    margin: 0 0 var(--space-2);
    font-size: 17px;
  }
  .confirm p {
    margin: 0;
    color: var(--text-muted);
  }
  .confirm-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  @media (max-width: 480px) {
    .row.stack {
      grid-template-columns: minmax(0, 1fr);
    }
    .stack .control {
      justify-content: flex-start;
    }
    .control .select {
      flex: 1;
    }
  }
  @media (pointer: coarse) {
    .switch,
    .apply {
      min-width: 44px;
      min-height: 44px;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
