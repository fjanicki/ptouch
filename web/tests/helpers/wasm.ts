// W1 — loads the wasm module synchronously in node (Vitest `unit` project). The browser build
// uses `loadWasm()` (fetch); node has no fetch-from-file for import.meta.url, so read the bytes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initSync } from '../../src/wasm/pkg/ptouch.js'
import { markWasmLoaded } from '../../src/wasm/index'

let done = false
let memory: WebAssembly.Memory | undefined

/** Size of the wasm linear memory in bytes (it grows, never shrinks: leak checks). */
export function wasmMemoryBytes(): number {
  return memory?.buffer.byteLength ?? 0
}

export function loadWasmForTests(): void {
  if (done) return
  const path = fileURLToPath(new URL('../../src/wasm/pkg/ptouch_bg.wasm', import.meta.url))
  const exports = initSync({ module: readFileSync(path) }) as unknown as { memory?: WebAssembly.Memory }
  memory = exports.memory
  markWasmLoaded()
  done = true
}

/** The real PT-P710BT status reply (24 mm laminated white tape, black text; 2026-10-08). */
export const P710BT_STATUS_24MM = new Uint8Array([
  0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])
