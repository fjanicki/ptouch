//! `VirtualPrinter`: the core's device-side test double, backing the TS `MockTransport`,
//! the "No printer (virtual)" connect option and the diagnostics page.

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::dto::{VirtualBehaviour, VirtualTiming};
use crate::error::{from_ts_or_default, js_err};
use crate::raster::Bitmap1;
use crate::session::ms;

/// A simulated printer with one media loaded.
#[wasm_bindgen]
#[derive(Debug)]
pub struct VirtualPrinter {
    inner: ptouch::VirtualPrinter,
}

#[wasm_bindgen]
impl VirtualPrinter {
    /// A virtual `model` with `mediaId` loaded.
    ///
    /// # Errors
    /// `UNKNOWN_MODEL`, `UNSUPPORTED_MEDIA`, `INVALID_INPUT` (bad behaviour/timing shape).
    #[wasm_bindgen(constructor)]
    pub fn new(
        model: &str,
        media_id: &str,
        behaviour: Option<Ts<VirtualBehaviour>>,
        timing: Option<Ts<VirtualTiming>>,
    ) -> Result<VirtualPrinter, JsValue> {
        let behaviour = from_ts_or_default(behaviour)?;
        let timing = from_ts_or_default(timing)?;
        crate::convert::virtual_printer(model, media_id, behaviour, &timing)
            .map(|inner| VirtualPrinter { inner })
            .map_err(js_err)
    }

    /// `true` while a page is being "printed" at `nowMs`.
    #[wasm_bindgen(js_name = isPrinting)]
    #[must_use]
    pub fn is_printing(&self, now_ms: f64) -> bool {
        self.inner.is_printing(ms(now_ms))
    }

    /// Bytes written by the host.
    #[wasm_bindgen(js_name = handleInput)]
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: f64) {
        self.inner.handle_input(bytes, ms(now_ms));
    }

    /// Next reply due at `nowMs` (a 32-byte status frame, or a 3-byte printer-settings
    /// reply), or `undefined`.
    #[wasm_bindgen(js_name = pollOutput)]
    #[must_use]
    pub fn poll_output(&mut self, now_ms: f64) -> Option<Vec<u8>> {
        self.inner.poll_output(ms(now_ms))
    }

    /// Stored byte of a printer setting (`op` = `0x70` Auto Power On, `0x41` Auto Power Off
    /// with `selector` `0`/`1`), or `undefined` when the model has no such setting.
    #[wasm_bindgen(js_name = settingByte)]
    #[must_use]
    pub fn setting_byte(&self, op: u8, selector: Option<u8>) -> Option<u8> {
        self.inner.setting_byte(op, selector)
    }

    /// Replaces a stored setting byte (any byte, listed or not, to simulate other software);
    /// returns `false` when the model has no such setting.
    #[wasm_bindgen(js_name = setSettingByte)]
    pub fn set_setting_byte(&mut self, op: u8, selector: Option<u8>, byte: u8) -> bool {
        self.inner.set_setting(op, selector, byte)
    }

    /// Number of settings commits (`ESC ~ S`) received.
    #[must_use]
    pub fn commits(&self) -> u32 {
        u32::try_from(self.inner.commits()).unwrap_or(u32::MAX)
    }

    /// When the next frame becomes due (absolute ms), or `undefined`.
    #[wasm_bindgen(js_name = nextOutputAt)]
    #[must_use]
    pub fn next_output_at(&self) -> Option<f64> {
        #[allow(clippy::cast_precision_loss)]
        self.inner.next_output_at().map(|t| t as f64)
    }

    /// Number of pages printed so far.
    #[wasm_bindgen(getter, js_name = printedCount)]
    #[must_use]
    pub fn printed_count(&self) -> u32 {
        u32::try_from(self.inner.printed().len()).unwrap_or(u32::MAX)
    }

    /// Printed page `index` (0-based), decoded to label orientation.
    #[wasm_bindgen(js_name = printedPage)]
    #[must_use]
    pub fn printed_page(&self, index: u32) -> Option<Bitmap1> {
        self.inner
            .printed()
            .get(index as usize)
            .cloned()
            .map(Bitmap1::from_core)
    }

    /// Protocol violations seen so far (`Debug` text each).
    #[must_use]
    pub fn violations(&self) -> Vec<String> {
        self.inner
            .violations()
            .iter()
            .map(|v| format!("{v:?}"))
            .collect()
    }

    /// The idle status frame this printer would reply with.
    #[wasm_bindgen(js_name = idleStatus)]
    #[must_use]
    pub fn idle_status(&self) -> Vec<u8> {
        self.inner.idle_status().to_vec()
    }
}
