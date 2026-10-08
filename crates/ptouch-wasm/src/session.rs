//! `PrintSession`: the core's sans-IO print state machine (core `Session`).
//!
//! The TS `PrinterClient` (web/src/printer/client.ts) is the only caller: it moves bytes and
//! time in (`handleInput`, `handleTimeout`) and drains `pollTransmit` / `pollEvent`, arming one
//! timer at `pollTimeout()` (ARCHITECTURE.md §4.3, §5.5).

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::convert::{event_dto, resolve_model, session_config, state_dto, status_dto};
use crate::dto::{PrinterStatus, SessionConfig, SessionEvent, SessionState};
use crate::error::{from_ts_or_default, js_err, ts};
use crate::job::Job;

/// Converts a JS `performance.now()` value to the core's `u64` ms (negative/NaN → 0).
#[must_use]
pub fn ms(now_ms: f64) -> u64 {
    if now_ms.is_finite() && now_ms > 0.0 {
        // Truncation is intended: sub-millisecond precision is irrelevant here.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let v = now_ms as u64;
        v
    } else {
        0
    }
}

/// The print session.
#[wasm_bindgen]
#[derive(Debug)]
pub struct PrintSession {
    inner: ptouch::Session,
}

#[wasm_bindgen]
impl PrintSession {
    /// New idle session. `model` = known model name, or `undefined` / `""` to detect it from
    /// the first status reply (normal for Web Serial; a known model is additionally verified
    /// against the reply). `config` overrides timing defaults.
    ///
    /// # Errors
    /// `UNKNOWN_MODEL` for an unknown name, `INVALID_INPUT` for a bad config shape.
    #[wasm_bindgen(constructor)]
    pub fn new(
        model: Option<String>,
        config: Option<Ts<SessionConfig>>,
    ) -> Result<PrintSession, JsValue> {
        let cfg = session_config(&from_ts_or_default(config)?);
        let profile = match model.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(name) => Some(resolve_model(name).map_err(js_err)?),
        };
        Ok(PrintSession {
            inner: ptouch::Session::new(profile, cfg),
        })
    }

    /// Starts the handshake (queues reset + status request).
    pub fn connect(&mut self, now_ms: f64) {
        self.inner.connect(ms(now_ms));
    }

    /// Queues an explicit status request.
    ///
    /// The reply arrives as a `status` event (and updates `lastStatus()`); without a reply a
    /// `failed` event with code `TIMEOUT` (`timeout: "status"`) follows.
    ///
    /// # Errors
    /// `BUSY` while handshaking, printing or recovering, and in the `failed` state.
    #[wasm_bindgen(js_name = requestStatus)]
    pub fn request_status(&mut self, now_ms: f64) -> Result<(), JsValue> {
        self.inner.request_status(ms(now_ms)).map_err(js_err)
    }

    /// Submits a job (preflight against the last status). Borrows the job (cloned inside).
    ///
    /// # Errors
    /// `BUSY`, `NOT_READY`, `NO_MEDIA`, `MEDIA_MISMATCH`, `PRINTER`, `UNKNOWN_MODEL`,
    /// `UNSUPPORTED`, `EMPTY`, `INVALID_INPUT`.
    pub fn submit(&mut self, job: &Job, now_ms: f64) -> Result<(), JsValue> {
        self.inner
            .submit(job.inner.clone(), ms(now_ms))
            .map_err(js_err)
    }

    /// Cancels the job / handshake (queues invalidate + reset; a `failed` event with code
    /// `CANCELLED` follows).
    pub fn cancel(&mut self, now_ms: f64) {
        self.inner.cancel(ms(now_ms));
    }

    /// Feeds bytes read from the transport (any fragmentation).
    #[wasm_bindgen(js_name = handleInput)]
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: f64) {
        self.inner.handle_input(bytes, ms(now_ms));
    }

    /// Call when the deadline from [`Self::poll_timeout`] has passed.
    #[wasm_bindgen(js_name = handleTimeout)]
    pub fn handle_timeout(&mut self, now_ms: f64) {
        self.inner.handle_timeout(ms(now_ms));
    }

    /// Next buffer to write, in order; `undefined` when nothing is queued.
    #[wasm_bindgen(js_name = pollTransmit)]
    #[must_use]
    pub fn poll_transmit(&mut self) -> Option<Vec<u8>> {
        self.inner.poll_transmit()
    }

    /// Next event; `undefined` when none.
    ///
    /// # Errors
    /// Only on an internal serialization failure.
    #[wasm_bindgen(js_name = pollEvent)]
    pub fn poll_event(&mut self) -> Result<Option<Ts<SessionEvent>>, JsValue> {
        while let Some(e) = self.inner.poll_event() {
            if let Some(dto) = event_dto(&e) {
                return ts(&dto).map(Some);
            }
        }
        Ok(None)
    }

    /// Absolute deadline in ms (same clock as `nowMs`), or `undefined`.
    #[wasm_bindgen(js_name = pollTimeout)]
    #[must_use]
    pub fn poll_timeout(&self) -> Option<f64> {
        #[allow(clippy::cast_precision_loss)]
        self.inner.poll_timeout().map(|t| t as f64)
    }

    /// Coarse state for the UI.
    ///
    /// # Errors
    /// Only on an internal serialization failure.
    pub fn state(&self) -> Result<Ts<SessionState>, JsValue> {
        ts(&state_dto(self.inner.state()))
    }

    /// Last parsed status, if any.
    ///
    /// # Errors
    /// Only on an internal serialization failure.
    #[wasm_bindgen(js_name = lastStatus)]
    pub fn last_status(&self) -> Result<Option<Ts<PrinterStatus>>, JsValue> {
        self.inner
            .last_status()
            .map(|s| ts(&status_dto(s)))
            .transpose()
    }

    /// Detected (or configured) model name.
    #[wasm_bindgen(getter, js_name = modelName)]
    #[must_use]
    pub fn model_name(&self) -> Option<String> {
        self.inner.profile().map(|p| p.name.to_owned())
    }
}
