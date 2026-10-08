// W4 — keyboard shortcuts (pure matcher; the Studio performs the action). Listed in the
// shortcuts dialog (`?`). Inside text fields only the "mod" shortcuts apply, so typing is never
// hijacked. Single-character keys (1, 0, +, -, [, ], ?) only act when focus is on the page
// itself, the preview or the block list (WCAG 2.1.4: never on a switch, slider or button, where
// screen-reader quick keys live), and the shortcuts dialog can turn them off.

export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'print'
  | 'duplicate'
  | 'delete'
  | 'move-up'
  | 'move-down'
  | 'select-prev'
  | 'select-next'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'zoom-real'
  | 'help'
  | 'deselect'

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface ShortcutContext {
  /** Focus is in an input, textarea, select or contenteditable. */
  editing: boolean
  /** macOS/iOS: ⌘ is the modifier; elsewhere Ctrl. */
  mac: boolean
  /** Single-character keys may act (focus in a shortcut scope and the preference is on).
   * Default true. */
  singleKeys?: boolean
}

export function matchShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutAction | null {
  const mod = ctx.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (key === 'y' && !ctx.mac && !e.shiftKey) return 'redo'
    if (key === 'p' && !e.shiftKey) return 'print'
    if (key === 'd' && !e.shiftKey && !ctx.editing) return 'duplicate'
    return null
  }
  if (ctx.editing || e.metaKey || e.ctrlKey) return null
  if (e.altKey && !e.shiftKey) {
    if (key === 'ArrowUp' || key === 'ArrowLeft') return 'move-up'
    if (key === 'ArrowDown' || key === 'ArrowRight') return 'move-down'
    return null
  }
  if (e.altKey) return null
  switch (key) {
    case 'Delete':
    case 'Backspace':
      return 'delete'
    case 'Escape':
      return 'deselect'
  }
  if (ctx.singleKeys === false) return null
  switch (key) {
    case '[':
      return 'select-prev'
    case ']':
      return 'select-next'
    case '+':
    case '=':
      return 'zoom-in'
    case '-':
    case '_':
      return 'zoom-out'
    case '0':
      return 'zoom-fit'
    case '1':
      return 'zoom-real'
    case '?':
      return 'help'
    default:
      return null
  }
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as Element).closest !== 'function') return false
  const el = t as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/**
 * `true` when single-key shortcuts may act on this focus target: nothing focused (body), or
 * inside an element marked `data-shortcut-scope` (preview stage, block list).
 */
export function inShortcutScope(t: EventTarget | null): boolean {
  if (!t || typeof (t as Element).closest !== 'function') return true
  const el = t as Element
  if (el.tagName === 'BODY' || el.tagName === 'HTML') return true
  return el.closest('[data-shortcut-scope]') !== null
}

/** Rows for the shortcuts dialog. `mod` is "⌘" or "Ctrl". */
export function shortcutList(mod: string): { keys: string[]; label: string }[] {
  return [
    { keys: [mod, 'Z'], label: 'Undo' },
    { keys: [mod, '⇧', 'Z'], label: 'Redo' },
    { keys: [mod, 'P'], label: 'Print' },
    { keys: [mod, 'D'], label: 'Duplicate block' },
    { keys: ['Delete'], label: 'Delete block' },
    { keys: ['Alt', '↑'], label: 'Move block earlier' },
    { keys: ['Alt', '↓'], label: 'Move block later' },
    { keys: ['['], label: 'Select previous block' },
    { keys: [']'], label: 'Select next block' },
    { keys: ['+'], label: 'Zoom in' },
    { keys: ['−'], label: 'Zoom out' },
    { keys: ['0'], label: 'Zoom to fit' },
    { keys: ['1'], label: 'Real size' },
    { keys: ['Esc'], label: 'Deselect' },
    { keys: ['?'], label: 'Show shortcuts' },
  ]
}
