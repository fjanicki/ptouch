//! Status parsing and raw command sequences (for the diagnostics page).

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::convert::{resolve_model, status_dto};
use crate::dto::PrinterStatus;
use crate::error::{js_err, ts};

/// Parses one 32-byte status frame into a rich typed object (model, media id, colours,
/// errors, phase, battery …).
///
/// # Errors
/// `STATUS_LENGTH`, `STATUS_HEADER`.
#[wasm_bindgen(js_name = parseStatus)]
pub fn parse_status(bytes: &[u8]) -> Result<Ts<PrinterStatus>, JsValue> {
    let status = ptouch::parse_status(bytes).map_err(js_err)?;
    ts(&status_dto(&status))
}

/// `1B 69 53` (ESC i S, status request).
#[wasm_bindgen(js_name = statusRequest)]
#[must_use]
pub fn status_request() -> Vec<u8> {
    ptouch::STATUS_REQUEST.to_vec()
}

/// First-contact handshake for an unknown model: `00×200 1B 40 1B 69 61 01`
/// (core `generic_handshake_sequence`). The diagnostics page sends this followed by
/// [`status_request`].
#[wasm_bindgen(js_name = genericHandshake)]
#[must_use]
pub fn generic_handshake() -> Vec<u8> {
    ptouch::encode::generic_handshake_sequence()
}

/// Cancel / recovery bytes for `model` (core `cancel_sequence`).
///
/// # Errors
/// `UNKNOWN_MODEL`.
#[wasm_bindgen(js_name = cancelSequence)]
pub fn cancel_sequence(model: &str) -> Result<Vec<u8>, JsValue> {
    let p = resolve_model(model).map_err(js_err)?;
    Ok(ptouch::cancel_sequence(p))
}

/// Reassembles status frames from a chunked byte stream (core `StatusFramer`: resyncs on
/// `80 20 42`, drops truncated candidates, bounded memory). For tools that read raw bytes
/// without a [`crate::PrintSession`] (the diagnostics link probe), so no framing rules are
/// re-implemented in JS.
#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct StatusFramer {
    inner: ptouch::StatusFramer,
}

#[wasm_bindgen]
impl StatusFramer {
    /// An empty framer.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends received bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        self.inner.push(bytes);
    }

    /// Next complete, parsed frame (`raw` holds its 32 bytes); `undefined` when none is
    /// complete yet. Frames whose header matched but that failed to parse are skipped.
    ///
    /// # Errors
    /// Only on an internal serialization failure.
    #[wasm_bindgen(js_name = nextFrame)]
    pub fn next_frame(&mut self) -> Result<Option<Ts<PrinterStatus>>, JsValue> {
        while let Some(frame) = self.inner.next_frame() {
            if let Ok(status) = frame {
                return ts(&status_dto(&status)).map(Some);
            }
        }
        Ok(None)
    }

    /// Bytes thrown away while resynchronising (line noise, truncated frames).
    #[wasm_bindgen(getter, js_name = discardedBytes)]
    #[must_use]
    pub fn discarded_bytes(&self) -> usize {
        self.inner.discarded_bytes()
    }

    /// Buffered bytes not yet returned as a frame.
    #[wasm_bindgen(getter, js_name = pendingBytes)]
    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.inner.pending_bytes()
    }
}
