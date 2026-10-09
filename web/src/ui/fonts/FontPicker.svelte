<!-- Font picker trigger (docs/FONTS-AND-SIZE-PLAN.md §3.2, P-picker). Mounted by TextProps where the
     v1 font select was; props are frozen: `item` (the text block), `onchange(patch)` (TextProps
     passes it to studio.updateItem), `id` (the "Font" label points at this button, so its
     accessible name stays "Font"), `describedby` (the "not on this device" note).

     The button shows the current font, drawn in that font, and a "Crisp" badge when a pixel font
     renders at a whole multiple of its design grid. The picker itself (search, chips, grouped
     listbox, favourites, previews) is FontPickerPanel.svelte, a lazy chunk loaded on the first
     open: the entry chunk has a byte budget (§1.8). -->
<script lang="ts">
  import type { Component } from 'svelte'
  import type { TextItem } from '../../doc/schema'
  import { fontDef, resolveWeight } from '../../render'
  import { activeCustomFamily } from '../../render/fonts'
  import { getStudio } from '../state/studio.svelte'
  import type { FontPatch } from './font-choice'
  import type { PanelProps } from './panel-props'

  let { item, onchange, id, describedby }: { item: TextItem; onchange: (patch: FontPatch) => void; id: string; describedby?: string | undefined } = $props()
  const studio = getStudio()

  let open = $state(false)
  let Panel = $state<Component<PanelProps> | null>(null)
  let failed = $state(false)
  let button: HTMLButtonElement | undefined = $state()

  const def = $derived(fontDef(item.fontFamily))
  /** Name and CSS family of the face the block draws with (re-checked after every render). */
  const face = $derived.by(() => {
    void studio.render
    const custom = activeCustomFamily(item)
    if (item.customFont) return { label: item.customFont.family, css: custom ? `"${custom}", ${def.generic}` : `"${def.family}", ${def.generic}`, weight: custom ? 400 : resolveWeight(def, item.fontWeight) }
    return { label: def.label, css: `"${def.family}", ${def.generic}`, weight: resolveWeight(def, item.fontWeight) }
  })
  /** Dots per font pixel when a pixel font was drawn crisp (P-size fills `texts`). */
  const crisp = $derived(item.customFont ? undefined : studio.render?.texts?.find((t) => t.itemId === item.id)?.pixelScale)

  function show(): void {
    open = true
    failed = false
    if (Panel) return
    import('./FontPickerPanel.svelte').then(
      (m) => (Panel = m.default as Component<PanelProps>),
      () => {
        open = false
        failed = true
      },
    )
  }

  function close(): void {
    open = false
    button?.focus()
  }
</script>

<button
  bind:this={button}
  {id}
  type="button"
  class="select font-trigger"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-describedby={[`${id}-current`, describedby].filter(Boolean).join(' ')}
  aria-busy={open && !Panel}
  onclick={() => (open ? close() : show())}
  onkeydown={(e) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      show()
    }
  }}
>
  <span class="name" id="{id}-current" style:font-family={face.css} style:font-weight={face.weight}>{face.label}</span>
  {#if crisp}<span class="badge" title="Drawn at {crisp} dots per font pixel">Crisp</span>{/if}
</button>
{#if failed}<p class="hint error" role="alert">The font list could not be loaded. Check your connection and try again.</p>{/if}
{#if open && Panel}
  <Panel {item} anchor={button} onpick={onchange} onclose={close} />
{/if}

<style>
  .font-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    /* Shrink with its column (a long name truncates) instead of running under the Weight select. */
    min-width: 0;
    overflow: hidden;
    text-align: left;
    cursor: pointer;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
  }
  .badge {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--ok-soft);
    color: var(--ok);
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
  }
</style>
