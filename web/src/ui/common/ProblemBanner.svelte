<!-- W4 — renders a printer-layer Problem (W2 problems.ts) with its actions. Copy comes from W2;
     this component only lays it out. Action buttons run synchronously inside the click handler
     (connect actions need the user gesture). -->
<script lang="ts">
  import type { Problem, ProblemAction } from '../../printer'
  import Icon from './Icon.svelte'

  let { problem, onaction, compact = false }: { problem: Problem; onaction: (a: ProblemAction) => void; compact?: boolean } = $props()
  const LABELS: Record<ProblemAction, string> = {
    retry: 'Try again',
    reconnect: 'Reconnect',
    'choose-port': 'Choose port…',
    'connect-bluetooth': 'Bluetooth',
    'connect-usb': 'USB cable',
    'switch-tape': 'Use loaded tape',
    'open-diagnostics': 'Diagnostics',
    dismiss: 'Dismiss',
  }
  const PRIMARY: ReadonlySet<ProblemAction> = new Set(['retry', 'reconnect', 'switch-tape'])
  let showTech = $state(false)
</script>

<div class="banner {problem.severity}" class:compact role={problem.severity === 'error' ? 'alert' : 'status'} data-problem={problem.id}>
  <span class="glyph"><Icon name={problem.severity === 'info' ? 'info' : 'alert'} size={20} /></span>
  <div class="body">
    <strong class="title">{problem.title}</strong>
    <p class="detail">{problem.detail}</p>
    {#if problem.printerErrors?.length}
      <ul class="errs">
        {#each problem.printerErrors as e (e.id)}<li>{e.message}</li>{/each}
      </ul>
    {/if}
    {#if problem.technical}
      <button type="button" class="tech-toggle" aria-expanded={showTech} onclick={() => (showTech = !showTech)}>{showTech ? 'Hide' : 'Show'} details</button>
      {#if showTech}<code class="tech">{problem.technical}</code>{/if}
    {/if}
  </div>
  {#if problem.actions.length}
    <div class="actions">
      {#each problem.actions as a (a)}
        <button type="button" class="btn small" class:primary={PRIMARY.has(a)} class:ghost={a === 'dismiss'} onclick={() => onaction(a)}>{LABELS[a]}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .banner {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--space-3);
    align-items: start;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-left: 4px solid var(--danger);
    border-radius: var(--radius-m);
    background: var(--danger-soft);
  }
  .banner.warning {
    border-left-color: var(--warn);
    background: var(--warn-soft);
  }
  .banner.info {
    border-left-color: var(--accent);
    background: var(--accent-soft);
  }
  .glyph {
    display: flex;
    padding-top: 1px;
    color: var(--danger);
  }
  .warning .glyph {
    color: var(--warn);
  }
  .info .glyph {
    color: var(--accent);
  }
  .body {
    min-width: 0;
  }
  .title {
    display: block;
  }
  .detail {
    margin: 2px 0 0;
    color: var(--text);
  }
  .errs {
    margin: var(--space-1) 0 0;
    padding-left: 18px;
  }
  .tech-toggle {
    margin-top: var(--space-1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
  }
  .tech {
    display: block;
    margin-top: var(--space-1);
    padding: var(--space-2);
    border-radius: var(--radius-s);
    background: var(--surface);
    font: 12px/1.4 var(--font-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  @media (max-width: 640px) {
    .banner {
      grid-template-columns: auto 1fr;
    }
    .actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
  .compact {
    grid-template-columns: auto 1fr;
  }
  .compact .actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
</style>
