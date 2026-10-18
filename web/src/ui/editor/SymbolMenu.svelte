<!-- "Insert special character" (docs/TABLE-PLAN.md §12) — the body of SymbolButton's popover, a
     lazy chunk loaded on the first open: the symbols by group (symbols.ts), one roving tab stop,
     ← → / ↑ ↓ (the symbol above / below on screen), Home / End, Escape closes and returns the focus
     to the button. A symbol replaces the selection of the field that last had the focus (or goes
     in at its caret), as one undo step, and the field gets the focus back with the caret after
     it. Placed by the button on a wide screen, never over that field; centred on a phone. -->
<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { getStudio } from '../state/studio.svelte'
  import Icon from '../common/Icon.svelte'
  import { SYMBOL_GROUPS } from './symbols'

  type Field = HTMLInputElement | HTMLTextAreaElement
  let {
    anchor,
    pop,
    field,
    oninsert,
  }: {
    anchor: HTMLButtonElement
    pop: HTMLElement
    field: () => Field | null | undefined
    oninsert: (text: string) => void
  } = $props()

  const uid = $props.id()
  const studio = getStudio()
  let root: HTMLDivElement | undefined = $state()
  let at = $state(0)
  const buttons = (): HTMLButtonElement[] => [...(root?.querySelectorAll<HTMLButtonElement>('button.sym') ?? [])]

  function close(refocus: boolean): void {
    if (pop.matches(':popover-open')) pop.hidePopover()
    if (refocus) anchor.focus()
  }

  /**
   * Next to the button, inside the viewport, never over the field the symbol goes into (the
   * focused cell, the text): under the button, else above it, else beside the field, else under
   * or above the button with a shorter, scrolling menu. Centred on a phone.
   */
  function place(): void {
    const vw = window.innerWidth
    const vh = window.innerHeight
    pop.style.cssText = ''
    if (vw < 600) return
    const r = anchor.getBoundingClientRect()
    const f = field()?.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const m = 8
    const clampX = (x: number): number => Math.max(m, Math.min(x, vw - w - m))
    const clampY = (y: number): number => Math.max(m, Math.min(y, vh - h - m))
    const covers = (x: number, y: number): boolean => !!f && f.width > 0 && x < f.right && x + w > f.left && y < f.bottom && y + h > f.top
    const fits = (x: number, y: number): boolean => x >= m && y >= m && x + w <= vw - m && y + h <= vh - m
    const fy = f ? f.top + f.height / 2 - h / 2 : r.top
    const spots: [number, number][] = [
      [clampX(r.left), r.bottom + 4],
      [clampX(r.left), r.top - h - 4],
      ...(f ? ([[f.right + m, clampY(fy)], [f.left - w - m, clampY(fy)]] as [number, number][]) : []),
    ]
    const spot = spots.find(([x, y]) => fits(x, y) && !covers(x, y))
    if (spot) {
      pop.style.cssText = `margin:0;inset:auto;left:${spot[0]}px;top:${spot[1]}px`
      return
    }
    // No room anywhere: the larger side of the button (above it, also above a field there), the
    // menu shortened to fit; it scrolls.
    const roof = f && f.bottom <= r.top + 1 ? Math.min(r.top, f.top) : r.top
    const below = vh - m - (r.bottom + 4)
    const above = roof - 4 - m
    const maxH = Math.max(120, below, above)
    const top = below >= above ? r.bottom + 4 : roof - 4 - Math.min(h, maxH)
    pop.style.cssText = `margin:0;inset:auto;left:${clampX(r.left)}px;top:${Math.max(m, top)}px;max-height:${maxH}px`
  }

  function focusAt(i: number): void {
    const els = buttons()
    if (!els.length) return
    at = Math.max(0, Math.min(els.length - 1, i))
    els[at]?.focus()
  }

  /** The symbol on the row above / below (nearest by its centre). */
  function vertical(dir: 1 | -1): number {
    const els = buttons()
    const cur = els[at]?.getBoundingClientRect()
    if (!cur) return at
    const cx = cur.left + cur.width / 2
    let best = at
    let bestDy = Infinity
    let bestDx = Infinity
    els.forEach((el, i) => {
      const b = el.getBoundingClientRect()
      const dy = (b.top - cur.top) * dir
      if (dy < cur.height / 2) return
      const dx = Math.abs(b.left + b.width / 2 - cx)
      if (dy < bestDy - 1 || (Math.abs(dy - bestDy) <= 1 && dx < bestDx)) {
        best = i
        bestDy = dy
        bestDx = dx
      }
    })
    return best
  }

  function onkeydown(e: KeyboardEvent): void {
    const last = buttons().length - 1
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowDown' ? vertical(1) : e.key === 'ArrowUp' ? vertical(-1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : undefined
    if (e.key === 'Escape') close(true)
    else if (to !== undefined) focusAt(to)
    else return
    // Never the studio's own Escape (deselect) or arrow shortcuts.
    e.preventDefault()
    e.stopPropagation()
  }

  async function pick(sym: string, name: string): Promise<void> {
    const el = field()
    close(!el)
    if (!el) return
    const v = el.value
    const a = el.selectionStart ?? v.length
    const b = el.selectionEnd ?? a
    const next = v.slice(0, a) + sym + v.slice(b)
    if (el.maxLength >= 0 && next.length > el.maxLength) {
      el.focus()
      return
    }
    oninsert(next)
    studio.announce(`${name} inserted`)
    await tick()
    el.focus()
    el.setSelectionRange(a + sym.length, a + sym.length)
  }

  onMount(() => {
    place()
    focusAt(0)
    const onresize = (): void => place()
    window.addEventListener('resize', onresize)
    window.addEventListener('scroll', onresize, true)
    return () => {
      window.removeEventListener('resize', onresize)
      window.removeEventListener('scroll', onresize, true)
    }
  })
  let n = 0
  const index = SYMBOL_GROUPS.map((g) => g.symbols.map(() => n++))
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the keys belong to the buttons inside) -->
<div
  class="menu"
  bind:this={root}
  {onkeydown}
  onfocusout={(e) => {
    const to = e.relatedTarget as Node | null
    if (to && !pop.contains(to) && to !== anchor) close(false)
  }}
>
  <div class="head">
    <h2 class="title">Special characters</h2>
    <!-- Its own tab stop (Shift+Tab from the symbols); on a phone the shade closes the menu too. -->
    <button type="button" class="btn ghost icon small close" aria-label="Close" title="Close (Esc)" onclick={() => close(true)}><Icon name="x" size={16} /></button>
  </div>
  {#each SYMBOL_GROUPS as group, g (group.label)}
    <div class="group" role="group" aria-labelledby="{uid}-{g}">
      <h3 class="group-title" id="{uid}-{g}">{group.label}</h3>
      <div class="grid">
        {#each group.symbols as [sym, name], i (sym)}
          {@const k = index[g]?.[i] ?? 0}
          <button type="button" class="sym" tabindex={k === at ? 0 : -1} aria-label="{name} {sym}" title={name} onfocus={() => (at = k)} onclick={() => pick(sym, name)}>{sym}</button>
        {/each}
      </div>
    </div>
  {/each}
  <p class="note">Only symbols the studio’s fonts print the same on every device.</p>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-top: calc(-1 * var(--space-1));
  }
  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .menu {
    display: grid;
    gap: var(--space-2);
  }
  .group {
    display: grid;
    gap: 2px;
  }
  .group-title {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }
  .sym {
    width: 34px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text);
    font-family: 'ptouch JetBrains Mono', 'ptouch B612', var(--font-ui);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .sym:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .sym:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
  .note {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  @media (pointer: coarse) {
    .close {
      min-width: 44px;
      min-height: 44px;
    }
    .sym {
      width: 44px;
      height: 44px;
      font-size: 20px;
    }
  }
</style>
