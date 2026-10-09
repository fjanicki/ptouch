// P3 — Wi-Fi QR payloads (`WIFI:` format read by the iOS Camera app and Android): every
// security mode, hidden networks, escaping of `\ ; , : "`, required fields and soft warnings.
import { describe, expect, it } from 'vitest'
import { createWifi } from '../../../src/doc/schema'
import { escapeWifiField, wifiPayload, wifiWarnings } from '../../../src/render/wifi'

describe('wifiPayload', () => {
  it.each([
    [{ ssid: 'Home', password: 'secret123', security: 'wpa' }, 'WIFI:T:WPA;S:Home;P:secret123;;'],
    [{ ssid: 'Lab', password: 'abcde', security: 'wep' }, 'WIFI:T:WEP;S:Lab;P:abcde;;'],
    [{ ssid: 'Café guest', password: '', security: 'open' }, 'WIFI:T:nopass;S:Café guest;;'],
    // Open networks never carry a password, even a leftover one.
    [{ ssid: 'Open', password: 'leftover', security: 'open' }, 'WIFI:T:nopass;S:Open;;'],
    [{ ssid: 'Hidden', password: 'secret123', security: 'wpa', hidden: true }, 'WIFI:T:WPA;S:Hidden;P:secret123;H:true;;'],
    [{ ssid: 'Hidden open', password: '', security: 'open', hidden: true }, 'WIFI:T:nopass;S:Hidden open;H:true;;'],
  ] as const)('%o → %s', (wifi, expected) => {
    expect(wifiPayload(createWifi(wifi))).toBe(expected)
  })

  it('escapes backslash first, then ; , : "', () => {
    const B = String.fromCharCode(92) // one backslash
    expect(escapeWifiField('plain')).toBe('plain')
    expect(escapeWifiField(`a${B}b`)).toBe(`a${B}${B}b`)
    expect(escapeWifiField('a;b,c:d"e')).toBe(`a${B};b${B},c${B}:d${B}"e`)
    // A backslash before a special character is escaped itself, then the character.
    expect(escapeWifiField(`${B};`)).toBe(`${B}${B}${B};`)
    expect(wifiPayload(createWifi({ ssid: `My;Net,"1":${B}`, password: `p;a,s:s"${B}word` }))).toBe(`WIFI:T:WPA;S:My${B};Net${B},${B}"1${B}"${B}:${B}${B};P:p${B};a${B},s${B}:s${B}"${B}${B}word;;`)
    // Other characters (spaces, unicode, emoji, single quotes) pass through unchanged.
    expect(wifiPayload(createWifi({ ssid: "Bob's 📶 réseau", security: 'open' }))).toBe("WIFI:T:nopass;S:Bob's 📶 réseau;;")
  })

  it('needs a network name, and a password for WPA/WEP', () => {
    expect(() => wifiPayload(createWifi({ password: 'secret123' }))).toThrow(/network name/)
    expect(() => wifiPayload(createWifi({ ssid: 'Home' }))).toThrow(/password/)
    expect(() => wifiPayload(createWifi({ ssid: 'Home', security: 'wep' }))).toThrow(/password/)
    expect(wifiPayload(createWifi({ ssid: 'Home', security: 'open' }))).toBe('WIFI:T:nopass;S:Home;;')
  })
})

describe('wifiWarnings', () => {
  it('WPA: 8–63 characters or 64 hex digits', () => {
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'short' }))).toHaveLength(1)
    expect(wifiWarnings(createWifi({ ssid: 'x', password: '12345678' }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'a'.repeat(63) }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'ab'.repeat(32) }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'z'.repeat(64) }))[0]).toMatch(/8 to 63/)
  })

  it('WEP: 5/13 characters or 10/26 hex digits; open and empty never warn', () => {
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'abcde', security: 'wep' }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x', password: '0123456789', security: 'wep' }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'abcdef', security: 'wep' }))).toHaveLength(1)
    expect(wifiWarnings(createWifi({ ssid: 'x', password: 'x', security: 'open' }))).toEqual([])
    expect(wifiWarnings(createWifi({ ssid: 'x' }))).toEqual([])
  })
})
