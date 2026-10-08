<!-- W4 — accessible menu button (disclosure + role="menu", arrow keys, Escape, outside click). -->
<script lang="ts" module>
  export interface MenuItem {
    id: string
    label: string
    icon?: string
    hint?: string
    disabled?: boolean
    separatorBefore?: boolean
    run: () => void
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  let { label, items, trigger, align = 'start' }: { label: string; items: MenuItem[]; trigger: Snippet; align?: 'start' | 'end' } = $props()

  const id = $props.id()
  let open = $state(false)
  let root: HTMLDivElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()

  function menuItems(): HTMLButtonElement[] {
    return [...(root?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  }
  function show(focus: 'first' | 'last' = 'first') {
    open = true
    queueMicrotask(() => {
      const els = menuItems()
      ;(focus === 'first' ? els[0] : els[els.length - 1])?.focus()
    })
  }
  function hide(returnFocus = true) {
    open = false
    if (returnFocus) button?.focus()
  }
  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      show('first')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      show('last')
    }
  }
  function onMenuKey(e: KeyboardEvent) {
    const els = menuItems()
    const at = els.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') els[(at + 1) % els.length]?.focus()
    else if (e.key === 'ArrowUp') els[(at - 1 + els.length) % els.length]?.focus()
    else if (e.key === 'Home') els[0]?.focus()
    else if (e.key === 'End') els[els.length - 1]?.focus()
    else if (e.key === 'Escape') hide()
    else if (e.key === 'Tab') hide(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  function onWindowPointer(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) hide(false)
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

<div class="menu-root" bind:this={root}>
  <button
    bind:this={button}
    type="button"
    class="btn ghost"
    id="{id}-btn"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="{id}-menu"
    onclick={() => (open ? hide() : show())}
    onkeydown={onButtonKey}
  >
    {@render trigger()}
  </button>
  {#if open}
    <div class="menu {align}" role="menu" id="{id}-menu" aria-label={label} tabindex="-1" onkeydown={onMenuKey}>
      {#each items as item (item.id)}
        {#if item.separatorBefore}<div class="sep" role="separator"></div>{/if}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          disabled={item.disabled}
          onclick={() => {
            hide()
            item.run()
          }}
        >
          {#if item.icon}<Icon name={item.icon} size={16} />{/if}
          <span class="label">{item.label}</span>
          {#if item.hint}<span class="hint-k">{item.hint}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu-root {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    min-width: 220px;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    display: grid;
    animation: pop 120ms var(--ease);
  }
  .menu.end {
    left: auto;
    right: 0;
  }
  [role='menuitem'] {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 34px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  [role='menuitem']:hover,
  [role='menuitem']:focus-visible {
    background: var(--surface-2);
    outline: none;
  }
  [role='menuitem']:focus-visible {
    box-shadow: inset 0 0 0 2px var(--focus);
  }
  [role='menuitem']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .label {
    flex: 1;
  }
  .hint-k {
    color: var(--text-muted);
    font-size: 12px;
  }
  .sep {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
