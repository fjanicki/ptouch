// P1 (docs/STUDIO-V1-PLAN.md) — whether the batch panel is expanded, shared by BatchPanel and
// the "Edit data…" button of VariableHint (which opens it and moves focus there).
import { tick } from 'svelte'

export const BATCH_PANEL_ID = 'batch-panel'

export const batchPanel = $state({ open: false })

/** Expands the batch panel, scrolls it into view and focuses its heading button. */
export async function revealBatchPanel(): Promise<void> {
  batchPanel.open = true
  await tick()
  const el = document.getElementById(BATCH_PANEL_ID)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  el.querySelector<HTMLElement>('[data-batch-toggle]')?.focus({ preventScroll: true })
}
