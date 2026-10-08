//! # ptouch-wasm — browser bindings of the `ptouch` core
//!
//! **Bindings only.** Every protocol decision lives in the sans-IO core (`crates/ptouch`);
//! this crate converts types, maps errors and owns no logic (ARCHITECTURE.md §4.2). The web
//! studio (`web/`) loads it through `web/src/wasm/index.ts`.
//!
//! Built with `wasm-pack build crates/ptouch-wasm --target web --release
//! --out-dir ../../web/src/wasm/pkg --out-name ptouch` (`npm run wasm` in `web/`).
//!
//! ## Conventions (contract with `web/`, see docs/WEB-IMPLEMENTATION-PLAN.md §2.1)
//! - Errors are thrown as real JS `Error`s with `name = "PtouchError"` and a stable `code`
//!   (`ptouch::Error::code()`); [`is_ptouch_error`] / the TS `isPtouchError` guard detects them.
//! - Structured values cross the boundary as tsify [`tsify::Ts<T>`] (never the deprecated
//!   `into_wasm_abi`/`from_wasm_abi`, which leak on bad input, tsify#65). DTOs live in [`dto`]
//!   and use camelCase field names and kebab-case string enums.
//! - Byte buffers: `&[u8]` in (`Uint8Array`), `Vec<u8>` out (copied `Uint8Array`).
//! - Times are `f64` milliseconds (`performance.now()`), converted to the core's `u64`.
//! - Models are addressed by name (`"PT-P710BT"`, any alias accepted by
//!   `ptouch::profile_by_name`), media by stable id (`"tze128-24"`).
//! - Class handles (`Raster`, `Bitmap1`, `Job`, `PrintSession`, `VirtualPrinter`,
//!   `DecodedJob`, `StatusFramer`) own wasm memory: JS must free each exactly once. `encodeJob`
//!   and `Raster.finish` consume their handles, after which the generated `.free()` /
//!   `[Symbol.dispose]` throw; JS callers should use the web wrapper's `release()` / `scoped()`
//!   (web/src/wasm/index.ts), which also makes `using` safe on consumed handles and checks
//!   `encodeJob`'s pages before any is consumed.
//!
//! ## Deviations from ARCHITECTURE.md §4.2 (forced by the implemented core API)
//! - `printArea(model, mediaId)` instead of `(model_code, width_mm)`: the core resolves media by
//!   (width byte, kind); ids are unambiguous and stable. `mediaForWidth` / `mediaForStatus`
//!   resolve ids.
//! - `PrintSession.submit(job, nowMs)` has no `job_width_mm`: the core's `Session::submit` reads
//!   the media from the `EncodedJob` itself. `submit` borrows the `Job` (clones it) so the same
//!   job can still be downloaded with `toBytes()`.
//! - `Raster.blitCode(m, x, y, moduleDots, quietZone)` takes `quietZone` (core signature).
//! - `encodeCode` is implemented here with `fast_qr` / `barcoders` (ARCHITECTURE §10 versions)
//!   because the core has no `codes` feature yet; moving it into the core later is additive.
//! - Error codes: the core has 21 codes (see `PtouchErrorCode` below), a superset of §4.2.
//!   Binding-level lookups reuse them: an unknown model *name* is `UNKNOWN_MODEL`, a media id
//!   the model does not offer is `UNSUPPORTED_MEDIA`, a bad JS value is `INVALID_INPUT`.
//! - Additive extras (no core change): `JobOptions.copies`, `SessionConfig.maxTicks` /
//!   `phaseFrameWaitMs`, `ErrorInfo.timeout`, `PhaseKind "other"`, `Bitmap1.fromLuma` /
//!   `fromRgba` / `cropLines`, `Job.modelName` / `highResolution` / `byteLength`,
//!   `DecodedJob.pageCount`, `VirtualPrinter.isPrinting`, `StatusFramer` (wraps the core framer
//!   for the diagnostics link probe, so no status framing is re-implemented in JS).
//!
//! No core (`crates/ptouch`) API was added or changed for these bindings.

pub mod codes;
pub mod convert;
pub mod dto;
pub mod error;
pub mod job;
pub mod models;
pub mod raster;
pub mod session;
pub mod status;
pub mod virtual_printer;

use wasm_bindgen::prelude::*;

pub use codes::encode_code;
pub use error::is_ptouch_error;
pub use job::{DecodedJob, Job, decode_job, encode_job};
pub use models::{list_models, media_for_status, media_for_width, print_area};
pub use raster::{Bitmap1, Raster};
pub use session::PrintSession;
pub use status::{StatusFramer, cancel_sequence, generic_handshake, parse_status, status_request};
pub use virtual_printer::VirtualPrinter;

/// TypeScript declarations for the error contract (also checked by the native tests).
#[allow(dead_code)] // read by the wasm32 custom section below and by the native tests
pub(crate) const TS_ERRORS: &str = r#"
/** Stable error codes, mirrored from `ptouch::Error::code()` (crates/ptouch/src/error.rs). */
export type PtouchErrorCode =
  | "STATUS_LENGTH" | "STATUS_HEADER" | "UNKNOWN_MODEL" | "UNSUPPORTED_MEDIA" | "BITMAP_SIZE"
  | "DATA_LENGTH" | "TOO_SHORT" | "TOO_LONG" | "EMPTY" | "MEDIA_MISMATCH" | "NO_MEDIA"
  | "NOT_READY" | "PRINTER" | "PRINTER_OFF" | "BUSY" | "TIMEOUT" | "CANCELLED" | "UNSUPPORTED"
  | "INVALID_INPUT" | "CORRUPT" | "PROTOCOL";
/** Thrown by every fallible export. `err.name === "PtouchError"`. */
export interface PtouchError extends Error { name: "PtouchError"; code: PtouchErrorCode; }
/** Type guard for errors thrown by this module. */
export function isPtouchError(e: unknown): e is PtouchError;
"#;

#[wasm_bindgen(typescript_custom_section)]
const TS_ERRORS_SECTION: &'static str = TS_ERRORS;

/// Version of the `ptouch` core this module was built from (e.g. `"0.1.0"`).
#[wasm_bindgen]
#[must_use]
pub fn version() -> String {
    ptouch::VERSION.to_owned()
}
