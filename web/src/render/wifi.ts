// P3 (docs/STUDIO-V1-PLAN.md) — Wi-Fi QR payloads: `WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<pw>;H:true;;`
// with backslash escaping of `\ ; , : "` in SSID and password (the de-facto ZXing format that
// the iOS Camera app and Android join from). Pure; used by render/codes.ts (`codePayload`) and the
// code editor (live preview of the payload).
import type { WifiSecurity, WifiSettings } from '../doc/schema'

const AUTH: Record<WifiSecurity, string> = { wpa: 'WPA', wep: 'WEP', open: 'nopass' }

/** Escapes a `WIFI:` field: backslash first, then `;` `,` `:` `"`. */
export function escapeWifiField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[;,:"]/g, (c) => `\\${c}`)
}

/**
 * The `WIFI:` string for `wifi`. Throws an Error with a user-facing message when it cannot be
 * built (empty SSID, missing password for WPA/WEP).
 */
export function wifiPayload(wifi: WifiSettings): string {
  if (!wifi.ssid) throw new Error('Enter the network name (SSID).')
  const open = wifi.security === 'open'
  if (!open && !wifi.password) throw new Error('Enter the Wi-Fi password, or choose “None” for an open network.')
  let s = `WIFI:T:${AUTH[wifi.security]};S:${escapeWifiField(wifi.ssid)};`
  if (!open) s += `P:${escapeWifiField(wifi.password)};`
  if (wifi.hidden) s += 'H:true;'
  return `${s};`
}

/**
 * Non-blocking problems a phone may have joining (the code is still printed): a WPA password
 * must be 8–63 characters or 64 hex digits, a WEP key 5/13 characters or 10/26 hex digits.
 */
export function wifiWarnings(wifi: WifiSettings): string[] {
  const pw = wifi.password
  if (!pw || wifi.security === 'open') return []
  const hex = /^[0-9a-fA-F]+$/.test(pw)
  if (wifi.security === 'wpa') {
    const len = [...pw].length
    if ((len >= 8 && len <= 63) || (len === 64 && hex)) return []
    return [`A WPA password has 8 to 63 characters (or 64 hex digits); this one has ${len}. Phones may not join.`]
  }
  if ([5, 13].includes(pw.length) || (hex && [10, 26].includes(pw.length))) return []
  return ['A WEP key has 5 or 13 characters (or 10 or 26 hex digits). Phones may not join.']
}
