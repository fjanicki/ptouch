// P-web (docs/SETTINGS-PLAN.md §4) — the "Printer settings" panel's pure helpers, the busy
// 'settings' connection state in the view model (chip, print gate, still connected), and the
// diagnostics report's settings section (values only, masked).
import { beforeAll, describe, expect, it } from 'vitest'
import { PacketLog, type ConnectionSnapshot } from '../../../src/printer'
import { buildReport } from '../../../src/ui/diagnostics/report'
import { detectSupport } from '../../../src/printer/support'
import { settingsFor, type SettingReport } from '../../../src/wasm'
import { ROW_LABELS, brotherNote, choiceIndex, confirmText, displayText, readingText, rowHint, rowLabel, sameValue, savedText, settingsNotes, shortName } from '../../../src/ui/printer-settings/settings-view'
import { chipView, isConnected, printBlockReason, printerModel, type PrintGate } from '../../../src/ui/state/view-model'
import { loadWasmForTests } from '../../helpers/wasm'

beforeAll(() => loadWasmForTests())

const report = (patch: Partial<SettingReport> & Pick<SettingReport, 'id' | 'text'>): SettingReport => ({ raw: [], ...patch })

describe('settingsFor (wasm) as the panel uses it', () => {
  it('PT-P710BT: three rows in display order, P710BT labels', () => {
    const infos = settingsFor('PT-P710BT')
    expect(infos.map((i) => i.id)).toEqual(['auto-power-on', 'auto-power-off', 'auto-power-off-battery'])
    expect(infos.map((i) => i.kind)).toEqual(['toggle', 'duration', 'duration'])
    expect(infos[1]?.choiceLabels).toEqual(['never', '10 min', '20 min', '30 min', '40 min', '50 min', '60 min'])
    expect(infos.map((i) => i.brotherLabelSource)).toEqual(['setting-tool', 'info-report', 'info-report'])
    expect(brotherNote(infos[0]!)).toBe('Same as “Auto Power On” in Brother’s Printer Setting Tool.')
    expect(brotherNote(infos[1]!)).toBe('Shown as “AutoPowerOff(adp)” in the printer’s information report.')
    expect(brotherNote(infos[2]!)).toBe('Shown as “AutoPowerOff(Bat)” in the printer’s information report.')
  })
  it('PT-P900W lists hours; unsupported and unknown models have none (feature hidden)', () => {
    expect(settingsFor('PT-P900W')[1]?.choiceLabels.slice(-5)).toEqual(['1 h', '2 h', '4 h', '8 h', '12 h'])
    expect(settingsFor('PT-E560BT')).toEqual([])
    expect(settingsFor('PT-P700')).toEqual([])
    expect(settingsFor('no such printer')).toEqual([])
  })
})

describe('settings-view helpers', () => {
  const info = () => settingsFor('PT-P710BT')[1]!

  it('matches values by kind and amount', () => {
    expect(sameValue({ kind: 'minutes', minutes: 10 }, { kind: 'minutes', minutes: 10 })).toBe(true)
    expect(sameValue({ kind: 'minutes', minutes: 10 }, { kind: 'minutes', minutes: 20 })).toBe(false)
    expect(sameValue({ kind: 'enabled', enabled: true }, { kind: 'enabled', enabled: true })).toBe(true)
    expect(sameValue({ kind: 'enabled', enabled: false }, { kind: 'minutes', minutes: 0 })).toBe(false)
    expect(sameValue(undefined, { kind: 'minutes', minutes: 0 })).toBe(false)
  })

  it('finds the choice index; -1 for unlisted or unread', () => {
    expect(choiceIndex(info(), { kind: 'minutes', minutes: 30 })).toBe(3)
    expect(choiceIndex(info(), { kind: 'minutes', minutes: 0 })).toBe(0)
    expect(choiceIndex(info(), { kind: 'minutes', minutes: 120 })).toBe(-1)
    expect(choiceIndex(info(), undefined)).toBe(-1)
  })

  it('phrases values and the confirmation', () => {
    expect(displayText('never')).toBe('Never')
    expect(readingText(report({ id: 'auto-power-off', text: 'unknown (0x07)', unlistedByte: 7 }))).toBe('Unknown (0x07)')
    expect(readingText(undefined)).toBe('')
    expect(confirmText(info(), report({ id: 'auto-power-off', text: '30 min' }), '10 min')).toBe('Change auto power off (external power) from 30 min to 10 min?')
    expect(confirmText(settingsFor('PT-P900W')[1]!, report({ id: 'auto-power-off', text: '30 min' }), '2 h')).toBe('Change auto power off (external power) from 30 min to 2 h?')
    expect(confirmText(settingsFor('PT-P710BT')[0]!, undefined, 'on')).toBe('Change auto power on to on?')
    expect(ROW_LABELS['auto-power-off-battery']).toBe('Auto power off: on battery')
  })

  // Regression (PROTOCOL.md §8 #34): the PT-P710BT selector is settled on hardware (00 = USB /
  // AC adapter, 01 = battery), so its rows use the standard power-source names, and they never
  // point at Brother's Printer Setting Tool, whose labels are reversed on this model.
  it('PT-P710BT timers use the standard names and the information report’s names', () => {
    const [on, ac, bat] = settingsFor('PT-P710BT')
    expect(rowLabel(on!)).toBe('Auto power on')
    expect(rowLabel(ac!)).toBe('Auto power off: on external power')
    expect(rowLabel(bat!)).toBe('Auto power off: on battery')
    expect(rowHint(ac!)).toMatch(/external power/)
    expect(rowHint(bat!)).toMatch(/battery/)
    for (const i of [ac!, bat!]) {
      expect(rowHint(i)).not.toMatch(/unverified/)
      expect(brotherNote(i)).not.toMatch(/Setting Tool/)
    }
    expect(shortName(ac!)).toBe('auto power off (external power)')
    expect(savedText(bat!, 'never')).toBe('Saved and verified: auto power off (battery) is never.')
    expect(settingsNotes('PT-P710BT', 'usb').join(' ')).not.toMatch(/timer|swapped/)

    const p900 = settingsFor('PT-P900W')
    expect(rowLabel(p900[1]!)).toBe('Auto power off: on external power')
    expect(rowLabel(p900[2]!)).toBe('Auto power off: on battery')
    expect(brotherNote(p900[1]!)).toBe('Same as “Auto Power Off (AC/DC)” in Brother’s Printer Setting Tool.')
    const p910 = settingsFor('PT-P910BT')
    expect(rowLabel(p910[1]!)).toBe('Auto power off: on external power')
    expect(brotherNote(p910[1]!)).toBe('Same as “Auto Power Off (USB Connection)” in Brother’s Printer Setting Tool.')
  })

  it('notes: reads checked on the P710BT, untested model, Bluetooth untested, virtual simulated', () => {
    expect(settingsNotes('PT-P710BT', 'usb')).toEqual([
      'Reading is checked on the PT-P710BT; changing a setting has not been tested on a real printer yet. Each change is read back to check that the printer stored it.',
    ])
    expect(settingsNotes('PT-P910BT', 'usb')).toEqual([expect.stringMatching(/^Untested on the PT-P910BT: printer settings have not been checked/)])
    expect(settingsNotes('PT-P710BT', 'serial-rfcomm')).toEqual([expect.stringMatching(/^Reading is checked on the PT-P710BT/), expect.stringMatching(/^Bluetooth: untested/)])
    expect(settingsNotes('PT-P710BT', 'serial-os-port')[1]).toMatch(/^Bluetooth: untested/)
    expect(settingsNotes('PT-P710BT', 'virtual')).toEqual([expect.stringMatching(/^Virtual printer/)])
  })
})

describe("the 'settings' connection state", () => {
  const conn = { path: 'usb', state: 'settings', transport: { kind: 'usb', label: 'USB 04f9:20af', persistentGrant: true }, model: 'PT-P710BT', status: null, media: null, openProgress: null, progress: null, problem: null } satisfies ConnectionSnapshot

  it('is still connected and keeps the printer’s model', () => {
    expect(isConnected('settings')).toBe(true)
    expect(printerModel(conn)).toBe('PT-P710BT')
  })
  it('the chip shows a busy printer', () => {
    expect(chipView(conn)).toMatchObject({ tone: 'busy', busy: true, text: 'PT-P710BT · settings…' })
  })
  it('printing waits for it', () => {
    const gate: PrintGate = { wasm: 'ready', renderError: null, hasRender: true, blocking: null, isEmpty: false, conn, mismatch: null }
    expect(printBlockReason(gate)).toBe('Busy: printer settings.')
  })
})

describe('diagnostics report', () => {
  it('lists the last settings read (text only) and masks device names', () => {
    const support = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} } })
    const snap: ConnectionSnapshot = {
      path: 'bluetooth',
      state: 'ready',
      transport: { kind: 'serial-rfcomm', label: 'PT-P710BT1234', persistentGrant: true },
      model: 'PT-P710BT',
      status: null,
      media: null,
      openProgress: null,
      progress: null,
      problem: null,
      settings: [report({ id: 'auto-power-on', text: 'off', raw: [0x80, 0x20] }), report({ id: 'auto-power-off', text: '30 min' })],
    }
    const text = buildReport(support, snap, new PacketLog(), { now: new Date(0) })
    expect(text).toContain('## Printer settings (last read)')
    expect(text).toMatch(/auto-power-on:\s+off/)
    expect(text).toMatch(/auto-power-off:\s+30 min/)
    expect(text).toContain('PT-P710BTxxxx')
    expect(text).not.toContain('1234')
  })

  // Regression: the connection problem lines stay in the Connection section.
  it('keeps the connection problem out of the settings section', () => {
    const support = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} } })
    const snap: ConnectionSnapshot = {
      path: 'usb',
      state: 'lost',
      transport: { kind: 'usb', label: 'USB 04f9:20af', persistentGrant: true },
      model: 'PT-P710BT',
      status: null,
      media: null,
      openProgress: null,
      progress: null,
      problem: { id: 'link-lost', severity: 'error', title: 'Connection lost', technical: 'x', actions: [] } as unknown as NonNullable<ConnectionSnapshot['problem']>,
      settings: [report({ id: 'auto-power-off', text: '30 min' })],
    }
    const text = buildReport(support, snap, new PacketLog(), { now: new Date(0) })
    const conn = text.slice(text.indexOf('## Connection'), text.indexOf('## Printer settings (last read)'))
    expect(conn).toMatch(/problem:\s+link-lost \(error\): Connection lost/)
    expect(conn).toMatch(/technical:\s+x/)
    const settings = text.slice(text.indexOf('## Printer settings (last read)'))
    const section = settings.split('\n## ')[0]!
    expect(section).toMatch(/auto-power-off:\s+30 min/)
    expect(section).not.toMatch(/problem:|technical:/)
  })
})
