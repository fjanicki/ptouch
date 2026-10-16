// Printer models (docs/MODELS-PLAN.md §3.5) — the virtual printer's scenario, shared by the
// studio's "No printer" (the "Design for" model) and the Diagnostics virtual probe (the active
// model), so the two never simulate different printers. Unit-tested in node
// (tests/unit/ui/connect-copy.test.ts).
import type { MockScenario } from '../../printer'
import { mediaForWidth, type ModelInfo } from '../../wasm'
import { tapeWidthsOf } from './models'

/** A virtual printer of `info` with its widest TZe tape loaded (24 mm on the PT-P710BT, as before
 * models; 36 mm on the PT-P910BT); {} (the mock's default PT-P710BT, 24 mm) when the table has no
 * such model or it takes no TZe tape. */
export function virtualScenarioFor(info: ModelInfo | null | undefined): Partial<MockScenario> {
  const widest = info ? tapeWidthsOf(info).at(-1) : undefined
  if (!info || widest === undefined) return {}
  try {
    return { model: info.name, mediaId: mediaForWidth(info.name, widest).id }
  } catch {
    return {}
  }
}
