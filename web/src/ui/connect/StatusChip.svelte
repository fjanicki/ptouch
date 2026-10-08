<!-- W4 — connection status chip: ● ready (model · tape) · ◐ connecting/waking · ○ asleep? ·
     ✕ error. Shows the tape/ink swatch and battery when reported; opens the connect dialog. -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { chipLabel, chipView } from '../state/view-model'

  const studio = getStudio()
  const view = $derived(chipView(studio.conn))
  const status = $derived(studio.conn.status)
  const showSwatch = $derived(view.tone === 'ok' && !!status && status.tapeColor.css !== status.textColor.css)
  const battery = $derived(status?.battery)
</script>

<button
  type="button"
  class="chip {view.tone}"
  data-state={studio.conn.state}
  onclick={() => (studio.connectOpen = true)}
  aria-haspopup="dialog"
  title={view.detail || view.text}
  aria-label={chipLabel(view)}
>
  {#if view.busy}
    <span class="spin" aria-hidden="true"><Icon name="loader" size={14} /></span>
  {:else}
    <span class="dot" aria-hidden="true"></span>
  {/if}
  <span class="text">{view.text}</span>
  {#if showSwatch && status}
    <span class="swatch" aria-hidden="true" style:background={status.tapeColor.css} style:color={status.textColor.css}>A</span>
  {/if}
  {#if view.tone === 'ok' && battery && (battery.weak || battery.source === 'battery' || battery.source === 'ac')}
    <span class="batt" class:weak={battery.weak} aria-hidden="true"
      ><Icon name={battery.source === 'ac' ? 'plug' : battery.weak ? 'battery-low' : 'battery'} size={16} />{#if typeof battery.percent === 'number'}<small>{Math.round(battery.percent)}%</small>{/if}</span
    >
  {/if}
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    max-width: min(100%, 300px);
    padding: 0 var(--space-3);
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    cursor: pointer;
    font-weight: 600;
    white-space: nowrap;
  }
  .chip:hover {
    border-color: var(--border-strong);
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--text-muted);
  }
  .ok {
    background: var(--ok-soft);
    border-color: color-mix(in srgb, var(--ok) 35%, transparent);
  }
  .ok .dot {
    background: var(--ok);
    border-color: var(--ok);
  }
  .warn {
    background: var(--warn-soft);
  }
  .warn .dot {
    border-color: var(--warn);
  }
  .error {
    background: var(--danger-soft);
  }
  .error .dot {
    background: var(--danger);
    border-color: var(--danger);
  }
  .busy {
    background: var(--accent-soft);
  }
  .spin {
    display: flex;
    color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 16px;
    border-radius: 3px;
    border: 1px solid var(--border-strong);
    font: 700 10px/1 var(--font-ui);
  }
  .batt {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .batt.weak {
    color: var(--warn);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
