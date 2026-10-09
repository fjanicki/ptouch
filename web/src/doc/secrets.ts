// Lead-owned (docs/STUDIO-V1-PLAN.md) — secrets inside a label: Wi-Fi passwords. They stay in
// this browser (IndexedDB library, print history). Share links and exported label files leave
// them out unless the user explicitly ticks "Include Wi-Fi password" (persist-share.ts,
// persist-files.ts). Diagnostics reports never contain document content at all. Pure.
//
// A password may be a placeholder (`{{pw}}`, doc/variables.ts passwordVariable): the real
// passwords then live in that batch column, so its cells are blanked as well.
import type { LabelDoc } from './schema'
import { passwordVariable } from './variables'

/** `true` when any code item (Wi-Fi or one switched back to text) holds a Wi-Fi password. */
export function docHasSecrets(doc: LabelDoc): boolean {
  return doc.items.some((i) => i.kind === 'code' && !!i.wifi?.password)
}

export interface StrippedSecrets {
  doc: LabelDoc
  /** Passwords blanked: password fields plus non-empty cells of password columns. */
  removed: number
  /** Batch columns whose cells were blanked (named by a `{{name}}` password). */
  columns: string[]
}

/** A copy of `doc` with every Wi-Fi password blanked, including the batch columns a password
 * placeholder names; `doc` itself when there is nothing to remove. */
export function stripSecrets(doc: LabelDoc): StrippedSecrets {
  let removed = 0
  const columns: string[] = []
  const items = doc.items.map((i) => {
    if (i.kind !== 'code' || !i.wifi?.password) return i
    removed++
    const name = passwordVariable(i.wifi.password)
    if (name !== undefined && doc.batch?.columns.includes(name) && !columns.includes(name)) columns.push(name)
    return { ...i, wifi: { ...i.wifi, password: '' } }
  })
  if (!removed) return { doc, removed, columns }
  let batch = doc.batch
  if (batch && columns.length) {
    const blank = new Set(columns.map((c) => batch?.columns.indexOf(c) ?? -1))
    const rows = batch.rows.map((row) =>
      row.map((cell, j) => {
        if (!blank.has(j) || cell === '') return cell
        removed++
        return ''
      }),
    )
    batch = { ...batch, rows }
  }
  return { doc: { ...doc, items, ...(batch ? { batch } : {}) }, removed, columns }
}
