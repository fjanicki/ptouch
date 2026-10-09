<!-- W5 — "Update available" and "Ready to work offline" toasts. Never swaps the app under a
     running print: if the user chooses Reload while `busy`, the reload waits for the print to
     finish. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { applyUpdate, dismissOfflineReady, onUpdateState, type UpdateState } from './register'

  let { busy = false }: { busy?: boolean } = $props()
  let s = $state<UpdateState>({ needRefresh: false, offlineReady: false })
  let later = $state(false)
  let waitingForPrint = $state(false)
  onMount(() => onUpdateState((v) => (s = v)))

  // Offline-ready is informational: hide it after a few seconds.
  $effect(() => {
    if (!s.offlineReady) return
    const t = setTimeout(dismissOfflineReady, 6000)
    return () => clearTimeout(t)
  })

  // Deferred reload once the print is done.
  $effect(() => {
    if (waitingForPrint && !busy) {
      waitingForPrint = false
      void applyUpdate(false)
    }
  })

  async function reload(): Promise<void> {
    if (busy) {
      waitingForPrint = true
      return
    }
    await applyUpdate(false)
  }
</script>

<div class="toasts" aria-live="polite">
  {#if s.needRefresh && !later}
    <div class="toast" role="status">
      <span class="dot" aria-hidden="true"></span>
      <span class="msg">
        {#if waitingForPrint}
          Updating as soon as the print finishes…
        {:else}
          A new version of ptouch studio is ready.
        {/if}
      </span>
      {#if !waitingForPrint}
        <button class="btn small primary" onclick={reload} title={busy ? 'Reloads after the current print' : undefined}>{busy ? 'Reload after print' : 'Reload'}</button>
        <button class="btn small ghost" onclick={() => (later = true)}>Later</button>
      {/if}
    </div>
  {:else if s.offlineReady}
    <div class="toast" role="status">
      <span class="dot ok" aria-hidden="true"></span>
      <span class="msg">Ready to work offline.</span>
      <button class="btn small ghost" onclick={dismissOfflineReady} aria-label="Dismiss">✕</button>
    </div>
  {/if}
</div>

<style>
  .toasts {
    position: fixed;
    right: calc(var(--space-4) + env(safe-area-inset-right, 0px));
    bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    z-index: 60;
    display: grid;
    gap: var(--space-2);
    max-width: min(420px, calc(100vw - 2 * var(--space-4)));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-2);
    animation: rise 180ms var(--ease);
  }
  .msg {
    flex: 1 1 auto;
    min-width: 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .dot.ok {
    background: var(--ok);
  }
  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
  @media (max-width: 860px) {
    /* Stay clear of the sticky print bar on narrow screens. */
    .toasts {
      left: calc(var(--space-3) + env(safe-area-inset-left, 0px));
      right: calc(var(--space-3) + env(safe-area-inset-right, 0px));
      bottom: calc(88px + env(safe-area-inset-bottom, 0px));
      max-width: none;
    }
  }
</style>
