// W4 — the app's reactive state (Svelte 5 runes). Wires: doc ↔ history ↔ autosave (W5),
// doc → renderer (W3) → preview, ConnectionManager (W2) snapshot, print pipeline.
// Components receive the Studio instance via context (`getStudio()`), never globals.
//
// The document is IMMUTABLE: every edit builds a new doc with doc/ops.ts and calls `setDoc`
// (`$state.raw`, so history snapshots are plain objects, never Svelte proxies).
//
// Members W5 relies on (keep): support, connection, conn, doc, setDoc, render, prefs, view,
// setView, wasm.
import { getContext, setContext, untrack } from 'svelte'
import { TAPE_WIDTHS_MM, createDoc, newId, type Item, type ItemKind, type LabelDoc, type TapeWidthMm } from '../../doc/schema'
import { addItem, duplicateItem, moveItem, removeItem, updateDoc, updateItem } from '../../doc/ops'
import { createHistory, type History } from '../../doc/history'
import { loadPrefs, savePrefs, type Prefs } from '../../doc/persist-prefs'
import { createAutosave, openLabelStore, type Autosave, type LabelStore } from '../../doc/persist'
import { SHARE_PREFIX, createShareLink, parseShareFragment } from '../../doc/persist-share'
import { exportLabelFile, importLabelFile } from '../../doc/persist-files'
import {
  ConnectionManager,
  INITIAL_SNAPSHOT,
  describeProblem,
  detectSupport,
  isUserCancel,
  type ConnectPath,
  type ConnectionSnapshot,
  type Problem,
  type ProblemAction,
  type SupportInfo,
} from '../../printer'
import { buildPrintJob, ensureFonts, renderLabel, thumbnailPng, type RenderResult, type RenderTarget } from '../../render'
import { isPtouchError, listModels, loadWasm, mediaForWidth, printArea, type ModelInfo } from '../../wasm'
import { inShortcutScope, matchShortcut, isEditableTarget, type ShortcutAction } from './shortcuts'
import { clampCopies, docIsEmpty, fitScale, mediaMismatch, previewColors, printBlockReason, realScale, tapeText, zoomStep, type Zoom } from './view-model'

export type View = 'studio' | 'diagnostics'
export type WasmState = 'loading' | 'ready' | 'error'

/** Model assumed for offline design (the only hardware-verified model). */
export const DEFAULT_MODEL = 'PT-P710BT'

export type TargetState = { ok: true; target: RenderTarget } | { ok: false; error: string | null }

export interface Toast {
  id: number
  tone: 'ok' | 'info' | 'error'
  title: string
  detail?: string
  action?: { label: string; run: () => void }
}

/** A loaded media width the editor can design for (TZe widths; not e.g. 11.7 mm tube). */
function isTapeWidth(mm: number): mm is TapeWidthMm {
  return (TAPE_WIDTHS_MM as readonly number[]).includes(mm)
}

/** Error → one-line message for the UI (never shown for printer problems: those use Problems). */
export function errorMessage(e: unknown): string {
  if (isPtouchError(e)) return e.message || e.code
  if (e instanceof Error) return e.message
  return String(e)
}

export class Studio {
  readonly support: SupportInfo
  readonly connection: ConnectionManager
  readonly history: History
  readonly store: LabelStore
  readonly autosave: Autosave

  prefs = $state.raw<Prefs>(loadPrefs())
  view = $state<View>(location.hash === '#diagnostics' ? 'diagnostics' : 'studio')
  wasm = $state<WasmState>('loading')
  /** Immutable; replace via setDoc / openDoc. */
  doc = $state.raw<LabelDoc>(createDoc())
  /** Doc opened from a newer schema: the first edit forks it into a copy. */
  readOnly = $state(false)
  selectedId = $state<string | null>(null)
  conn = $state.raw<ConnectionSnapshot>(INITIAL_SNAPSHOT)
  /** Latest render (raw, not proxied: holds a wasm handle). */
  render = $state.raw<RenderResult | null>(null)
  renderError = $state<string | null>(null)
  rendering = $state(false)
  connectOpen = $state(false)
  shortcutsOpen = $state(false)
  libraryOpen = $state(false)
  /** User dismissed the unsupported-browser screen to design anyway. */
  designAnyway = $state(false)
  /** Print requested from this tab and not yet settled. */
  printing = $state(false)
  toasts = $state<Toast[]>([])
  /** Preview zoom: 'fit' or a multiple of real size. */
  zoom = $state<Zoom>('fit')
  /** Last computed fit scale (CSS px per dot), published by the preview for the zoom readout. */
  fitScaleValue = $state(1)
  /** Polite screen-reader announcements (block moved, label printed…). */
  announcement = $state('')
  /** Bumped on every history change so canUndo/canRedo re-derive. */
  #historyTick = $state(0)

  get canUndo(): boolean {
    void this.#historyTick // reactive dependency: History itself is not reactive
    return this.history.canUndo
  }
  get canRedo(): boolean {
    void this.#historyTick
    return this.history.canRedo
  }
  readonly selected = $derived(this.doc.items.find((i) => i.id === this.selectedId) ?? null)

  /** The model to design/print for: the connected printer's, else the default. */
  readonly model = $derived(this.conn.model ?? this.conn.status?.modelName ?? DEFAULT_MODEL)

  readonly modelInfo = $derived.by<ModelInfo | null>(() => {
    if (this.wasm !== 'ready') return null
    const name = this.model
    try {
      return listModels().find((m) => m.name === name || m.aliases.includes(name)) ?? null
    } catch {
      return null
    }
  })

  /** Render target for the doc's tape: exact loaded media when it matches, else by width. */
  readonly target = $derived.by<TargetState>(() => {
    if (this.wasm !== 'ready') return { ok: false, error: null }
    const model = this.model
    const width = this.doc.tape.widthMm
    const loaded = this.conn.media
    try {
      const media =
        loaded && Math.abs(loaded.widthMm - width) < 0.01
          ? loaded
          : (this.modelInfo?.media.find((m) => m.id === this.doc.tape.mediaId && Math.abs(m.widthMm - width) < 0.01) ?? mediaForWidth(model, width))
      return { ok: true, target: { model, media, area: printArea(model, media.id) } }
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  })

  readonly mismatch = $derived(mediaMismatch(this.conn, this.doc))

  readonly printBlocked = $derived(
    printBlockReason({
      wasm: this.wasm,
      renderError: this.renderError ?? (this.target.ok ? null : this.target.error),
      hasRender: this.render !== null,
      blocking: this.render?.blocking ? (this.render.warnings.find((w) => w.code === 'canvas-noise' || w.code === 'code-invalid') ?? this.render.warnings[0] ?? { message: 'The label cannot be printed as designed.' }) : null,
      isEmpty: docIsEmpty(this.doc),
      conn: this.conn,
      mismatch: this.mismatch,
      canPrint: this.#canPrint(),
    }),
  )

  #canPrint(): boolean {
    return this.support.canPrint
  }

  /** Effective preview scale (CSS px per dot). */
  readonly scale = $derived.by(() => {
    const dpi = this.target.ok ? this.target.target.area.dpi : 180
    return this.zoom === 'fit' ? this.fitScaleValue : this.zoom * realScale(dpi)
  })

  /** The open doc came from a share link and is neither saved nor remembered until edited. */
  #unsaved = false
  #renderTimer: ReturnType<typeof setTimeout> | undefined
  #renderAbort: AbortController | null = null
  #toastSeq = 0
  #disposeEffects: (() => void) | undefined
  #lastMediaId: string | null = null
  /** The doc object the current `render` was made from. */
  #renderedDoc: LabelDoc | null = null
  /** model|media of the target the current `render` was made for. */
  #renderedKey = ''
  #renderKey = ''
  #renderKeyDoc: LabelDoc | null = null

  /** ⌘ (Apple) or Ctrl shortcuts. */
  readonly isMac: boolean

  constructor() {
    this.selectedId = this.doc.items[0]?.id ?? null
    this.support = detectSupport(undefined, { usbOnWindows: this.prefs.usbOnWindows })
    this.isMac = this.support.platform === 'mac' || this.support.platform === 'ios' || /Mac|iPhone|iPad/.test(navigator.platform)
    this.history = createHistory(this.doc)
    this.store = openLabelStore()
    this.autosave = createAutosave(this.store, 500, (e) => this.toast('error', 'Could not save the label', errorMessage(e)), {
      thumbnail: (doc) => this.#thumbnail(doc),
    })
    this.connection = new ConnectionManager({
      support: this.support,
      designWidthMm: () => this.doc.tape.widthMm,
      remember: (c) =>
        (this.prefs = savePrefs(c ? { lastPath: c.path, ...(c.transport ? { lastTransport: c.transport } : {}), autoReconnect: true } : { autoReconnect: false })),
      recall: () => (this.prefs.lastPath && this.prefs.autoReconnect ? { path: this.prefs.lastPath, ...(this.prefs.lastTransport ? { transport: this.prefs.lastTransport as never } : {}) } : null),
    })
    this.designAnyway = this.prefs.designAnyway
    let previousState = INITIAL_SNAPSHOT.state
    this.connection.subscribe((s) => {
      const was = previousState
      previousState = s.state
      this.conn = s
      // A successful connect is announced (the dialog's live region is gone by then).
      if (s.state === 'ready' && (was === 'opening' || was === 'waking' || was === 'handshaking')) {
        const tape = tapeText(s)
        this.announce(`Connected to ${s.model ?? 'the printer'}${tape ? `, ${tape} tape` : ''}`)
      }
    })
    this.applyTheme(this.prefs.theme)

    this.#disposeEffects = $effect.root(() => {
      // Re-render whenever the doc or the target changes (debounced, stale renders aborted).
      $effect(() => {
        const doc = this.doc
        const target = this.target
        if (!target.ok) {
          this.#renderKey = ''
          if (target.error) this.#clearRender(target.error)
          return
        }
        // Status pushes (keepalive, printing) rebuild `target` with equal contents: skip those.
        const key = `${target.target.model}|${target.target.media.id}`
        if (doc === this.#renderKeyDoc && key === this.#renderKey) return
        this.#renderKeyDoc = doc
        this.#renderKey = key
        untrack(() => this.#scheduleRender(doc, target.target))
      })
      // Loaded tape changed (connect, cassette swap): adopt it for a pristine doc.
      $effect(() => {
        const media = this.conn.media
        const id = media?.id ?? null
        if (id === this.#lastMediaId) return
        this.#lastMediaId = id
        if (!media) return
        untrack(() => {
          if (Math.abs(media.widthMm - this.doc.tape.widthMm) < 0.01) return
          // Only a brand-new, untouched label follows the cassette; anything designed keeps its
          // width and gets the mismatch banner with a one-click switch instead.
          const pristine = this.doc.createdAt === this.doc.updatedAt && !this.canUndo && !this.readOnly
          if (pristine && isTapeWidth(media.widthMm)) {
            this.setDoc(updateDoc(this.doc, { tape: { ...this.doc.tape, widthMm: media.widthMm, mediaId: media.id } }))
            this.toast('info', `Switched to the loaded ${media.widthMm} mm tape`, undefined, { label: 'Undo', run: () => this.undo() })
          }
        })
      })
    })
  }

  // -------------------------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------------------------

  /** Boot sequence: wasm → fonts → share link or last label → auto-reconnect. */
  async start(): Promise<void> {
    try {
      await loadWasm()
      this.wasm = 'ready'
    } catch (e) {
      console.error('wasm failed to load', e)
      this.wasm = 'error'
      return
    }
    await this.#restoreDoc()
    if (this.prefs.autoReconnect && this.prefs.lastPath && this.prefs.lastPath !== 'virtual') {
      try {
        await this.connection.restore()
      } catch (e) {
        console.warn('auto-reconnect failed', e)
      }
    }
  }

  async #restoreDoc(): Promise<void> {
    if (location.hash.startsWith(SHARE_PREFIX)) {
      const hash = location.hash
      // Clear the fragment first so a reload never imports the label twice.
      history.replaceState(null, '', location.pathname + location.search)
      try {
        // A pasted link replaces the open label: save its last edit first.
        await this.autosave.flush().catch(() => {})
        const shared = await parseShareFragment(hash, this.store)
        if (shared) {
          // Not saved (and not reopened on the next visit) until the user edits it: a link alone
          // never adds anything to the label list.
          this.openDoc(shared.doc, { readOnly: shared.readOnly, save: false, remember: false })
          this.toast('info', 'Opened a shared label', shared.notices.join(' ') || 'Edit it to keep a copy in this browser’s label list.')
          return
        }
      } catch (e) {
        this.toast('error', 'This share link could not be opened', errorMessage(e))
      }
    }
    if (this.prefs.lastLabelId) {
      const before = this.doc
      try {
        const found = await this.store.load(this.prefs.lastLabelId)
        // The editor is usable while this loads: never overwrite edits made meanwhile.
        if (found && this.doc === before) {
          this.openDoc(found.doc, { readOnly: found.readOnly, save: false })
          return
        }
      } catch (e) {
        console.warn('could not restore the last label', e)
      }
    }
    // Keep the current doc (new, or already being edited): only remember it. History stays.
    this.prefs = savePrefs({ lastLabelId: this.doc.id })
  }

  // -------------------------------------------------------------------------------------------
  // Views, theme, toasts
  // -------------------------------------------------------------------------------------------

  setView(view: View): void {
    this.view = view
    history.replaceState(null, '', view === 'diagnostics' ? '#diagnostics' : location.pathname + location.search)
  }

  /** `hashchange`: #diagnostics switches views; a pasted share link (#d=…) opens the label. */
  onHashChange(): void {
    if (location.hash === '#diagnostics') {
      this.view = 'diagnostics'
    } else if (location.hash.startsWith(SHARE_PREFIX)) {
      this.view = 'studio'
      void this.#restoreDoc()
    } else if (this.view === 'diagnostics') {
      this.view = 'studio'
    }
  }

  setTheme(theme: Prefs['theme']): void {
    this.prefs = savePrefs({ theme })
    this.applyTheme(theme)
  }

  applyTheme(theme: Prefs['theme']): void {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }

  toast(tone: Toast['tone'], title: string, detail?: string, action?: Toast['action']): number {
    const id = ++this.#toastSeq
    this.toasts = [...this.toasts.slice(-3), { id, tone, title, ...(detail ? { detail } : {}), ...(action ? { action } : {}) }]
    if (tone !== 'error') setTimeout(() => this.dismissToast(id), action ? 8000 : 4500)
    return id
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id)
  }

  announce(text: string): void {
    // Re-set even when equal so screen readers repeat it.
    this.announcement = ''
    queueMicrotask(() => (this.announcement = text))
  }

  // -------------------------------------------------------------------------------------------
  // Document editing
  // -------------------------------------------------------------------------------------------

  /** Replace the doc (edit): history, autosave, re-render (via effect). */
  setDoc(doc: LabelDoc, coalesceKey?: string): void {
    if (this.#unsaved) {
      this.#unsaved = false
      this.prefs = savePrefs({ lastLabelId: doc.id })
    }
    if (this.readOnly) {
      doc = { ...doc, id: newId(), name: `${doc.name} (copy)` }
      this.readOnly = false
      this.prefs = savePrefs({ lastLabelId: doc.id })
      this.toast('info', 'Saved as a copy', 'The original was made with a newer version and stays unchanged.')
    }
    this.doc = doc
    this.history.push(doc, coalesceKey)
    this.#historyTick++
    this.autosave.schedule(doc)
  }

  /** Open a document (new, from the library, import, share link): resets history. */
  openDoc(doc: LabelDoc, opts: { readOnly?: boolean; save?: boolean; remember?: boolean } = {}): void {
    this.doc = doc
    this.readOnly = opts.readOnly ?? false
    this.history.reset(doc)
    this.#historyTick++
    this.selectedId = doc.items[0]?.id ?? null
    this.#unsaved = opts.remember === false
    if (!this.#unsaved) this.prefs = savePrefs({ lastLabelId: doc.id })
    if (opts.save !== false && !this.readOnly) this.autosave.schedule(doc)
  }

  newLabel(): void {
    void this.autosave.flush().catch(() => {})
    const loaded = this.conn.media && isTapeWidth(this.conn.media.widthMm) ? this.conn.media : null
    const doc = createDoc({ tape: { widthMm: loaded ? (loaded.widthMm as TapeWidthMm) : this.doc.tape.widthMm, ...(loaded ? { mediaId: loaded.id } : {}) } })
    this.openDoc(doc)
    this.announce('New label')
  }

  undo(): void {
    const doc = this.history.undo()
    if (!doc) return
    this.doc = doc
    this.#historyTick++
    this.autosave.schedule(doc)
    if (this.selectedId && !doc.items.some((i) => i.id === this.selectedId)) this.selectedId = doc.items[0]?.id ?? null
    this.announce('Undone')
  }

  redo(): void {
    const doc = this.history.redo()
    if (!doc) return
    this.doc = doc
    this.#historyTick++
    this.autosave.schedule(doc)
    this.announce('Redone')
  }

  select(id: string | null): void {
    this.selectedId = id
  }

  /** Insert a new block after the selection; `patch` customises it (one undo step). */
  insert<K extends ItemKind>(kind: K, patch?: Partial<Omit<Extract<Item, { kind: K }>, 'id' | 'kind'>>): string {
    const [added, id] = addItem(this.doc, kind, this.selectedId ?? undefined)
    const doc = patch ? updateItem(added, id, patch) : added
    this.setDoc(doc)
    this.selectedId = id
    this.announce(`Added ${kind} block`)
    return id
  }

  updateItem<T extends Item>(id: string, patch: Partial<Omit<T, 'id' | 'kind'>>, coalesceKey?: string): void {
    this.setDoc(updateItem<T>(this.doc, id, patch), coalesceKey)
  }

  updateDoc(patch: Parameters<typeof updateDoc>[1], coalesceKey?: string): void {
    this.setDoc(updateDoc(this.doc, patch), coalesceKey)
  }

  removeItem(id: string): void {
    const items = this.doc.items
    const at = items.findIndex((i) => i.id === id)
    if (at < 0) return
    this.setDoc(removeItem(this.doc, id))
    const next = this.doc.items[Math.min(at, this.doc.items.length - 1)]
    this.selectedId = next?.id ?? null
    this.announce('Block deleted')
  }

  duplicate(id: string): void {
    try {
      const [doc, newIdValue] = duplicateItem(this.doc, id)
      this.setDoc(doc)
      this.selectedId = newIdValue
      this.announce('Block duplicated')
    } catch (e) {
      this.toast('error', 'Could not duplicate the block', errorMessage(e))
    }
  }

  /** Move by `delta` positions (Alt+↑/↓, buttons). */
  move(id: string, delta: number): void {
    const from = this.doc.items.findIndex((i) => i.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= this.doc.items.length) return
    this.moveTo(id, to)
  }

  moveTo(id: string, to: number): void {
    const from = this.doc.items.findIndex((i) => i.id === id)
    if (from < 0 || from === to) return
    this.setDoc(moveItem(this.doc, id, to))
    this.announce(`Moved to position ${to + 1} of ${this.doc.items.length}`)
  }

  selectRelative(delta: number): void {
    const items = this.doc.items
    if (!items.length) return
    const at = items.findIndex((i) => i.id === this.selectedId)
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, at + delta))
    this.selectedId = items[next]?.id ?? null
  }

  setTapeWidth(widthMm: TapeWidthMm): void {
    if (widthMm === this.doc.tape.widthMm) return
    const { mediaId: _drop, ...tape } = this.doc.tape
    void _drop
    const loaded = this.conn.media && Math.abs(this.conn.media.widthMm - widthMm) < 0.01 ? { mediaId: this.conn.media.id } : {}
    this.updateDoc({ tape: { ...tape, ...loaded, widthMm } })
  }

  /** "Use loaded 12 mm tape" (problem action `switch-tape`, mismatch banner). */
  useLoadedTape(): void {
    const media = this.conn.media
    if (!media) return
    if (!isTapeWidth(media.widthMm)) {
      // e.g. 11.7 mm heat-shrink tube: the core knows it, the editor's widths don't (yet).
      this.toast('info', `The loaded ${media.widthMm} mm media can’t be designed for yet`, 'Load a TZe tape cassette (3.5–24 mm).')
      return
    }
    this.updateDoc({ tape: { ...this.doc.tape, widthMm: media.widthMm, mediaId: media.id } })
    this.toast('ok', `Label switched to ${media.widthMm} mm tape`)
  }

  setCopies(n: number): void {
    this.updateDoc({ print: { ...this.doc.print, copies: clampCopies(n) } }, 'print:copies')
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  #scheduleRender(doc: LabelDoc, target: RenderTarget): void {
    clearTimeout(this.#renderTimer)
    this.#renderAbort?.abort()
    this.rendering = true
    this.#renderTimer = setTimeout(() => void this.#runRender(doc, target), this.render ? 50 : 0)
  }

  async #runRender(doc: LabelDoc, target: RenderTarget): Promise<void> {
    const ac = new AbortController()
    this.#renderAbort = ac
    try {
      await ensureFonts(doc)
      if (ac.signal.aborted) return
      const result = await renderLabel(doc, target, { loadBlob: (ref) => this.store.getBlob(ref), signal: ac.signal })
      if (ac.signal.aborted) {
        result.bitmap.free()
        return
      }
      const old = this.render
      this.render = result
      this.#scheduleFontRetry(result.warnings.some((w) => w.code === 'font-fallback'))
      this.#renderedDoc = doc
      this.#renderedKey = `${target.model}|${target.media.id}`
      this.renderError = null
      old?.bitmap.free()
    } catch (e) {
      if (ac.signal.aborted) return
      console.error('render failed', e)
      this.renderError = errorMessage(e)
    } finally {
      if (this.#renderAbort === ac) {
        this.#renderAbort = null
        this.rendering = false
      }
    }
  }

  #fontRetryTimer: ReturnType<typeof setTimeout> | undefined
  #fontRetryDelay = 5000
  #onOnline = (): void => this.#retryFonts()

  /** A font fell back (offline, fetch error): render again when it may load (back online, or
   * with backoff), so the preview and the print do not keep the stand-in font. */
  #scheduleFontRetry(fallback: boolean): void {
    clearTimeout(this.#fontRetryTimer)
    window.removeEventListener('online', this.#onOnline)
    if (!fallback) {
      this.#fontRetryDelay = 5000
      return
    }
    window.addEventListener('online', this.#onOnline, { once: true })
    this.#fontRetryTimer = setTimeout(() => this.#retryFonts(), this.#fontRetryDelay)
    this.#fontRetryDelay = Math.min(this.#fontRetryDelay * 3, 5 * 60_000)
  }

  #retryFonts(): void {
    clearTimeout(this.#fontRetryTimer)
    if (this.target.ok && !this.rendering) this.#scheduleRender(this.doc, this.target.target)
  }

  /** Library thumbnail from the current render, if it shows `doc` (autosave calls this). */
  async #thumbnail(doc: LabelDoc): Promise<Blob | undefined> {
    const r = this.render
    if (!r || this.#renderedDoc !== doc) return undefined
    const bitmap = r.bitmap.clone() // own handle: the render may be replaced while we encode
    try {
      return await thumbnailPng(bitmap, previewColors(this.conn, doc))
    } finally {
      bitmap.free()
    }
  }

  #clearRender(error: string): void {
    clearTimeout(this.#renderTimer)
    this.#renderAbort?.abort()
    this.rendering = false
    const old = this.render
    this.render = null
    old?.bitmap.free()
    this.renderError = error
  }

  // -------------------------------------------------------------------------------------------
  // Connection + printing
  // -------------------------------------------------------------------------------------------

  /** MUST be called synchronously from a click handler (requestPort needs the user gesture). */
  connect(path: ConnectPath): void {
    this.connection.connect(path).catch((e: unknown) => {
      if (!isUserCancel(e)) console.warn('connect failed', e)
    })
  }

  reconnect(): void {
    this.connection.reconnect().catch((e: unknown) => console.warn('reconnect failed', e))
  }

  /** Stop a connect attempt in flight (dialog "Cancel"). */
  cancelConnect(): void {
    this.connection.cancelConnect().catch((e: unknown) => console.warn('cancel connect failed', e))
  }

  /** Unsupported browser: design anyway (remembered). */
  continueDesigning(): void {
    this.designAnyway = true
    this.prefs = savePrefs({ designAnyway: true })
  }

  setSingleKeyShortcuts(on: boolean): void {
    this.prefs = savePrefs({ singleKeyShortcuts: on })
  }

  disconnect(forget = false): void {
    this.connection.disconnect({ forget }).catch((e: unknown) => console.warn('disconnect failed', e))
  }

  /** Runs a Problem action. Connect actions call requestPort synchronously (user gesture). */
  handleProblemAction(action: ProblemAction): void {
    switch (action) {
      case 'retry':
        if (this.conn.transport) this.reconnect()
        else this.connect(this.conn.path ?? this.support.paths[0] ?? 'virtual')
        break
      case 'reconnect':
        this.reconnect()
        break
      case 'choose-port':
        this.connect('serial-port')
        break
      case 'connect-bluetooth':
        this.connect('bluetooth')
        break
      case 'connect-usb':
        this.connect('usb')
        break
      case 'switch-tape':
        this.useLoadedTape()
        this.connection.dismissProblem()
        break
      case 'open-diagnostics':
        this.connectOpen = false
        this.setView('diagnostics')
        break
      case 'dismiss':
        this.connection.dismissProblem()
        break
    }
  }

  /** Resolves once no render is pending (bounded): print never encodes a stale preview. */
  async #renderSettled(timeoutMs = 10_000): Promise<void> {
    const end = performance.now() + timeoutMs
    while (this.rendering && performance.now() < end) await new Promise((r) => setTimeout(r, 16))
  }

  async print(): Promise<void> {
    if (this.printBlocked || this.printing) return
    this.printing = true
    let job
    let doc: LabelDoc
    try {
      // Print may be pressed right after an edit: wait for the preview of *this* doc and target,
      // so the old bitmap is never sent with the new settings.
      await this.#renderSettled()
      const result = this.render
      const target = this.target
      doc = this.doc
      if (this.printBlocked || !result || !target.ok || this.#renderedDoc !== doc || this.#renderedKey !== `${target.target.model}|${target.target.media.id}`) {
        if (!this.printBlocked) this.toast('info', 'Can’t print yet', 'The preview is still updating. Try again in a moment.')
        this.printing = false
        return
      }
      job = buildPrintJob(doc, result, target.target)
    } catch (e) {
      this.toast('error', 'The label could not be prepared for printing', errorMessage(e))
      this.printing = false
      return
    }
    const copies = job.pageCount
    try {
      await this.connection.print(job)
      const text = copies === 1 ? 'Label printed' : `${copies} labels printed`
      // The toast region announces it (one announcer, not two).
      this.toast('ok', text, doc.print.autoCut ? undefined : 'Cut the label off at the printer.')
    } catch (e) {
      if (isUserCancel(e) || (isPtouchError(e) && e.code === 'CANCELLED')) {
        this.toast('info', 'Printing cancelled')
      } else {
        // The connection banner shows the full Problem (with its actions); the toast is a
        // pointer next to the print bar so the failure is never missed.
        const p: Problem = this.conn.problem ?? describeProblem(e, { support: this.support, ...(this.conn.transport ? { transport: this.conn.transport } : {}), stage: 'print' })
        this.toast('error', 'Printing stopped', this.conn.problem ? p.title : `${p.title}. ${p.detail}`)
      }
    } finally {
      job.free()
      this.printing = false
    }
  }

  cancelPrint(): void {
    this.connection.cancel().catch((e: unknown) => console.warn('cancel failed', e))
  }

  // -------------------------------------------------------------------------------------------
  // Library (W5 persistence)
  // -------------------------------------------------------------------------------------------

  async openFromLibrary(id: string): Promise<void> {
    try {
      await this.autosave.flush()
      const found = await this.store.load(id)
      if (!found) {
        this.toast('error', 'That label no longer exists')
        return
      }
      this.openDoc(found.doc, { readOnly: found.readOnly, save: false })
      this.libraryOpen = false
    } catch (e) {
      this.toast('error', 'Could not open the label', errorMessage(e))
    }
  }

  async importFile(file: File): Promise<void> {
    try {
      await this.autosave.flush().catch(() => {}) // the open label's last edit (≤ 500 ms old)
      const { doc, notices } = await importLabelFile(file, this.store)
      this.openDoc(doc)
      this.toast('ok', `Imported “${doc.name}”`, notices.join(' ') || undefined)
    } catch (e) {
      this.toast('error', 'Could not import the file', errorMessage(e))
    }
  }

  async exportFile(): Promise<void> {
    try {
      const { saved, notices } = await exportLabelFile(this.doc, this.store)
      if (saved && notices.length) this.toast('info', 'Label exported', notices.join(' '))
    } catch (e) {
      if (isUserCancel(e)) return
      this.toast('error', 'Could not export the label', errorMessage(e))
    }
  }

  async copyShareLink(): Promise<void> {
    try {
      const { url, notices } = await createShareLink(this.doc, location.origin + import.meta.env.BASE_URL, { getBlob: (ref) => this.store.getBlob(ref) })
      await navigator.clipboard.writeText(url)
      this.toast('ok', 'Share link copied', notices.join(' ') || 'Anyone with the link can open a copy of this label.')
    } catch (e) {
      this.toast('error', 'Could not create a share link', errorMessage(e))
    }
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------------------------

  /** Global keydown handler (App: <svelte:window onkeydown>). */
  handleKey(e: KeyboardEvent): void {
    if (this.view !== 'studio' || e.defaultPrevented || e.isComposing) return
    if (document.querySelector('dialog[open]')) return
    const action = matchShortcut(e, { editing: isEditableTarget(e.target), mac: this.isMac, singleKeys: this.prefs.singleKeyShortcuts && inShortcutScope(e.target) })
    if (!action) return
    // Delete/Backspace on a focused button (Insert tile, toolbar…) must not delete a block: only
    // with nothing focused (the block list handles its own Delete key).
    if (action === 'delete' && e.target !== document.body && e.target !== document.documentElement) return
    if (this.runShortcut(action)) e.preventDefault()
  }

  /** Returns true when handled. */
  runShortcut(action: ShortcutAction): boolean {
    const id = this.selectedId
    switch (action) {
      case 'undo':
        this.undo()
        return true
      case 'redo':
        this.redo()
        return true
      case 'print':
        if (this.printBlocked) this.toast('info', 'Can’t print yet', this.printBlocked)
        else void this.print()
        return true
      case 'duplicate':
        if (id) this.duplicate(id)
        return !!id
      case 'delete':
        if (id) this.removeItem(id)
        return !!id
      case 'move-up':
        if (id) this.move(id, -1)
        return !!id
      case 'move-down':
        if (id) this.move(id, 1)
        return !!id
      case 'select-prev':
        this.selectRelative(-1)
        return true
      case 'select-next':
        this.selectRelative(1)
        return true
      case 'zoom-in':
      case 'zoom-out': {
        const dpi = this.target.ok ? this.target.target.area.dpi : 180
        const current = this.scale / realScale(dpi)
        this.zoom = zoomStep(current, action === 'zoom-in' ? 1 : -1)
        return true
      }
      case 'zoom-fit':
        this.zoom = 'fit'
        return true
      case 'zoom-real':
        this.zoom = 1
        return true
      case 'help':
        this.shortcutsOpen = true
        return true
      case 'deselect':
        if (!id) return false
        this.selectedId = null
        return true
    }
  }

  /** Recompute the fit scale (called by the preview when its box resizes). */
  updateFit(boxW: number, boxH: number, lengthDots: number, heightDots: number, dpi: number): void {
    const s = fitScale(lengthDots, heightDots, boxW, boxH, dpi)
    if (Math.abs(s - this.fitScaleValue) > 1e-4) this.fitScaleValue = s
  }

  dispose(): void {
    clearTimeout(this.#fontRetryTimer)
    window.removeEventListener('online', this.#onOnline)
    this.#disposeEffects?.()
    this.autosave.dispose()
    clearTimeout(this.#renderTimer)
  }
}

const KEY = Symbol('studio')

export function provideStudio(studio: Studio): Studio {
  return setContext(KEY, studio)
}

export function getStudio(): Studio {
  return getContext<Studio>(KEY)
}
