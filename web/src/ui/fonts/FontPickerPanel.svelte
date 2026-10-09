<!-- Font picker body (docs/FONTS-AND-SIZE-PLAN.md §3.2, P-picker): a lazy chunk, loaded by
     FontPicker.svelte on the first open. A modal <dialog> (top layer: never clipped by the
     scrolling properties column): a popover under the trigger on desktop, a bottom sheet at
     ≤ 600 px (safe-area insets, scrim; a tap on the scrim closes it).

     - Search field: `role="combobox"` driving the listbox with `aria-activedescendant` (↑/↓,
       Page Up/Down, Home/End once a row is active, Enter picks, Escape closes). Accent- and
       case-insensitive, best match first (font-list.ts).
     - Filter chips (toggle buttons, `aria-pressed`, one Tab stop): categories and "Your fonts".
     - One listbox with labelled groups: Favourites, Recent, the categories, Your fonts
       (uploaded), This computer (local). The listbox is focusable too (Tab): there ↑/↓ move,
       Enter/Space pick, **f** stars the active row, other letters continue in the search field.
       Options hold no focusable children; the star in a row is a pointer shortcut only, and the
       "Favourite" button in the footer does the same for keyboard and screen-reader users.
     - Each row previews the block's first line (or the font's sample) in that font. Library
       fonts load as rows scroll into view (render/fonts.ts loadFamily, at most 4 at a time),
       with a spinner while they load; choosing a font that is still loading applies at once
       (the renderer waits for it).
     - Hints: the font-quality warning of the block in words, a "thin / hard to read at this
       size" tag on rows of thin or script fonts when the block's cap height is under 3 mm, and
       a "Crisp" tag on the current pixel font when it renders at a whole multiple of its grid.
     - Footer: Favourite, "Use for new text" (prefs.defaultFont; bundled fonts only), fonts from
       this computer (Local Font Access, asked only from that click), Manage fonts…. -->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { DEFAULT_PREFS } from '../../doc/persist-prefs'
  import type { UserFontInfo } from '../../doc/persist-fonts'
  import { FONTS, familyLoading, familyReady, fontDef, loadFamily, resolveWeight } from '../../render'
  import { customFamily, customFontReady, loadCustomFont } from '../../render/fonts'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { familyPatch, fontKeyOf, pushRecent, toggleFavorite, type FontPatch } from './font-choice'
  import { availableFilters, buildGroups, flatOptions, fontEntries, missingEntry, moveActive, previewText, qualityNote, qualityTag, type FontEntry, type FontFilter } from './font-list'
  import { localFonts, localFontsSupported } from './local-fonts.svelte'
  import type { PanelProps } from './panel-props'

  let { item, anchor, onpick, onclose }: PanelProps = $props()
  const studio = getStudio()
  const uid = $props.id()
  const optId = (i: number): string => `${uid}-o${i}`

  let dialog: HTMLDialogElement | undefined = $state()
  let search: HTMLInputElement | undefined = $state()
  let listbox: HTMLDivElement | undefined = $state()

  // ---- Lists ------------------------------------------------------------------------------

  let userFonts = $state<UserFontInfo[]>([])
  $effect(() => {
    void studio.fontsVersion
    let live = true
    studio.fonts.list().then(
      (l) => live && (userFonts = l),
      () => {},
    )
    return () => (live = false)
  })

  let query = $state('')
  let filters = $state<FontFilter[]>([])
  const filterSet = $derived(new Set(filters))
  const known = $derived(fontEntries(FONTS, userFonts, localFonts.fonts))
  const entries = $derived.by(() => {
    const m = missingEntry(item, known)
    return m ? [...known, m] : known
  })
  const chips = $derived(availableFilters(entries))
  const groups = $derived(buildGroups({ entries, favorites: studio.prefs.favoriteFonts, recent: studio.prefs.recentFonts, query, filters: filterSet }))
  const options = $derived(flatOptions(groups))
  /** Index of each group's first option in `options`. */
  const starts = $derived(groups.map((_, gi) => groups.slice(0, gi).reduce((n, g) => n + g.entries.length, 0)))
  const currentKey = $derived(fontKeyOf(item))
  const favorites = $derived(new Set(studio.prefs.favoriteFonts))

  /** Active option (index into `options`), -1 for none. */
  let active = $state(-1)
  const activeEntry = $derived(options[active]?.entry)
  /** What the footer's Favourite button stars: the keyboard's active row, else the block's font
   * (hovering rows does not change it; its name is on the button). */
  const starTarget = $derived(activeEntry ?? entries.find((e) => e.key === currentKey))

  const status = $derived(query.trim() ? (options.length ? `${options.length} ${options.length === 1 ? 'font matches' : 'fonts match'}` : '') : '')

  // ---- Hints -------------------------------------------------------------------------------

  const def = $derived(fontDef(item.fontFamily))
  const info = $derived(studio.render?.texts?.find((t) => t.itemId === item.id))
  const capMm = $derived.by(() => {
    if (!info) return undefined
    const dpi = studio.target.ok ? studio.target.target.area.dpi : 180
    return (info.capDots * 25.4) / dpi
  })
  const qualityWarning = $derived(studio.render?.warnings.find((w) => w.code === 'font-quality' && w.itemId === item.id))
  const qualityText = $derived(qualityWarning ? ((!item.customFont && qualityNote(def)) || qualityWarning.message) : undefined)
  const crisp = $derived(item.customFont ? undefined : info?.pixelScale)

  const isDefault = $derived(!item.customFont && studio.prefs.defaultFont.family === item.fontFamily && resolveWeight(def, studio.prefs.defaultFont.weight) === resolveWeight(def, item.fontWeight))

  // ---- Previews (lazy) -----------------------------------------------------------------------

  type LoadState = 'loading' | 'ready' | 'failed'
  let loads = $state<Record<string, LoadState>>({})
  /** Rows waiting for a fetch slot; a row that scrolls out of view before its turn leaves it. */
  const queue: FontEntry[] = []
  let running = 0
  let destroyed = false
  /** Fonts fetched at once while rows scroll into view. */
  const MAX_LOADS = 4
  /** A row must stay in view this long before its font is fetched: a flick through the list
   * does not download every font it passes. */
  const SETTLE_MS = 150

  const weightOf = (e: FontEntry): number => (e.def ? resolveWeight(e.def, item.fontWeight) : 400)
  const loadKey = (e: FontEntry): string => `${e.key}@${weightOf(e)}`

  function want(e: FontEntry): void {
    const k = loadKey(e)
    if (loads[k] || e.missing) return
    // The loader's own state (render/fonts.ts): ready, or already being fetched (by the renderer,
    // or another row with this font), which needs no fetch slot.
    if (e.def ? familyReady(e.def.id, weightOf(e)) : e.source && customFontReady(e.source)) {
      loads[k] = 'ready'
      return
    }
    loads[k] = 'loading'
    if (e.def && familyLoading(e.def.id, weightOf(e))) {
      loadFamily(e.def.id, weightOf(e)).then(
        (ok) => (loads[k] = ok ? 'ready' : 'failed'),
        () => (loads[k] = 'failed'),
      )
      return
    }
    queue.push(e)
    pump()
  }

  /** Rows (nearly) in view. */
  const shown = new Set<Element>()

  /** A row left the view: drop its font from the queue if the fetch has not started and no
   * other visible row (Favourites, Recent…) shows the same font. */
  function unwant(e: FontEntry): void {
    const k = loadKey(e)
    for (const el of shown) {
      const other = watched.get(el)
      if (other && loadKey(other) === k) return
    }
    const at = queue.findIndex((q) => loadKey(q) === k)
    if (at < 0) return
    queue.splice(at, 1)
    delete loads[k]
  }

  function pump(): void {
    while (!destroyed && running < MAX_LOADS && queue.length) {
      const e = queue.shift() as FontEntry
      const k = loadKey(e)
      running++
      const p = e.def ? loadFamily(e.def.id, weightOf(e)) : e.source ? loadCustomFont(e.source, (ref) => studio.fonts.get(ref)) : Promise.resolve(false)
      p.then(
        (ok) => (loads[k] = ok ? 'ready' : 'failed'),
        () => (loads[k] = 'failed'),
      ).finally(() => {
        running--
        pump()
      })
    }
  }

  const watched = new WeakMap<Element, FontEntry>()
  const settling = new Map<Element, ReturnType<typeof setTimeout>>()
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (list) => {
            for (const en of list) {
              const e = watched.get(en.target)
              if (!e) continue
              clearTimeout(settling.get(en.target))
              settling.delete(en.target)
              if (en.isIntersecting) shown.add(en.target)
              else shown.delete(en.target)
              if (en.isIntersecting) {
                settling.set(
                  en.target,
                  setTimeout(() => {
                    settling.delete(en.target)
                    want(e)
                  }, SETTLE_MS),
                )
              } else {
                unwant(e)
              }
            }
          },
          { rootMargin: '120px 0px' },
        )
      : undefined
  onDestroy(() => {
    // Closing stops the queue; fetches already running finish (they cannot be cancelled).
    destroyed = true
    queue.length = 0
    for (const t of settling.values()) clearTimeout(t)
    settling.clear()
    shown.clear()
    io?.disconnect()
  })

  /** Loads a row's font once it is (nearly) visible. */
  function lazyPreview(e: FontEntry): Attachment<HTMLElement> {
    return (el) => {
      if (!io) return void want(e)
      watched.set(el, e)
      io.observe(el)
      return () => {
        clearTimeout(settling.get(el))
        settling.delete(el)
        shown.delete(el)
        io.unobserve(el)
      }
    }
  }

  function previewCss(e: FontEntry): string {
    if (e.def) return `"${e.def.family}", ${e.def.generic}`
    return e.source && !e.missing ? `"${customFamily(e.source)}", ${def.generic}` : def.generic
  }
  const sample = (e: FontEntry): string => previewText(item.text) || e.def?.preview || e.label

  // ---- Placement -----------------------------------------------------------------------------

  const sheetQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 600px)') : undefined
  let sheet = $state(sheetQuery?.matches ?? false)
  let pos = $state<{ top?: number; bottom?: number; left: number; width: number; maxH: number } | null>(null)

  function place(): void {
    sheet = sheetQuery?.matches ?? false
    if (sheet || !anchor) return
    const r = anchor.getBoundingClientRect()
    const vw = innerWidth
    const vh = innerHeight
    const width = Math.min(Math.max(r.width, 360), vw - 16)
    const left = Math.min(Math.max(8, r.left), vw - width - 8)
    const below = vh - r.bottom - 12
    const above = r.top - 12
    pos = below >= 360 || below >= above ? { top: r.bottom + 4, left, width, maxH: Math.min(560, below) } : { bottom: vh - r.top + 4, left, width, maxH: Math.min(560, above) }
  }

  onMount(() => {
    place()
    dialog?.showModal()
    const at = untrack(() => options.findIndex((o) => o.entry.key === currentKey))
    active = at
    if (at >= 0) document.getElementById(optId(at))?.scrollIntoView({ block: 'center' })
    // The sheet opens on the list (no on-screen keyboard over it); the popover on the search.
    ;(sheet ? listbox : search)?.focus()
  })

  $effect(() => {
    // `.opt` has a scroll margin of the sticky group label's height, so the row never ends up
    // under the label when moving up.
    if (active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' })
  })

  function onViewportChange(e: Event): void {
    if (e.type === 'scroll' && dialog?.contains(e.target as Node)) return
    place()
  }

  // ---- Actions -------------------------------------------------------------------------------

  function close(): void {
    if (dialog?.open) dialog.close()
    onclose()
  }

  function pick(e: FontEntry | undefined): void {
    if (!e) return
    if (!e.missing) {
      const patch: FontPatch | undefined = e.def ? familyPatch(item, e.def.id) : e.source ? { customFont: e.source } : undefined
      if (patch) {
        studio.updatePrefs({ recentFonts: pushRecent(studio.prefs.recentFonts, e.key) })
        onpick(patch)
        studio.announce(`Font: ${e.label}`)
      }
    }
    close()
  }

  function toggleStar(e: FontEntry | undefined): void {
    if (!e || e.missing) return
    const was = favorites.has(e.key)
    studio.updatePrefs({ favoriteFonts: toggleFavorite(studio.prefs.favoriteFonts, e.key) })
    studio.announce(was ? `${e.label} removed from favourites` : `${e.label} added to favourites`)
  }

  function toggleDefault(): void {
    if (item.customFont) return
    studio.updatePrefs({ defaultFont: isDefault ? DEFAULT_PREFS.defaultFont : { family: item.fontFamily, weight: resolveWeight(def, item.fontWeight) } })
  }

  function toggleFilter(id: FontFilter): void {
    filters = filters.includes(id) ? filters.filter((f) => f !== id) : [...filters, id]
    active = -1
  }

  /** The chip that has the Tab stop. */
  let chipAt = $state(0)
  function onChipKey(e: KeyboardEvent): void {
    const n = chips.length
    const next = e.key === 'ArrowRight' ? (chipAt + 1) % n : e.key === 'ArrowLeft' ? (chipAt - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    chipAt = next
    ;(e.currentTarget as HTMLElement).querySelectorAll('button')[next]?.focus()
  }

  function manage(): void {
    close()
    studio.openDialog('fonts')
  }

  // ---- Keyboard ------------------------------------------------------------------------------

  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      pick(options[active >= 0 ? active : query.trim() ? 0 : -1]?.entry)
      return
    }
    // Home/End move the caret until the user walks the list.
    if ((e.key === 'Home' || e.key === 'End') && active < 0) return
    const next = moveActive(active, e.key, options.length)
    if (next === undefined) return
    e.preventDefault()
    active = next
  }

  function onListKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Enter' || e.key === ' ') pick(activeEntry)
    else if (e.key === 'f' || e.key === 'F') toggleStar(activeEntry)
    else if (e.key.length === 1 && e.key.trim()) {
      // Any other letter continues in the search field.
      query += e.key
      active = -1
      search?.focus()
    } else {
      const next = moveActive(active, e.key, options.length)
      if (next === undefined) return
      active = next
    }
    e.preventDefault()
    e.stopPropagation()
  }
</script>

<svelte:window onresize={onViewportChange} onscrollcapture={onViewportChange} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="fp"
  class:sheet
  aria-labelledby="{uid}-title"
  style:top={!sheet && pos?.top !== undefined ? `${pos.top}px` : null}
  style:bottom={!sheet && pos?.bottom !== undefined ? `${pos.bottom}px` : null}
  style:left={!sheet && pos ? `${pos.left}px` : null}
  style:width={!sheet && pos ? `${pos.width}px` : null}
  style:max-height={!sheet && pos ? `${pos.maxH}px` : null}
  oncancel={(e) => {
    e.preventDefault()
    close()
  }}
  onclick={(e) => {
    // A click on the dialog box itself is a click on the backdrop (the body fills the box).
    if (e.target === dialog) close()
  }}
>
  <div class="body">
    <header>
      <h2 id="{uid}-title">Choose a font</h2>
      <button type="button" class="btn ghost icon small" aria-label="Close" onclick={close}><Icon name="x" size={16} /></button>
    </header>

    {#if qualityText}
      <p class="note" role="note"><Icon name="alert" size={14} />{qualityText}</p>
    {/if}

    <div class="search">
      <Icon name="search" size={16} />
      <input
        bind:this={search}
        type="text"
        class="input"
        role="combobox"
        aria-label="Search fonts"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optId(active) : undefined}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="done"
        placeholder="Search fonts"
        value={query}
        oninput={(e) => {
          query = e.currentTarget.value
          active = -1
        }}
        onkeydown={onSearchKey}
      />
    </div>

    {#if chips.length > 1}
      <!-- One Tab stop for all chips (roving tabindex; ←/→, Home/End move between them). -->
      <div class="chips" role="group" aria-label="Filter by style" onkeydown={onChipKey}>
        {#each chips as c, ci (c.id)}
          <button type="button" class="chip" tabindex={ci === chipAt ? 0 : -1} aria-pressed={filters.includes(c.id)} onclick={() => toggleFilter(c.id)} onfocus={() => (chipAt = ci)}>{c.label}</button>
        {/each}
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={listbox}
      class="list"
      id="{uid}-list"
      role="listbox"
      aria-label="Fonts"
      tabindex="0"
      aria-activedescendant={active >= 0 ? optId(active) : undefined}
      onkeydown={onListKey}
      onfocus={() => {
        if (active < 0 && options.length) active = Math.max(0, options.findIndex((o) => o.entry.key === currentKey))
      }}
    >
      {#each groups as g, gi (g.id)}
        <div role="group" aria-labelledby="{uid}-g-{g.id}">
          <div class="group-label" id="{uid}-g-{g.id}" role="presentation">{g.label}</div>
          {#each g.entries as e, ei (e.key)}
            {@const i = (starts[gi] ?? 0) + ei}
            {@const state = loads[loadKey(e)]}
            {@const tag = qualityTag(e.def, capMm)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              role="option"
              id={optId(i)}
              tabindex="-1"
              class="opt"
              class:active={i === active}
              aria-selected={e.key === currentKey}
              data-state={state}
              onpointerdown={(ev) => {
                // Keep focus in the search field on a mouse press. Not on touch: WebKit then drops
                // the tap's click, and the sheet focuses the list anyway.
                if (ev.pointerType === 'mouse') ev.preventDefault()
              }}
              onclick={() => pick(e)}
              {@attach lazyPreview(e)}
            >
              <span class="head">
                <span class="name">{e.label}{#if e.missing} (not on this device){/if}{#if favorites.has(e.key)}<span class="visually-hidden">, favourite</span>{/if}</span>
                {#if tag}<span class="tag warn">{tag}</span>{/if}
                {#if crisp && e.key === currentKey}<span class="tag ok">Crisp</span>{/if}
                {#if state === 'loading'}<span class="spin" data-testid="font-loading" aria-hidden="true"><Icon name="loader" size={14} /></span>{/if}
                {#if !e.missing}
                  <!-- Pointer shortcut only (no focusable child in an option): keyboard users press
                       f or use the Favourite button in the footer. -->
                  <span
                    class="star"
                    class:on={favorites.has(e.key)}
                    aria-hidden="true"
                    title={favorites.has(e.key) ? 'Remove from favourites' : 'Add to favourites'}
                    onclick={(ev) => {
                      ev.stopPropagation()
                      toggleStar(e)
                    }}><Icon name="star" size={16} /></span
                  >
                {/if}
              </span>
              <span class="preview" aria-hidden="true" style:font-family={previewCss(e)} style:font-weight={weightOf(e)} style:font-style={item.italic ? 'italic' : null}>{sample(e)}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
    {#if !options.length}<p class="empty">No fonts match “{query.trim()}”.</p>{/if}
    <p class="visually-hidden" role="status">{status}</p>

    {#if localFonts.error}<p class="hint warn">{localFonts.error}</p>{/if}

    <footer>
      <button
        type="button"
        class="btn small"
        aria-label={starTarget ? `Favourite: ${starTarget.label}` : 'Favourite'}
        aria-pressed={!!starTarget && favorites.has(starTarget.key)}
        disabled={!starTarget || starTarget.missing}
        onclick={() => toggleStar(starTarget)}
      >
        <span class="star-btn" class:on={!!starTarget && favorites.has(starTarget.key)}><Icon name="star" size={16} /></span><span class="star-label">Favourite{starTarget ? `: ${starTarget.label}` : ''}</span>
      </button>
      {#if !item.customFont}
        <button type="button" class="btn small" aria-pressed={isDefault} onclick={toggleDefault}>{#if isDefault}<Icon name="check" size={16} />{/if}Use for new text</button>
      {/if}
      {#if localFontsSupported() && localFonts.status !== 'ready'}
        <button type="button" class="btn small" disabled={localFonts.status === 'loading'} onclick={() => void localFonts.query()}>Fonts on this computer…</button>
      {/if}
      <button type="button" class="btn small" onclick={manage}>Manage fonts…</button>
    </footer>
  </div>
</dialog>

<style>
  dialog.fp {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0;
    width: 380px;
    max-width: none;
    max-height: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-2);
    overflow: hidden;
  }
  dialog.fp[open] {
    display: flex;
    flex-direction: column;
  }
  dialog.fp::backdrop {
    background: transparent;
  }
  dialog.fp.sheet {
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-height: min(85dvh, 720px);
    border-bottom: 0;
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    animation: rise 160ms var(--ease);
  }
  dialog.fp.sheet::backdrop {
    background: var(--scrim);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) 0;
  }
  .sheet .body {
    padding-left: max(var(--space-3), env(safe-area-inset-left, 0px));
    padding-right: max(var(--space-3), env(safe-area-inset-right, 0px));
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  .note {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: 0;
    padding: var(--space-2);
    border-radius: var(--radius-s);
    background: var(--warn-soft);
    font-size: 13px;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }
  .search {
    position: relative;
  }
  .search :global(svg) {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .search .input {
    padding-left: 34px;
  }
  header,
  .note,
  .search,
  .chips,
  footer {
    flex: none;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding-bottom: 2px;
  }
  /* The phone sheet keeps one swipeable row (vertical room is scarce there). */
  .sheet .chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .chip {
    flex: none;
    min-height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-radius: 999px;
    background: var(--surface);
    font-size: 12px;
    cursor: pointer;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 600;
  }
  .list {
    /* Height of a sticky group label: options scroll into view below it, never under it. */
    --group-label-h: 28px;
    scroll-padding-top: var(--group-label-h);
    flex: 1;
    min-height: 120px;
    overflow-y: auto;
    overscroll-behavior: contain;
    margin: 0 calc(-1 * var(--space-1));
    padding: 0 var(--space-1) var(--space-2);
    border-radius: var(--radius-s);
  }
  .list:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .group-label {
    position: sticky;
    top: 0;
    z-index: 1;
    box-sizing: border-box;
    height: var(--group-label-h);
    line-height: 16px;
    padding: var(--space-2) var(--space-2) var(--space-1);
    background: var(--surface);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .opt {
    scroll-margin-top: var(--group-label-h);
    display: grid;
    gap: 2px;
    padding: 6px var(--space-2);
    border-radius: var(--radius-s);
    cursor: pointer;
  }
  .opt:hover {
    background: var(--surface-2);
  }
  .opt.active {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 2px var(--focus);
  }
  .opt[aria-selected='true'] {
    background: var(--accent-soft);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .opt[aria-selected='true'] .name {
    color: var(--text);
    font-weight: 600;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
  }
  .tag.warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .tag.ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .spin {
    display: inline-flex;
    animation: spin 0.9s linear infinite;
  }
  .star {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -4px -4px -4px 0;
    border-radius: var(--radius-s);
    color: var(--text-muted);
  }
  .star:hover {
    background: var(--surface-3);
  }
  .star.on,
  .star-btn.on {
    color: var(--warn);
  }
  .star.on :global(path),
  .star-btn.on :global(path) {
    fill: currentColor;
  }
  .star-btn {
    display: inline-flex;
  }
  .star-label {
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 22px;
    line-height: 1.25;
    color: var(--text);
  }
  .opt[data-state='loading'] .preview {
    opacity: 0.45;
  }
  .empty {
    margin: 0;
    padding: var(--space-3) var(--space-2);
    color: var(--text-muted);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0 calc(-1 * var(--space-3));
    padding: var(--space-2) var(--space-3);
    padding-bottom: max(var(--space-2), env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--border);
  }
  @media (pointer: coarse) {
    .star {
      width: 44px;
      height: 44px;
      margin: -8px -8px -8px 0;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes rise {
    from {
      transform: translateY(24px);
      opacity: 0.6;
    }
  }
</style>
