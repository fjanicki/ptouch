//! Error mapping: `ptouch::Error` (and binding-level lookups) → JS `Error { name: "PtouchError",
//! code }`.
//!
//! [`BindError`] is plain Rust so every conversion is unit-testable natively; only [`to_js`]
//! touches JS.

use js_sys::{Error as JsError, Reflect};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tsify::{Ts, Tsify};
use wasm_bindgen::prelude::*;

/// An error raised by a binding: either a core error or a binding-level lookup failure
/// (unknown model *name*, media id not offered by a model, bad JS value) that carries one of
/// the same stable codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// A core error; `code` = [`ptouch::Error::code`].
    Core(ptouch::Error),
    /// A binding-level error with an explicit code from the `PtouchErrorCode` set.
    Coded {
        /// Stable code (`PtouchErrorCode`).
        code: &'static str,
        /// English message.
        message: String,
    },
}

impl BindError {
    /// Stable code (`PtouchErrorCode`).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Core(e) => e.code(),
            Self::Coded { code, .. } => code,
        }
    }

    /// English message.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Core(e) => e.to_string(),
            Self::Coded { message, .. } => message.clone(),
        }
    }

    /// `UNKNOWN_MODEL` for a model name no profile matches.
    #[must_use]
    pub fn unknown_model(name: &str) -> Self {
        Self::Coded {
            code: "UNKNOWN_MODEL",
            message: format!("unknown printer model \"{name}\""),
        }
    }

    /// `UNSUPPORTED_MEDIA` for a media id or width the model does not offer.
    #[must_use]
    pub fn unsupported_media(model: &str, what: &str) -> Self {
        Self::Coded {
            code: "UNSUPPORTED_MEDIA",
            message: format!("{model} does not support media {what}"),
        }
    }

    /// `INVALID_INPUT` with a free-form message.
    #[must_use]
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Coded {
            code: "INVALID_INPUT",
            message: message.into(),
        }
    }
}

impl From<ptouch::Error> for BindError {
    fn from(e: ptouch::Error) -> Self {
        Self::Core(e)
    }
}

/// Converts an error into a real JS `Error` (has a stack, `instanceof Error`) with
/// `name = "PtouchError"`, the stable `code` and the English `message`.
#[must_use]
pub fn to_js(e: &BindError) -> JsValue {
    let err = JsError::new(&e.message());
    err.set_name("PtouchError");
    // Setting a property on a fresh Error object cannot fail; ignore the Result anyway.
    let _ = Reflect::set(
        &err,
        &JsValue::from_str("code"),
        &JsValue::from_str(e.code()),
    );
    err.into()
}

/// Shorthand for `map_err(js_err)` on core or binding results.
#[must_use]
pub fn js_err(e: impl Into<BindError>) -> JsValue {
    to_js(&e.into())
}

/// A (de)serialization failure at the boundary (bad shape passed from JS): reported as
/// `PtouchError` with code `INVALID_INPUT` and the serde message.
#[must_use]
pub fn bad_input(e: &dyn core::fmt::Display) -> JsValue {
    to_js(&BindError::invalid(format!("invalid input: {e}")))
}

/// Serializes a DTO for JS (`INVALID_INPUT` on the — practically impossible — failure).
///
/// # Errors
/// See above.
pub fn ts<T: Tsify + Serialize>(v: &T) -> Result<Ts<T>, JsValue> {
    Ts::from_rust(v).map_err(|e| bad_input(&e))
}

/// Deserializes an optional DTO from JS; `undefined` / `null` → `T::default()`.
///
/// # Errors
/// `INVALID_INPUT` for a value of the wrong shape.
pub fn from_ts_or_default<T>(v: Option<Ts<T>>) -> Result<T, JsValue>
where
    T: Tsify + DeserializeOwned + Default,
    <T as Tsify>::JsType: Clone,
{
    v.map_or_else(|| Ok(T::default()), |v| from_ts(&v))
}

/// Deserializes a DTO from JS.
///
/// # Errors
/// `INVALID_INPUT` for a value of the wrong shape.
pub fn from_ts<T>(v: &Ts<T>) -> Result<T, JsValue>
where
    T: Tsify + DeserializeOwned,
    <T as Tsify>::JsType: Clone,
{
    v.to_rust().map_err(|e| bad_input(&e))
}

/// `true` if `e` is an error thrown by this module (`name === "PtouchError"`).
/// TS signature is declared in the custom section in `lib.rs` as a type guard.
#[wasm_bindgen(js_name = isPtouchError, skip_typescript)]
#[must_use]
pub fn is_ptouch_error(e: &JsValue) -> bool {
    e.dyn_ref::<JsError>()
        .is_some_and(|e| e.name() == "PtouchError")
}
