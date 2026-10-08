// W4 — keyboard shortcut matching (mac/other modifiers, editing fields never hijacked).
import { describe, expect, it } from 'vitest'
import { inShortcutScope, matchShortcut, shortcutList, type KeyLike } from '../../../src/ui/state/shortcuts'

const key = (k: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
const mac = { editing: false, mac: true }
const win = { editing: false, mac: false }

describe('matchShortcut', () => {
  it('uses ⌘ on mac and Ctrl elsewhere', () => {
    expect(matchShortcut(key('z', { metaKey: true }), mac)).toBe('undo')
    expect(matchShortcut(key('z', { ctrlKey: true }), mac)).toBeNull()
    expect(matchShortcut(key('z', { ctrlKey: true }), win)).toBe('undo')
    expect(matchShortcut(key('Z', { metaKey: true, shiftKey: true }), mac)).toBe('redo')
    expect(matchShortcut(key('y', { ctrlKey: true }), win)).toBe('redo')
    expect(matchShortcut(key('p', { metaKey: true }), mac)).toBe('print')
    expect(matchShortcut(key('d', { ctrlKey: true }), win)).toBe('duplicate')
  })
  it('never hijacks typing in fields, except undo/redo/print', () => {
    const editing = { editing: true, mac: true }
    expect(matchShortcut(key('Backspace'), editing)).toBeNull()
    expect(matchShortcut(key('0'), editing)).toBeNull()
    expect(matchShortcut(key('ArrowUp', { altKey: true }), editing)).toBeNull()
    expect(matchShortcut(key('d', { metaKey: true }), editing)).toBeNull()
    expect(matchShortcut(key('z', { metaKey: true }), editing)).toBe('undo')
    expect(matchShortcut(key('p', { metaKey: true }), editing)).toBe('print')
  })
  it('maps single keys outside fields', () => {
    expect(matchShortcut(key('Delete'), mac)).toBe('delete')
    expect(matchShortcut(key('ArrowUp', { altKey: true }), mac)).toBe('move-up')
    expect(matchShortcut(key('ArrowDown', { altKey: true }), win)).toBe('move-down')
    expect(matchShortcut(key('+'), mac)).toBe('zoom-in')
    expect(matchShortcut(key('-'), mac)).toBe('zoom-out')
    expect(matchShortcut(key('0'), mac)).toBe('zoom-fit')
    expect(matchShortcut(key('1'), mac)).toBe('zoom-real')
    expect(matchShortcut(key('?', { shiftKey: true }), mac)).toBe('help')
    expect(matchShortcut(key(']'), mac)).toBe('select-next')
    expect(matchShortcut(key('Escape'), mac)).toBe('deselect')
    expect(matchShortcut(key('a'), mac)).toBeNull()
  })
  it('lists every action with the platform modifier', () => {
    const rows = shortcutList('⌘')
    expect(rows.find((r) => r.label === 'Undo')?.keys).toEqual(['⌘', 'Z'])
    expect(rows.length).toBeGreaterThan(10)
  })
})

describe('single-key shortcuts (WCAG 2.1.4)', () => {
  it('do not act outside a shortcut scope or when turned off', () => {
    const off = { editing: false, mac: true, singleKeys: false }
    expect(matchShortcut(key('1'), off)).toBeNull()
    expect(matchShortcut(key('+'), off)).toBeNull()
    expect(matchShortcut(key(']'), off)).toBeNull()
    expect(matchShortcut(key('?', { shiftKey: true }), off)).toBeNull()
    // Modifier and non-character keys still work.
    expect(matchShortcut(key('z', { metaKey: true }), off)).toBe('undo')
    expect(matchShortcut(key('ArrowUp', { altKey: true }), off)).toBe('move-up')
    expect(matchShortcut(key('Escape'), off)).toBe('deselect')
  })
  it('scope: body and marked regions only', () => {
    const fake = (tag: string, scoped: boolean) => ({ tagName: tag, closest: () => (scoped ? {} : null) }) as unknown as EventTarget
    expect(inShortcutScope(null)).toBe(true)
    expect(inShortcutScope(fake('BODY', false))).toBe(true)
    expect(inShortcutScope(fake('INPUT', false))).toBe(false) // a switch / slider
    expect(inShortcutScope(fake('BUTTON', false))).toBe(false)
    expect(inShortcutScope(fake('DIV', true))).toBe(true) // preview stage
  })
})
