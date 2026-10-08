//! # ptouch — sans-IO protocol core for Brother P-touch label printers
//!
//! This crate implements the Brother P-touch raster protocol as specified in
//! `docs/PROTOCOL.md` (normative) for the model/media table in `docs/models.toml`.
//! It is **sans-IO**: it never opens a port, sleeps, spawns a thread or reads a clock.
//! Callers move bytes and time in and out (`now_ms: u64`), which makes the same code run
//! natively (`ptouch-cli` over `ptouch-transport`) and in the browser (WebAssembly).
//!
//! ## Crate invariants
//! - `#![no_std]` + `alloc`. Builds for `wasm32-unknown-unknown` and `thumbv7em-none-eabihf`
//!   (`cargo check-wasm`, `cargo check-nostd`).
//! - No `HashMap`, no floating-point state in tables, no global state.
//! - No `unwrap`/`expect`/`panic!` on input-derived data; every fallible operation returns
//!   [`Error`].
//!
//! ## Module map (data flow, ARCHITECTURE.md §5)
//! ```text
//! model ─────────────► ModelProfile / TapeSpec (static tables, generated from docs/models.toml)
//! bitmap, raster, dither ─► Bitmap (1-bpp, print order)
//! packbits ──────────► TIFF PackBits line compression
//! encode ────────────► EncodedJob { preamble, pages } (byte-exact job, PROTOCOL.md §6)
//! status ────────────► Status (32-byte reply), StatusFramer (stream reassembly)
//! session ───────────► Session (print state machine: bytes + time in, bytes + events out)
//! virtual_printer ───► VirtualPrinter (device-side test double; feature "virtual")
//! ```
//!
//! ## Features
//! - `virtual` (default): [`virtual_printer`].
//! - `serde`: `Serialize`/`Deserialize` derives on public data types.
//! - `std`: small conveniences that need `std`; never required.

#![no_std]
#![cfg_attr(docsrs, feature(doc_auto_cfg))]

extern crate alloc;
#[cfg(feature = "std")]
extern crate std;

pub mod bitmap;
pub mod dither;
pub mod encode;
pub mod error;
pub mod model;
pub mod packbits;
pub mod raster;
pub mod session;
pub mod status;
#[cfg(feature = "virtual")]
pub mod virtual_printer;

pub use bitmap::Bitmap;
pub use dither::{Dither, ToneAdjust};
pub use encode::{
    EncodedJob, JobOptions, STATUS_REQUEST, cancel_sequence, encode_job, prepare_pages,
    reset_sequence,
};
pub use error::{Error, TimeoutKind};
pub use model::{
    Compression, FeedOrder, Model, ModelProfile, TapeKind, TapeSpec, all_media, media_by_id,
    media_for_geometry, profile, profile_by_bt_name, profile_by_codes, profile_by_name,
    profile_by_usb_pid, profiles, profiles_by_usb_pid, tape_for_status, tape_spec,
};
pub use packbits::{packbits_decode, packbits_encode};
pub use raster::{LabelRaster, ModuleMatrix};
pub use session::{Event, Session, SessionConfig, SessionState};
pub use status::{
    MediaType, Notification, Phase, PrinterError, PrinterErrors, STATUS_LEN, Status, StatusFramer,
    StatusType, TapeColor, TextColor, parse_status,
};
#[cfg(feature = "virtual")]
pub use virtual_printer::{Behaviour, VirtualPrinter, VirtualTiming, decode_job};

/// Crate version (`CARGO_PKG_VERSION`), e.g. for `ptouch --version` and the wasm `version()`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
