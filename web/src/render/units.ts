// W3 — unit conversions. PT-P710BT: 180 dpi head and feed → 7.0866 dots/mm.
export const MM_PER_INCH = 25.4

export function mmToDots(mm: number, dpi = 180): number {
  return Math.round((mm * dpi) / MM_PER_INCH)
}

export function dotsToMm(dots: number, dpi = 180): number {
  return (dots * MM_PER_INCH) / dpi
}

/** CSS colour names a tape/ink can report or a user is likely to type. */
const NAMED: Record<string, number> = {
  black: 0x000000,
  white: 0xffffff,
  red: 0xff0000,
  green: 0x008000,
  lime: 0x00ff00,
  blue: 0x0000ff,
  navy: 0x000080,
  yellow: 0xffff00,
  gold: 0xffd700,
  orange: 0xffa500,
  pink: 0xffc0cb,
  purple: 0x800080,
  violet: 0xee82ee,
  gray: 0x808080,
  grey: 0x808080,
  silver: 0xc0c0c0,
  brown: 0xa52a2a,
  beige: 0xf5f5dc,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  transparent: 0xffffff,
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

/**
 * `0xRRGGBB` number from a CSS colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()`
 * (comma or space syntax, alpha ignored) or a common colour name. Black on parse failure.
 */
export function cssToRgb(css: string): number {
  const s = css.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6)
    return parseInt(full, 16)
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/.exec(s)
  if (rgb) {
    const ch = (v: string | undefined): number => (v?.endsWith('%') ? clampByte(parseFloat(v) * 2.55) : clampByte(parseFloat(v ?? '0')))
    return (ch(rgb[1]) << 16) | (ch(rgb[2]) << 8) | ch(rgb[3])
  }
  return NAMED[s] ?? 0
}

/** `#rrggbb` for a `0xRRGGBB` number. */
export function rgbToCss(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}
