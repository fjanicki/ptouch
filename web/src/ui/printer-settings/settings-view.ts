// P-web (docs/SETTINGS-PLAN.md §4) — pure helpers of the "Printer settings" panel: row labels,
// choice matching, the confirm sentence and the notes. No Svelte, no wasm calls: callers pass
// `settingsFor(model)` / the read reports in. Unit-tested in node
// (tests/unit/ui/printer-settings.test.ts). Display text of values comes from the core
// (`SettingInfo.choiceLabels`, `SettingReport.text`), never from rules re-implemented here.
import type { TransportKind } from '../../printer'
import type { SettingId, SettingInfo, SettingReport, SettingValue } from '../../wasm'

/** Our row labels (Brother's own name for the setting is shown underneath). "External power"
 * covers Brother's USB / AC adapter ("adp" on the PT-P710BT), AC/DC and USB Connection. */
export const ROW_LABELS: Record<SettingId, string> = {
  'auto-power-on': 'Auto power on',
  'auto-power-off': 'Auto power off: on external power',
  'auto-power-off-battery': 'Auto power off: on battery',
}

/** Short names for sentences ("Change auto power off (external power) from …"). */
export const SHORT_NAMES: Record<SettingId, string> = {
  'auto-power-on': 'auto power on',
  'auto-power-off': 'auto power off (external power)',
  'auto-power-off-battery': 'auto power off (battery)',
}

export const ROW_HINTS: Record<SettingId, string> = {
  'auto-power-on': 'Turns the printer on when power is connected.',
  'auto-power-off': 'Turns the printer off after this long without use while it runs on external power.',
  'auto-power-off-battery': 'Turns the printer off after this long without use while it runs on its battery.',
}

/** The row label. */
export function rowLabel(info: SettingInfo): string {
  return ROW_LABELS[info.id]
}

/** The row hint. */
export function rowHint(info: SettingInfo): string {
  return ROW_HINTS[info.id]
}

/** Short name for sentences. */
export function shortName(info: SettingInfo): string {
  return SHORT_NAMES[info.id]
}

/** "Saved and verified" sentence after a read-back that matches. */
export function savedText(info: SettingInfo, label: string): string {
  return `Saved and verified: ${shortName(info)} is ${label}.`
}

/** Models whose settings support (reads and writes) was checked on a real printer
 * (docs/HARDWARE-TESTS.md §9). Empty until a write hardware run. */
export const SETTINGS_VERIFIED_MODELS: readonly string[] = []

/** Models whose settings reads (not writes) were checked on a real printer
 * (docs/HARDWARE-TESTS.md §9 HW-S1/HW-S2, PT-P710BT over USB, 2026-10-16). */
export const SETTINGS_READ_VERIFIED_MODELS: readonly string[] = ['PT-P710BT']

export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'enabled' ? a.enabled === (b as { enabled: boolean }).enabled : a.minutes === (b as { minutes: number }).minutes
}

/** Index of `value` in the model's choices, or -1 (unlisted byte, not read yet). */
export function choiceIndex(info: SettingInfo, value: SettingValue | undefined): number {
  return value ? info.choices.findIndex((c) => sameValue(c, value)) : -1
}

/** "never" → "Never", "10 min" stays. */
export function displayText(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

/** What the panel shows for a reading: the core's text, "Unknown (0x07)" for an unlisted byte. */
export function readingText(report: SettingReport | undefined): string {
  if (!report) return ''
  return displayText(report.text)
}

/** Confirm sentence: "Change auto power off (external power) from 30 min to 10 min?" */
export function confirmText(info: SettingInfo, from: SettingReport | undefined, toLabel: string): string {
  const was = from ? ` from ${from.text}` : ''
  return `Change ${shortName(info)}${was} to ${toLabel}?`
}

/** Brother's name for the setting, as the subtitle under a row. On the PT-P710BT / P715eBT the
 * timers are named as in the printer's own information report: Brother's Printer Setting Tool
 * labels them the other way round on these models (PROTOCOL.md §8 #34), so the note must not
 * point at that tool. */
export function brotherNote(info: SettingInfo): string {
  if (info.brotherLabelSource === 'info-report') return `Shown as “${info.brotherLabel}” in the printer’s information report.`
  return `Same as “${info.brotherLabel}” in Brother’s Printer Setting Tool.`
}

/** Notes under the panel: untested model, untested Bluetooth path, simulated values. */
export function settingsNotes(model: string, kind: TransportKind | undefined): string[] {
  const notes: string[] = []
  if (kind === 'virtual') notes.push('Virtual printer: the values are simulated and nothing reaches a real printer.')
  else if (SETTINGS_READ_VERIFIED_MODELS.includes(model) && !SETTINGS_VERIFIED_MODELS.includes(model)) notes.push(`Reading is checked on the ${model}; changing a setting has not been tested on a real printer yet. Each change is read back to check that the printer stored it.`)
  else if (!SETTINGS_VERIFIED_MODELS.includes(model)) notes.push(`Untested on the ${model}: printer settings have not been checked on a real printer yet. Each change is read back to check that the printer stored it.`)
  if (kind === 'serial-rfcomm' || kind === 'serial-os-port') notes.push('Bluetooth: untested. If the printer doesn’t answer, try a USB cable.')
  return notes
}
