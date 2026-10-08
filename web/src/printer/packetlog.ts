// W2 — hex packet log (">>" host → printer, "<<" printer → host, "--" notes). Ring buffer,
// observable; rendered by the diagnostics page (W5) and included in "copy diagnostics".

export type PacketDir = '>>' | '<<' | '--'

export interface PacketLogEntry {
  /** performance.now() ms. */
  t: number
  dir: PacketDir
  bytes?: Uint8Array
  note?: string
}

export class PacketLog {
  readonly #capacity: number
  #entries: PacketLogEntry[] = []
  #listeners = new Set<(entries: readonly PacketLogEntry[]) => void>()

  constructor(capacity = 2000) {
    this.#capacity = capacity
  }

  /** Records bytes (copied). Long writes (raster data) are stored truncated by the UI, not here. */
  push(dir: Exclude<PacketDir, '--'>, bytes: Uint8Array): void {
    this.#add({ t: performance.now(), dir, bytes: bytes.slice() })
  }

  note(text: string): void {
    this.#add({ t: performance.now(), dir: '--', note: text })
  }

  entries(): readonly PacketLogEntry[] {
    return this.#entries
  }

  clear(): void {
    this.#entries = []
    this.#emit()
  }

  subscribe(fn: (entries: readonly PacketLogEntry[]) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  /**
   * Plain-text dump, one line per entry: `+12.345 s >> 1B 69 53` with times relative to the
   * first entry, hex truncated to `maxBytes` ("… (+N bytes)").
   */
  toText(maxBytes = 64): string {
    const t0 = this.#entries[0]?.t ?? 0
    return this.#entries
      .map((e) => {
        const t = `+${((e.t - t0) / 1000).toFixed(3)} s`.padStart(11)
        if (e.dir === '--' || !e.bytes) return `${t} -- ${e.note ?? ''}`
        const more = e.bytes.length > maxBytes ? ` … (+${e.bytes.length - maxBytes} bytes)` : ''
        return `${t} ${e.dir} ${toHex(e.bytes.subarray(0, maxBytes))}${more}`
      })
      .join('\n')
  }

  #add(e: PacketLogEntry): void {
    this.#entries.push(e)
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity)
    this.#emit()
  }

  #emit(): void {
    for (const fn of this.#listeners) fn(this.#entries)
  }
}

/** "1B 69 53". */
export function toHex(bytes: Uint8Array, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep)
}

/** Parses "1b 69 53" / "1B6953" / "0x1b,0x69"; throws on odd digits or non-hex. */
export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, '').replace(/[\s,]/g, '')
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error('invalid hex')
  return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16))
}
