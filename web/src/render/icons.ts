// W3 — bundled icon set for IconItem: a subset of Lucide 1.52.0 (https://lucide.dev, ISC; some
// shapes derive from Feather, MIT). Every element is converted to path data in a 24×24 box.
// The icons are stroke-only (Lucide draws them with stroke-width 2, round caps and joins);
// render/renderer.ts strokes them on the crisp plane with a width of at least 2 dots.
// Generated from https://github.com/lucide-icons/lucide/tree/1.52.0/icons; licence below.
//
// ISC License — Copyright (c) 2026 Lucide Icons and Contributors
// Permission to use, copy, modify, and/or distribute this software for any purpose with or
// without fee is hereby granted, provided that the above copyright notice and this permission
// notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
// SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
// AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
// NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
// PERFORMANCE OF THIS SOFTWARE.
//
// Feather-derived icons used here (arrow-*, calendar, check, clock, corner-down-right, info, key,
// lock, minus, monitor, move, music, plus, power, server, x): MIT License, Copyright (c)
// 2013-present Cole Bemis. Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"), to deal in the
// Software without restriction, including without limitation the rights to use, copy, modify,
// merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions: The
// above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
// KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
// OR OTHER DEALINGS IN THE SOFTWARE.

export type IconCategory = 'electrical' | 'tools' | 'arrows' | 'hazard' | 'home' | 'misc'

export interface IconDef {
  id: string
  label: string
  category: IconCategory
  /** SVG path data (one or more `d` strings) in a 24×24 box, stroked (never filled). */
  paths: string[]
  /** Searchable keywords. */
  keywords: string[]
  /** Upstream Lucide icon name. */
  lucide?: string
}

/** Category order and labels for the icon picker. */
export const ICON_CATEGORIES: readonly { id: IconCategory; label: string }[] = [
  { id: 'electrical', label: 'Electrical & IT' },
  { id: 'tools', label: 'Tools' },
  { id: 'arrows', label: 'Arrows' },
  { id: 'hazard', label: 'Safety' },
  { id: 'home', label: 'Home' },
  { id: 'misc', label: 'Other' },
]

/** Width of the icon's view box (and height); paths are in this coordinate space. */
export const ICON_VIEWBOX = 24
/** Lucide's stroke width in view-box units. */
export const ICON_STROKE = 2

export const ICONS: readonly IconDef[] = [
  { id: "bolt", label: "Lightning", category: "electrical", lucide: "zap", keywords: ["power","electric","lightning","bolt","voltage","high-voltage","zap"], paths: ["M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"] },
  { id: "plug", label: "Plug", category: "electrical", lucide: "plug", keywords: ["power","socket","mains","outlet","plug"], paths: ["M12 22v-5","M15 8V2","M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z","M9 8V2"] },
  { id: "plug-zap", label: "Live plug", category: "electrical", lucide: "plug-zap", keywords: ["power","charging","live","socket"], paths: ["M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z","m2 22 3-3","M7.5 13.5 10 11","M10.5 16.5 13 14","m18 3-4 4h6l-4 4"] },
  { id: "power", label: "Power", category: "electrical", lucide: "power", keywords: ["on","off","switch","button","standby"], paths: ["M12 2v10","M18.4 6.6a9 9 0 1 1-12.77.04"] },
  { id: "battery", label: "Battery", category: "electrical", lucide: "battery", keywords: ["cell","charge","accumulator"], paths: ["M 22 14 L 22 10","M4 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z"] },
  { id: "battery-charging", label: "Charging", category: "electrical", lucide: "battery-charging", keywords: ["battery","charger","charge"], paths: ["m11 7-3 5h4l-3 5","M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935","M22 14v-4","M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936"] },
  { id: "cable", label: "Cable", category: "electrical", lucide: "cable", keywords: ["wire","cord","connector","lead"], paths: ["M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z","M17 21v-2","M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10","M21 21v-2","M3 5V3","M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z","M7 5V3"] },
  { id: "lightbulb", label: "Light bulb", category: "electrical", lucide: "lightbulb", keywords: ["lamp","light","idea","bulb"], paths: ["M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5","M9 18h6","M10 22h4"] },
  { id: "fan", label: "Fan", category: "electrical", lucide: "fan", keywords: ["ventilation","cooling","air"], paths: ["M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z","M12 12v.01"] },
  { id: "gauge", label: "Gauge", category: "electrical", lucide: "gauge", keywords: ["meter","pressure","dial","speed"], paths: ["m12 14 4-4","M3.34 19a10 10 0 1 1 17.32 0"] },
  { id: "cpu", label: "Chip", category: "electrical", lucide: "cpu", keywords: ["processor","computer","cpu","chip"], paths: ["M12 20v2","M12 2v2","M17 20v2","M17 2v2","M2 12h2","M2 17h2","M2 7h2","M20 12h2","M20 17h2","M20 7h2","M7 20v2","M7 2v2","M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z","M9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z"] },
  { id: "circuit-board", label: "Circuit board", category: "electrical", lucide: "circuit-board", keywords: ["pcb","electronics","board"], paths: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z","M11 9h4a2 2 0 0 0 2-2V3","M7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0","M7 21v-4a2 2 0 0 1 2-2h4","M13 15a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"] },
  { id: "wifi", label: "Wi-Fi", category: "electrical", lucide: "wifi", keywords: ["wireless","network","wlan","internet"], paths: ["M12 20h.01","M2 8.82a15 15 0 0 1 20 0","M5 12.859a10 10 0 0 1 14 0","M8.5 16.429a5 5 0 0 1 7 0"] },
  { id: "router", label: "Router", category: "electrical", lucide: "router", keywords: ["modem","network","internet","gateway"], paths: ["M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z","M6.01 18H6","M10.01 18H10","M15 10v4","M17.84 7.17a4 4 0 0 0-5.66 0","M20.66 4.34a8 8 0 0 0-11.31 0"] },
  { id: "server", label: "Server", category: "electrical", lucide: "server", keywords: ["rack","nas","computer","storage"], paths: ["M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z","M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z","M6 6L6.01 6","M6 18L6.01 18"] },
  { id: "network", label: "Network", category: "electrical", lucide: "network", keywords: ["lan","switch","topology"], paths: ["M17 16h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1z","M3 16h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1z","M10 2h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1z","M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3","M12 12V8"] },
  { id: "ethernet-port", label: "Ethernet", category: "electrical", lucide: "ethernet-port", keywords: ["lan","rj45","port","network"], paths: ["M10 8v1","M14 8v1","M18 8v1","M19 17a2 2 0 00-1.765 1.059l-.47.882A2 2 0 0115 20H9a2 2 0 01-1.765-1.059l-.47-.882A2 2 0 005 17H4a2 2 0 01-2-2V6a2 2 0 012-2h16a2 2 0 012 2v9a2 2 0 01-2 2z","M6 8v1"] },
  { id: "usb", label: "USB", category: "electrical", lucide: "usb", keywords: ["usb","port","connector"], paths: ["M9 7a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M3 20a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M4.7 19.3 19 5","m21 3-3 1 2 2Z","M9.26 7.68 5 12l2 5","m10 14 5 2 3.5-3.5","m18 12 1-1 1 1-1 1Z"] },
  { id: "bluetooth", label: "Bluetooth", category: "electrical", lucide: "bluetooth", keywords: ["wireless","pairing"], paths: ["m7 7 10 10-5 5V2l5 5L7 17"] },
  { id: "monitor", label: "Monitor", category: "electrical", lucide: "monitor", keywords: ["screen","display","computer"], paths: ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z","M8 21L16 21","M12 17L12 21"] },
  { id: "printer", label: "Printer", category: "electrical", lucide: "printer", keywords: ["print","office"], paths: ["M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2","M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6","M7 14h10a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z"] },
  { id: "hard-drive", label: "Hard drive", category: "electrical", lucide: "hard-drive", keywords: ["disk","storage","hdd","ssd","backup"], paths: ["M10 16h.01","M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z","M21.946 12.013H2.054","M6 16h.01"] },
  { id: "wrench", label: "Wrench", category: "tools", lucide: "wrench", keywords: ["spanner","tool","repair"], paths: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"] },
  { id: "hammer", label: "Hammer", category: "tools", lucide: "hammer", keywords: ["tool","nail"], paths: ["m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9","m18 15 4-4","m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"] },
  { id: "drill", label: "Drill", category: "tools", lucide: "drill", keywords: ["power","tool","drilling"], paths: ["M10 18a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a3 3 0 0 1-3-3 1 1 0 0 1 1-1z","M13 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1l-.81 3.242a1 1 0 0 1-.97.758H8","M14 4h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3","M18 6h4","m5 10-2 8","m7 18 2-8"] },
  { id: "ruler", label: "Ruler", category: "tools", lucide: "ruler", keywords: ["measure","length"], paths: ["M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z","m14.5 12.5 2-2","m11.5 9.5 2-2","m8.5 6.5 2-2","m17.5 15.5 2-2"] },
  { id: "scissors", label: "Scissors", category: "tools", lucide: "scissors", keywords: ["cut","craft"], paths: ["M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M8.12 8.12 12 12","M20 4 8.12 15.88","M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M14.8 14.8 20 20"] },
  { id: "paintbrush", label: "Paintbrush", category: "tools", lucide: "paintbrush", keywords: ["paint","brush","craft"], paths: ["m14.622 17.897-10.68-2.913","M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z","M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"] },
  { id: "paint-bucket", label: "Paint", category: "tools", lucide: "paint-bucket", keywords: ["paint","bucket","colour","color"], paths: ["M11 7 6 2","M18.992 12H2.041","M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595","m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33"] },
  { id: "toolbox", label: "Toolbox", category: "tools", lucide: "toolbox", keywords: ["tools","case","kit"], paths: ["M16 12v4","M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2","M17 6a2 2 0 011.414.586l3 3A2 2 0 0122 11v8a2 2 0 01-2 2H4a2 2 0 01-2-2v-8a2 2 0 01.586-1.414l3-3A2 2 0 017 6z","M2 14h20","M8 12v4"] },
  { id: "settings", label: "Gear", category: "tools", lucide: "settings", keywords: ["cog","gear","settings","parts"], paths: ["M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915","M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"] },
  { id: "nut", label: "Nut", category: "tools", lucide: "bolt", keywords: ["nut","bolt","hex","fastener","screw","hardware"], paths: ["M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z","M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"] },
  { id: "pickaxe", label: "Pickaxe", category: "tools", lucide: "pickaxe", keywords: ["garden","dig","mining"], paths: ["m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999","M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024","M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069","M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z"] },
  { id: "arrow-up", label: "Arrow up", category: "arrows", lucide: "arrow-up", keywords: ["up","this","way","top"], paths: ["m5 12 7-7 7 7","M12 19V5"] },
  { id: "arrow-down", label: "Arrow down", category: "arrows", lucide: "arrow-down", keywords: ["down","bottom"], paths: ["M12 5v14","m19 12-7 7-7-7"] },
  { id: "arrow-left", label: "Arrow left", category: "arrows", lucide: "arrow-left", keywords: ["left","back"], paths: ["m12 19-7-7 7-7","M19 12H5"] },
  { id: "arrow-right", label: "Arrow right", category: "arrows", lucide: "arrow-right", keywords: ["right","forward","next"], paths: ["M5 12h14","m12 5 7 7-7 7"] },
  { id: "arrow-left-right", label: "Left–right", category: "arrows", lucide: "arrow-left-right", keywords: ["both","ways","horizontal"], paths: ["M8 3 4 7l4 4","M4 7h16","m16 21 4-4-4-4","M20 17H4"] },
  { id: "arrow-up-down", label: "Up–down", category: "arrows", lucide: "arrow-up-down", keywords: ["both","ways","vertical"], paths: ["m21 16-4 4-4-4","M17 20V4","m3 8 4-4 4 4","M7 4v16"] },
  { id: "rotate-cw", label: "Rotate", category: "arrows", lucide: "rotate-cw", keywords: ["turn","clockwise","tighten"], paths: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8","M21 3v5h-5"] },
  { id: "corner-down-right", label: "Turn", category: "arrows", lucide: "corner-down-right", keywords: ["corner","turn","return"], paths: ["m15 10 5 5-5 5","M4 4v7a4 4 0 0 0 4 4h12"] },
  { id: "move", label: "Move", category: "arrows", lucide: "move", keywords: ["move","all","directions"], paths: ["M12 2v20","m15 19-3 3-3-3","m19 9 3 3-3 3","M2 12h20","m5 9-3 3 3 3","m9 5 3-3 3 3"] },
  { id: "warning", label: "Warning", category: "hazard", lucide: "triangle-alert", keywords: ["caution","danger","alert","attention"], paths: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3","M12 9v4","M12 17h.01"] },
  { id: "alert", label: "Alert", category: "hazard", lucide: "circle-alert", keywords: ["attention","important","notice"], paths: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0","M12 8L12 12","M12 16L12.01 16"] },
  { id: "flame", label: "Flammable", category: "hazard", lucide: "flame", keywords: ["fire","hot","flammable","burn"], paths: ["M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"] },
  { id: "skull", label: "Toxic", category: "hazard", lucide: "skull", keywords: ["poison","toxic","danger","death"], paths: ["m12.5 17-.5-1-.5 1h1z","M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z","M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"] },
  { id: "biohazard", label: "Biohazard", category: "hazard", lucide: "biohazard", keywords: ["biological","danger"], paths: ["M10 11.9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0","M6.7 3.4c-.9 2.5 0 5.2 2.2 6.7C6.5 9 3.7 9.6 2 11.6","m8.9 10.1 1.4.8","M17.3 3.4c.9 2.5 0 5.2-2.2 6.7 2.4-1.2 5.2-.6 6.9 1.5","m15.1 10.1-1.4.8","M16.7 20.8c-2.6-.4-4.6-2.6-4.7-5.3-.2 2.6-2.1 4.8-4.7 5.2","M12 13.9v1.6","M13.5 5.4c-1-.2-2-.2-3 0","M17 16.4c.7-.7 1.2-1.6 1.5-2.5","M5.5 13.9c.3.9.8 1.8 1.5 2.5"] },
  { id: "radiation", label: "Radiation", category: "hazard", lucide: "radiation", keywords: ["radioactive","nuclear"], paths: ["M12 12h.01","M14 15.4641a4 4 0 0 1-4 0L7.52786 19.74597 A 1 1 0 0 0 7.99303 21.16211 10 10 0 0 0 16.00697 21.16211 1 1 0 0 0 16.47214 19.74597z","M16 12a4 4 0 0 0-2-3.464l2.472-4.282a1 1 0 0 1 1.46-.305 10 10 0 0 1 4.006 6.94A1 1 0 0 1 21 12z","M8 12a4 4 0 0 1 2-3.464L7.528 4.254a1 1 0 0 0-1.46-.305 10 10 0 0 0-4.006 6.94A1 1 0 0 0 3 12z"] },
  { id: "ban", label: "Prohibited", category: "hazard", lucide: "ban", keywords: ["no","forbidden","stop","not","allowed"], paths: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0","M4.929 4.929 19.07 19.071"] },
  { id: "zap-off", label: "Power off", category: "hazard", lucide: "zap-off", keywords: ["isolated","de-energised","no","power"], paths: ["M10.768 5.111 13.44 2.44a1.5 1.5 0 012.474 1.561l-1.633 4.625","m18.889 13.232.672-.672A1.5 1.5 0 0018.5 10h-2.844","m2 2 20 20","m7.94 7.94-3.5 3.499A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l5.5-5.5"] },
  { id: "hand", label: "Stop", category: "hazard", lucide: "hand", keywords: ["stop","do","not","touch","hand"], paths: ["M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2","M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2","M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8","M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"] },
  { id: "hard-hat", label: "Hard hat", category: "hazard", lucide: "hard-hat", keywords: ["safety","helmet","ppe"], paths: ["M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5","M14 6a6 6 0 0 1 6 6v3","M4 15v-3a6 6 0 0 1 6-6","M3 15h18a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z"] },
  { id: "construction", label: "Construction", category: "hazard", lucide: "construction", keywords: ["barrier","works","roadworks"], paths: ["M3 6h18a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z","M17 14v7","M7 14v7","M17 3v3","M7 3v3","M10 14 2.3 6.3","m14 6 7.7 7.7","m8 6 8 8"] },
  { id: "thermometer", label: "Temperature", category: "hazard", lucide: "thermometer", keywords: ["hot","temperature","heat"], paths: ["M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"] },
  { id: "first-aid", label: "First aid", category: "hazard", lucide: "briefcase-medical", keywords: ["medical","first","aid","kit"], paths: ["M12 11v4","M14 13h-4","M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2","M18 6v14","M6 6v14","M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z"] },
  { id: "house", label: "House", category: "home", lucide: "house", keywords: ["home","building"], paths: ["M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8","M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"] },
  { id: "droplet", label: "Water", category: "home", lucide: "droplet", keywords: ["water","liquid","drop","plumbing"], paths: ["M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"] },
  { id: "snowflake", label: "Frozen", category: "home", lucide: "snowflake", keywords: ["freezer","cold","frozen","ice"], paths: ["m10 20-1.25-2.5L6 18","M10 4 8.75 6.5 6 6","m14 20 1.25-2.5L18 18","m14 4 1.25 2.5L18 6","m17 21-3-6h-4","m17 3-3 6 1.5 3","M2 12h6.5L10 9","m20 10-1.5 2 1.5 2","M22 12h-6.5L14 15","m4 10 1.5 2L4 14","m7 21 3-6-1.5-3","m7 3 3 6h4"] },
  { id: "sun", label: "Sun", category: "home", lucide: "sun", keywords: ["light","day","summer"], paths: ["M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0","M12 2v2","M12 20v2","m4.93 4.93 1.41 1.41","m17.66 17.66 1.41 1.41","M2 12h2","M20 12h2","m6.34 17.66-1.41 1.41","m19.07 4.93-1.41 1.41"] },
  { id: "lamp", label: "Lamp", category: "home", lucide: "lamp", keywords: ["light","lamp"], paths: ["M12 12v6","M4.077 10.615A1 1 0 0 0 5 12h14a1 1 0 0 0 .923-1.385l-3.077-7.384A2 2 0 0 0 15 2H9a2 2 0 0 0-1.846 1.23Z","M8 20a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"] },
  { id: "bed", label: "Bedroom", category: "home", lucide: "bed", keywords: ["bed","sleep","bedroom"], paths: ["M2 4v16","M2 8h18a2 2 0 0 1 2 2v10","M2 17h20","M6 8v9"] },
  { id: "bath", label: "Bathroom", category: "home", lucide: "bath", keywords: ["bath","bathroom","tub"], paths: ["M10 4 8 6","M17 19v2","M2 12h20","M7 19v2","M9 5 7.621 3.621A2.121 2.121 0 0 0 4 5v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"] },
  { id: "key", label: "Key", category: "home", lucide: "key", keywords: ["key","lock","access"], paths: ["m2 21 9.6-9.6","m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19","M10 7.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0"] },
  { id: "lock", label: "Lock", category: "home", lucide: "lock", keywords: ["locked","secure","private"], paths: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z","M7 11V7a5 5 0 0 1 10 0v4"] },
  { id: "door-open", label: "Door", category: "home", lucide: "door-open", keywords: ["door","exit","entrance"], paths: ["M10 21H2","M10 3H7a2 2 0 00-2 2v16","M14 12h.01","M19 21V5a2 2 0 00-1.675-1.974l-6.163-1.013A1 1 0 0010 3v18a1 1 0 001.124.992z","M22 21h-3"] },
  { id: "utensils", label: "Kitchen", category: "home", lucide: "utensils", keywords: ["kitchen","food","cutlery"], paths: ["M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2","M7 2v20","M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"] },
  { id: "coffee", label: "Coffee", category: "home", lucide: "coffee", keywords: ["coffee","tea","mug"], paths: ["M10 2v2","M14 2v2","M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1","M6 2v2"] },
  { id: "refrigerator", label: "Fridge", category: "home", lucide: "refrigerator", keywords: ["fridge","refrigerator","food"], paths: ["M5 6a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z","M5 10h14","M15 7v6"] },
  { id: "washing-machine", label: "Laundry", category: "home", lucide: "washing-machine", keywords: ["washing","laundry"], paths: ["M3 6h3","M17 6h.01","M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z","M7 13a5 5 0 1 0 10 0a5 5 0 1 0 -10 0","M12 18a2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5"] },
  { id: "trash", label: "Trash", category: "home", lucide: "trash", keywords: ["bin","waste","rubbish","garbage"], paths: ["M10 11v6","M14 11v6","M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6","M3 6h18","M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"] },
  { id: "recycle", label: "Recycle", category: "home", lucide: "recycle", keywords: ["recycling","waste"], paths: ["M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5","M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12","m14 16-3 3 3 3","M8.293 13.596 7.196 9.5 3.1 10.598","m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843","m13.378 9.633 4.096 1.098 1.097-4.096"] },
  { id: "leaf", label: "Leaf", category: "home", lucide: "leaf", keywords: ["plant","nature","garden"], paths: ["M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20","M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13"] },
  { id: "sprout", label: "Seedling", category: "home", lucide: "sprout", keywords: ["plant","seed","garden"], paths: ["M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3","M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4","M5 21h14"] },
  { id: "car", label: "Car", category: "home", lucide: "car", keywords: ["garage","vehicle"], paths: ["M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2","M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0","M9 17h6","M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"] },
  { id: "bike", label: "Bike", category: "home", lucide: "bike", keywords: ["bicycle","cycle"], paths: ["M15 17.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0","M2 17.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0","M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","M12 17.5V14l-3-3 4-3 2 3h2"] },
  { id: "shirt", label: "Clothes", category: "home", lucide: "shirt", keywords: ["clothes","wardrobe","shirt"], paths: ["M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"] },
  { id: "pill", label: "Medicine", category: "home", lucide: "pill", keywords: ["medicine","pill","pharmacy"], paths: ["m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z","m8.5 8.5 7 7"] },
  { id: "package", label: "Package", category: "misc", lucide: "package", keywords: ["box","parcel","storage"], paths: ["M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z","M12 22V12","M3.29 7L12 12L20.71 7","m7.5 4.27 9 5.15"] },
  { id: "archive", label: "Archive", category: "misc", lucide: "archive", keywords: ["storage","box","files"], paths: ["M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1z","M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8","M10 12h4"] },
  { id: "folder", label: "Folder", category: "misc", lucide: "folder", keywords: ["files","documents"], paths: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"] },
  { id: "book", label: "Book", category: "misc", lucide: "book", keywords: ["manual","read","library"], paths: ["M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"] },
  { id: "tag", label: "Tag", category: "misc", lucide: "tag", keywords: ["price","label","tag"], paths: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z","M7 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0"] },
  { id: "calendar", label: "Date", category: "misc", lucide: "calendar", keywords: ["date","calendar","expiry"], paths: ["M8 2v3","M16 2v3","M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z","M3 9h18"] },
  { id: "clock", label: "Time", category: "misc", lucide: "clock", keywords: ["time","clock","hours"], paths: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0","M12 6v6l4 2"] },
  { id: "phone", label: "Phone", category: "misc", lucide: "phone", keywords: ["telephone","call","contact"], paths: ["M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"] },
  { id: "mail", label: "Mail", category: "misc", lucide: "mail", keywords: ["email","letter","post","contact"], paths: ["m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7","M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z"] },
  { id: "map-pin", label: "Location", category: "misc", lucide: "map-pin", keywords: ["place","pin","location","address"], paths: ["M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0","M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"] },
  { id: "star", label: "Star", category: "misc", lucide: "star", keywords: ["favourite","important"], paths: ["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"] },
  { id: "heart", label: "Heart", category: "misc", lucide: "heart", keywords: ["love","like","favourite"], paths: ["M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"] },
  { id: "gift", label: "Gift", category: "misc", lucide: "gift", keywords: ["present","birthday"], paths: ["M12 7v14","M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8","M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5","M4 7h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z"] },
  { id: "music", label: "Music", category: "misc", lucide: "music", keywords: ["audio","note","sound"], paths: ["M9 18V5l12-2v13","M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"] },
  { id: "check", label: "Check", category: "misc", lucide: "check", keywords: ["tick","ok","done","yes"], paths: ["M20 6 9 17l-5-5"] },
  { id: "x", label: "Cross", category: "misc", lucide: "x", keywords: ["x","close","no","cancel"], paths: ["M18 6 6 18","m6 6 12 12"] },
  { id: "plus", label: "Plus", category: "misc", lucide: "plus", keywords: ["add","positive"], paths: ["M5 12h14","M12 5v14"] },
  { id: "minus", label: "Minus", category: "misc", lucide: "minus", keywords: ["subtract","negative"], paths: ["M5 12h14"] },
  { id: "info", label: "Info", category: "misc", lucide: "info", keywords: ["information","help"], paths: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0","M12 16v-4","M12 8h.01"] },
  { id: "question", label: "Question", category: "misc", lucide: "circle-question-mark", keywords: ["help","question","unknown"], paths: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0","M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3","M12 17h.01"] },
]

const byId = new Map(ICONS.map((i) => [i.id, i]))

export function iconById(id: string): IconDef | undefined {
  return byId.get(id)
}

/** Case-insensitive search over id, label and keywords (empty query → every icon). */
export function searchIcons(query: string): IconDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...ICONS]
  const terms = q.split(/\s+/)
  return ICONS.filter((i) => {
    const hay = `${i.id} ${i.label.toLowerCase()} ${i.keywords.join(' ')}`
    return terms.every((t) => hay.includes(t))
  })
}
