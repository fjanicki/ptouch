// W3 — pure, immutable document operations used by the editor (W4). Each returns a NEW doc
// with `updatedAt` bumped; never mutates the input (undo snapshots rely on that).
import { createItem, newId, type Item, type ItemKind, type LabelDoc } from './schema'

const touch = (doc: LabelDoc): LabelDoc => ({ ...doc, updatedAt: new Date().toISOString() })

/** Inserts a new item of `kind` after `afterId` (or at the end). Returns [doc, newItemId]. */
export function addItem(doc: LabelDoc, kind: ItemKind, afterId?: string): [LabelDoc, string] {
  const item = createItem(kind)
  const at = afterId ? doc.items.findIndex((i) => i.id === afterId) + 1 : doc.items.length
  const items = [...doc.items]
  items.splice(at <= 0 ? items.length : at, 0, item)
  return [touch({ ...doc, items }), item.id]
}

/** Shallow-merges `patch` into item `id` (kind cannot change). */
/** Patches item `id`. A new text size also drops `clipTall` (v1 clipping of an old label's
 * text): from then on the text follows the current sizing rules. */
export function updateItem<T extends Item>(doc: LabelDoc, id: string, patch: Partial<Omit<T, 'id' | 'kind'>>): LabelDoc {
  return touch({
    ...doc,
    items: doc.items.map((i) => {
      if (i.id !== id) return i
      const next = { ...i, ...patch } as Item
      if (next.kind === 'text' && next.clipTall && 'size' in patch) delete next.clipTall
      return next
    }),
  })
}

export function removeItem(doc: LabelDoc, id: string): LabelDoc {
  return touch({ ...doc, items: doc.items.filter((i) => i.id !== id) })
}

/** Moves item `id` to index `to` (clamped). */
export function moveItem(doc: LabelDoc, id: string, to: number): LabelDoc {
  const from = doc.items.findIndex((i) => i.id === id)
  if (from < 0) return doc
  const items = [...doc.items]
  const [it] = items.splice(from, 1)
  if (!it) return doc
  items.splice(Math.max(0, Math.min(items.length, to)), 0, it)
  return touch({ ...doc, items })
}

/**
 * Duplicates item `id` right after itself (deep copy, new id; a free-layout frame is offset by
 * 2 mm so the copy is visible). Returns [doc, newItemId]; an unknown id returns [doc, ''].
 */
export function duplicateItem(doc: LabelDoc, id: string): [LabelDoc, string] {
  const at = doc.items.findIndex((i) => i.id === id)
  const src = doc.items[at]
  if (!src) return [doc, '']
  const copy = structuredClone(src) as Item
  copy.id = newId()
  if (copy.frame) copy.frame = { ...copy.frame, xMm: copy.frame.xMm + 2, yMm: copy.frame.yMm + 2 }
  const items = [...doc.items]
  items.splice(at + 1, 0, copy)
  return [touch({ ...doc, items }), copy.id]
}

/** Shallow-merges label-level settings (tape, length, margins, layout, frame, print, name). */
export function updateDoc(doc: LabelDoc, patch: Partial<Omit<LabelDoc, 'schema' | 'id' | 'items' | 'createdAt'>>): LabelDoc {
  return touch({ ...doc, ...patch })
}
