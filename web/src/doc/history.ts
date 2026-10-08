// W3 — undo/redo as a snapshot ring buffer of immutable docs (ARCHITECTURE.md §6.3):
// 200 entries, consecutive edits with the same `coalesceKey` within 1 s merge (typing, sliders).
// Docs are immutable (doc/ops.ts never mutates), so snapshots are shared, not cloned.
import type { LabelDoc } from './schema'

export interface History {
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Record `doc` as the new present. */
  push(doc: LabelDoc, coalesceKey?: string): void
  undo(): LabelDoc | undefined
  redo(): LabelDoc | undefined
  /** Forget everything and start from `doc` (open / new label). */
  reset(doc: LabelDoc): void
}

/** Edits with the same coalesce key closer together than this merge into one undo step. */
export const COALESCE_MS = 1000

/**
 * `capacity` = most snapshots kept (undo steps + the present); the oldest are dropped.
 * `now` is injectable for tests.
 */
export function createHistory(initial: LabelDoc, capacity = 200, now: () => number = Date.now): History {
  const cap = Math.max(1, Math.floor(capacity))
  let past: LabelDoc[] = []
  let future: LabelDoc[] = []
  let present = initial
  let lastKey: string | undefined
  let lastAt = -Infinity

  return {
    get canUndo() {
      return past.length > 0
    },
    get canRedo() {
      return future.length > 0
    },
    push(doc, coalesceKey) {
      if (doc === present) return
      const t = now()
      const merge = coalesceKey !== undefined && coalesceKey === lastKey && t - lastAt < COALESCE_MS && past.length > 0 && future.length === 0
      if (!merge) {
        past.push(present)
        if (past.length > cap - 1) past.splice(0, past.length - (cap - 1))
      }
      present = doc
      future = []
      lastKey = coalesceKey
      lastAt = t
    },
    undo() {
      const prev = past.pop()
      if (!prev) return undefined
      future.push(present)
      present = prev
      lastKey = undefined
      return present
    },
    redo() {
      const next = future.pop()
      if (!next) return undefined
      past.push(present)
      present = next
      lastKey = undefined
      return present
    },
    reset(doc) {
      past = []
      future = []
      present = doc
      lastKey = undefined
      lastAt = -Infinity
    },
  }
}
