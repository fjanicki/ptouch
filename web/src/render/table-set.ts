// Lazy access to the table renderer (table.ts + table-layout.ts, docs/TABLE-PLAN.md T15): loaded
// the first time a label with a table renders, so it stays out of the initial JS; the service
// worker precaches its chunk, so tables still work offline.
import type * as Tables from './table'
import { lazyModule } from './lazy'

export type TableSet = typeof Tables

/** Loads the table renderer once per page (shared request, retried after a failure). */
export const [loadTables, loadedTables] = lazyModule<TableSet>(() => import('./table'))
