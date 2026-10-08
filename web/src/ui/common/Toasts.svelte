<!-- W4 — toast stack (print done / cancelled / failed, save errors). Errors stay until dismissed. -->
<script lang="ts">
  import { getStudio } from '../state/studio.svelte'
  import Icon from './Icon.svelte'

  const studio = getStudio()
  const ICON = { ok: 'check', info: 'info', error: 'alert' } as const
</script>

<!-- One live region announces each new toast once (no nested role=status: that announced it twice). -->
<div class="toasts" role="log" aria-label="Notifications" aria-live="polite" aria-relevant="additions">
  {#each studio.toasts as t (t.id)}
    <div class="toast {t.tone}">
      <span class="glyph"><Icon name={ICON[t.tone]} size={18} /></span>
      <div class="body">
        <strong>{t.title}</strong>
        {#if t.detail}<p>{t.detail}</p>{/if}
      </div>
      {#if t.action}
        <button
          type="button"
          class="btn small"
          onclick={() => {
            t.action?.run()
            studio.dismissToast(t.id)
          }}>{t.action.label}</button
        >
      {/if}
      <button type="button" class="btn ghost icon small" aria-label="Dismiss notification" onclick={() => studio.dismissToast(t.id)}><Icon name="x" size={16} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: var(--space-4);
    bottom: calc(var(--printbar-h, 72px) + var(--space-3));
    z-index: 40;
    display: grid;
    gap: var(--space-2);
    width: min(400px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: var(--space-2);
    align-items: start;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    animation: in 180ms var(--ease);
  }
  .glyph {
    display: flex;
    padding-top: 1px;
  }
  .ok .glyph {
    color: var(--ok);
  }
  .info .glyph {
    color: var(--accent);
  }
  .error {
    border-left: 4px solid var(--danger);
  }
  .error .glyph {
    color: var(--danger);
  }
  p {
    margin: 2px 0 0;
    color: var(--text-muted);
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
