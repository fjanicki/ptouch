<!-- Lead (studio v1) — shared modal dialog: native <dialog> (focus trap, Escape) with a
     titled header, a close button, a scrolling body and an optional footer. Every v1 dialog
     (templates, history, export, hand-off, fonts, Wi-Fi password question) uses it. -->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    open,
    title,
    onclose,
    size = 'm',
    description,
    children,
    footer,
  }: {
    open: boolean
    title: string
    /** Close requested (button, Escape). The owner sets `open = false`. */
    onclose: () => void
    /** m = 560 px, l = 880 px (both shrink to the window on phones). */
    size?: 'm' | 'l'
    /** Short text under the title (aria-describedby). */
    description?: string
    children: Snippet
    footer?: Snippet
  } = $props()

  const id = $props.id()
  let dialog: HTMLDialogElement | undefined = $state()

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  })
</script>

<dialog
  class="modal v1-modal {size}"
  bind:this={dialog}
  aria-labelledby="{id}-title"
  aria-describedby={description ? `${id}-desc` : undefined}
  oncancel={(e) => {
    e.preventDefault()
    onclose()
  }}
>
  {#if open}
    <header>
      <div>
        <h2 id="{id}-title">{title}</h2>
        {#if description}<p id="{id}-desc" class="desc">{description}</p>{/if}
      </div>
      <button type="button" class="btn ghost icon" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  .v1-modal[open] {
    display: flex;
    flex-direction: column;
  }
  .v1-modal.l {
    width: min(880px, calc(100% - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2) var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .desc {
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-2) var(--space-5) var(--space-5);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
  }
  @media (max-width: 600px) {
    header {
      padding: var(--space-3) var(--space-3) var(--space-2) var(--space-4);
    }
    .body {
      padding: var(--space-2) var(--space-4) var(--space-4);
    }
  }
</style>
