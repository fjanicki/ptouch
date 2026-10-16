// Lead-owned, frozen (docs/MODELS-PLAN.md §2.4): printer models as the studio sees them. Pure
// helpers over the core's model table (`listModels()`, crates/ptouch-wasm): which TZe widths a
// model takes, whether a browser can reach it, whether it was tested on real hardware, and what
// to say when a label's tape width is not one the active model takes. Unit-tested in node
// (tests/unit/ui/models.test.ts). No Svelte, no wasm calls: callers pass the table in.
import { DEFAULT_DESIGN_MODEL } from '../../doc/persist-prefs'
import { TAPE_WIDTHS_MM, type TapeWidthMm } from '../../doc/schema'
import type { ModelInfo } from '../../wasm'
import { formatMm, nearestTapeWidth } from './view-model'

/** Model assumed for offline design (the only hardware-verified model). */
export const DEFAULT_MODEL = DEFAULT_DESIGN_MODEL

/** Models checked on real hardware (docs/HARDWARE-TESTS.md). Any other model gets the
 * "untested model, please report" notice when a real one is connected. */
export const VERIFIED_MODELS: readonly string[] = ['PT-P710BT']

/** The default model's widths: the tape picker before the wasm core (and so the table) loads. */
export const FALLBACK_TAPE_WIDTHS: readonly TapeWidthMm[] = [3.5, 6, 9, 12, 18, 24]

/**
 * How a browser reaches a model: 'browser' = USB (WebUSB, or its serial port) or Bluetooth
 * Classic (Web Serial); 'ble-only' (PT-N25BT) and 'network-only' cannot be reached from a
 * browser at all (design and export only); 'none' = the table lists no link.
 */
export type ModelReach = 'browser' | 'ble-only' | 'network-only' | 'none'

/** A model by marketing name or alias (case-insensitive), as the core resolves names. */
export function findModel(models: readonly ModelInfo[], name: string | null | undefined): ModelInfo | undefined {
  if (!name) return undefined
  const n = name.toLowerCase()
  return models.find((m) => m.name.toLowerCase() === n || m.aliases.some((a) => a.toLowerCase() === n))
}

/**
 * The tape widths the editor offers for `info`: continuous TZe media only, ascending. Heat-shrink
 * tube (hs2/hs3: 5.8, 11.7… mm), self-laminating (sl) and fixed-length FLe labels are left out:
 * their geometry differs and the label document has no die-cut length (docs/MODELS-PLAN.md §3.3).
 */
export function tapeWidthsOf(info: ModelInfo): TapeWidthMm[] {
  const widths = new Set<TapeWidthMm>()
  for (const m of info.media) {
    if (m.kind !== 'tze' || m.lengthMm !== undefined) continue
    const w = TAPE_WIDTHS_MM.find((t) => Math.abs(t - m.widthMm) < 0.01)
    if (w !== undefined) widths.add(w)
  }
  return [...widths].sort((a, b) => a - b)
}

export function modelReach(info: Pick<ModelInfo, 'usbPid' | 'bluetooth' | 'ble' | 'network'>): ModelReach {
  if (info.usbPid !== undefined || info.bluetooth) return 'browser'
  if (info.ble) return 'ble-only'
  if (info.network) return 'network-only'
  return 'none'
}

/** One line for the model picker when a browser cannot connect to the model, else null. */
export function reachNote(info: Pick<ModelInfo, 'usbPid' | 'bluetooth' | 'ble' | 'network'>): string | null {
  switch (modelReach(info)) {
    case 'browser':
      return null
    case 'ble-only':
      return 'Bluetooth LE only: a browser can’t connect to it. Design and export labels here.'
    case 'network-only':
      return 'Network only: a browser can’t connect to it. Design and export labels here.'
    case 'none':
      return 'A browser can’t connect to it. Design and export labels here.'
  }
}

/**
 * The model picker's option groups (docs/MODELS-PLAN.md §3.6): models a browser can reach first,
 * then the design-only ones; empty groups are left out. `canConnect` false (every iOS browser,
 * Safari, Firefox without Web Serial): the first group says where those models do connect instead
 * of claiming "this browser".
 */
export function modelPickerGroups<M extends Pick<ModelInfo, 'usbPid' | 'bluetooth' | 'ble' | 'network'>>(models: readonly M[], canConnect: boolean): { label: string; models: M[] }[] {
  const groups = [
    { label: canConnect ? 'Connects from this browser' : 'Connect from Chrome or Edge on a computer', models: models.filter((m) => modelReach(m) === 'browser') },
    { label: 'Design only (a browser can’t connect)', models: models.filter((m) => modelReach(m) !== 'browser') },
  ]
  return groups.filter((g) => g.models.length > 0)
}

export function isVerifiedModel(name: string): boolean {
  return VERIFIED_MODELS.includes(name)
}

/** The doc's tape width is one the active model takes. */
export interface WidthSupported {
  ok: true
}

/** The doc's tape width is NOT one the active model takes: notice, "Fit to" action, print blocked. */
export interface WidthUnsupported {
  ok: false
  /** Active model. */
  model: string
  widthMm: TapeWidthMm
  /** Widths the active model takes (ascending, never empty). */
  widths: readonly TapeWidthMm[]
  /** Widest of `widths`. */
  maxMm: TapeWidthMm
  /** What "Fit to …" retapes to: the nearest of `widths` (the narrower one on a tie). */
  nearest: TapeWidthMm
  /**
   * Model the preview renders with meanwhile (so the design stays visible): the doc's
   * `tape.model` when it takes the width, else the first table model that does; null when
   * none does (the preview then shows `message`).
   */
  standIn: string | null
  /** "This label is 36 mm; PT-P710BT takes up to 24 mm." */
  message: string
}

export type WidthSupport = WidthSupported | WidthUnsupported

/** "This label is 36 mm; PT-P710BT takes up to 24 mm." / "…; PT-X doesn’t take 9 mm tape." */
export function unsupportedWidthText(model: string, widthMm: number, widths: readonly number[]): string {
  const max = Math.max(...widths)
  return widthMm > max ? `This label is ${formatMm(widthMm)}; ${model} takes up to ${formatMm(max)}.` : `This label is ${formatMm(widthMm)}; ${model} doesn’t take ${formatMm(widthMm)} tape.`
}

/** The first of `preferred`, then the table, that takes `widthMm` (TZe). */
export function standInModel(models: readonly ModelInfo[], widthMm: TapeWidthMm, preferred?: string | null): string | null {
  const pref = findModel(models, preferred)
  if (pref && tapeWidthsOf(pref).includes(widthMm)) return pref.name
  return models.find((m) => tapeWidthsOf(m).includes(widthMm))?.name ?? null
}

/**
 * Whether `widthMm` is one of `widths` (the active model's). An empty `widths` (table not loaded,
 * unknown model) counts as supported: nothing is blocked on missing information.
 */
export function widthSupport(model: string, widthMm: TapeWidthMm, widths: readonly TapeWidthMm[], standIn: string | null): WidthSupport {
  if (widths.length === 0 || widths.includes(widthMm)) return { ok: true }
  const maxMm = widths[widths.length - 1]!
  return { ok: false, model, widthMm, widths, maxMm, nearest: nearestTapeWidth(widthMm, widths), standIn, message: unsupportedWidthText(model, widthMm, widths) }
}
