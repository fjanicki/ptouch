<!-- "Insert special character" (docs/TABLE-PLAN.md §12) — the Ω button and its popover (top
     layer, so the scrolling inspector never clips it). Entry chunk: only the button, the empty
     popover and a shade; the header (Close), the symbols and the keys (SymbolMenu) load on the
     first open. `field` is the field that last had the focus, `oninsert` gets its whole new text (one
     undo step). Used by the Text block's text (icon only) and the table cells (`labelled`: "Ω
     Symbols", a bordered button like its neighbours).
     A click outside closes it. On a touch or narrow screen it opens over a shade instead (both
     "manual" popovers, the shade under the menu): a tap on the shade only closes the menu, it
     never also presses what is underneath (Undo, the print bar…). -->
<script lang="ts">
  import type { Component } from 'svelte'
  import { loadFamily } from '../../render/fonts'

  type Field = HTMLInputElement | HTMLTextAreaElement
  let { field, oninsert, labelled = false }: { field: () => Field | null | undefined; oninsert: (text: string) => void; labelled?: boolean } = $props()

  const uid = $props.id()
  let anchor: HTMLButtonElement | undefined = $state()
  let pop: HTMLDivElement | undefined = $state()
  let shade: HTMLDivElement | undefined = $state()
  let open = $state(false)
  let failed = $state(false)
  let Menu = $state<Component<{ anchor: HTMLButtonElement; pop: HTMLElement; field: () => Field | null | undefined; oninsert: (text: string) => void }> | null>(null)

  const isOpen = (el: HTMLElement | undefined): boolean => !!el?.matches(':popover-open')

  // Runs before the button's popovertarget toggles the menu: picks light dismiss (a mouse) or
  // the shade (touch, narrow).
  function onclick(): void {
    if (!pop || isOpen(pop)) return
    const touch = window.matchMedia('(pointer: coarse), (max-width: 599px)').matches
    pop.setAttribute('popover', touch ? 'manual' : 'auto')
    if (touch && shade && !isOpen(shade)) shade.showPopover()
  }

  function close(): void {
    if (isOpen(pop)) pop?.hidePopover()
    anchor?.focus()
  }

  function ontoggle(e: ToggleEvent): void {
    open = e.newState === 'open'
    if (!open) {
      if (isOpen(shade)) shade?.hidePopover()
      return
    }
    // The menu shows the symbols in the fonts that print them (JetBrains Mono is precached).
    void loadFamily('jetbrains-mono')
    void loadFamily('b612')
    if (!Menu)
      import('./SymbolMenu.svelte').then(
        (m) => (Menu = m.default),
        () => (failed = true),
      )
  }
</script>

<button bind:this={anchor} type="button" class="btn small sym-open" class:ghost={!labelled} class:icon={!labelled} popovertarget="{uid}-pop" aria-label="Symbols: insert special character" aria-expanded={open} title="Insert special character (♯ ♭ → ± ° ✓ …)" {onclick}><span class="omega" aria-hidden="true">Ω</span><span class="word">Symbols</span></button>
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a pointer-only shade: the keyboard closes the menu with Escape or Close) -->
<div bind:this={shade} popover="manual" class="sym-shade" aria-hidden="true" onclick={close}></div>
<div bind:this={pop} id="{uid}-pop" popover="auto" class="sym-pop panel" role="dialog" aria-label="Special characters" {ontoggle}>
  {#if open && Menu && anchor && pop}
    <Menu {anchor} {pop} {field} {oninsert} />
  {:else}
    <p class="sym-wait" role={failed ? 'alert' : 'status'}>{failed ? 'The symbols could not be loaded. Check your connection.' : 'Loading…'}</p>
  {/if}
</div>

<style>
  .sym-open {
    gap: var(--space-1);
  }
  .icon .word {
    display: none;
  }
  .omega {
    font-size: 16px;
    font-weight: 600;
    line-height: 1;
  }
  .sym-pop {
    width: min(390px, calc(100vw - 32px));
    max-height: min(580px, calc(100dvh - 32px));
    overflow: auto;
    padding: var(--space-2) var(--space-3) var(--space-3);
    color: var(--text);
    box-shadow: var(--shadow-2);
  }
  .sym-shade {
    inset: 0;
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(0 0 0 / 0.35);
  }
  .sym-wait {
    margin: 0;
    color: var(--text-muted);
  }
  @media (pointer: coarse) {
    .sym-open {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
