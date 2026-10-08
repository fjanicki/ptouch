//! Serde schema of `docs/models.toml`.
//!
//! Every struct uses `deny_unknown_fields`: a new key in the TOML is a hard error until it is
//! added here (and, if the library needs it, to `ptouch::ModelProfile` / `ptouch::TapeSpec`).
//! Keys that may be unknown for a model are `Option`; the validator checks that an absent key
//! is either legitimately absent or listed in the model's `unknown` array.

use serde::Deserialize;

/// The whole file.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    /// Schema version; the generator understands version [`SCHEMA_VERSION`] only.
    pub schema_version: u32,
    /// Transport constants shared by every model.
    pub meta: Meta,
    /// `[[model]]` entries, in table order.
    pub model: Vec<ModelRow>,
    /// `[[media]]` entries, in table order.
    pub media: Vec<MediaRow>,
}

/// The schema version this generator implements.
pub const SCHEMA_VERSION: u32 = 1;

/// `[meta]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Meta {
    pub usb_vendor_id: u16,
    pub usb_out_endpoint: u8,
    pub usb_in_endpoint: u8,
    pub spp_uuid: String,
    pub status_length: u8,
    pub status_header: Vec<u8>,
    pub ble_service_uuid: String,
    pub ble_read_uuid: String,
    pub ble_write_uuid: String,
    pub ble_write_no_response_uuid: String,
    pub ble_notify_uuid: String,
    pub snmp_status_oid: String,
}

/// `page_command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageCommand {
    StartEnd,
    StartNextEnd,
}

/// `default_compression`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    None,
    PackBits,
}

/// `cancel_command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CancelCommand {
    #[serde(rename = "esc_at")]
    EscAt,
    #[serde(rename = "esc_i_18")]
    EscI18,
}

/// `battery_format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryFormat {
    Reserved,
    Legacy,
    LevelAc,
    None,
}

/// `bt_socket_security`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BtSocketSecurity {
    Insecure,
    Secure,
}

/// Media `geometry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Geometry {
    Pt128,
    Pt3,
    Aura64,
    Pt560,
}

/// Media `kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TapeKind {
    Tze,
    Hs2,
    Hs3,
    Sl,
    Fle,
}

/// One `[[model]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRow {
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub model_code: u8,
    pub series_code: u8,
    pub usb_pid: Option<u16>,
    pub bluetooth: bool,
    pub ble: bool,
    pub network: bool,
    pub dpi: u16,
    pub high_res_feed_dpi: Option<u16>,
    pub head_pins: u16,
    pub bytes_per_line: u16,
    pub max_print_pins: u16,
    pub max_tape_mm: u8,
    pub null_bytes: u16,
    pub page_command: PageCommand,
    pub protocol_version: Option<u8>,
    pub needs_mode_switch: bool,
    pub raster_is_default: Option<bool>,
    pub supports_compression: bool,
    pub default_compression: Compression,
    pub supports_auto_cut: bool,
    pub supports_cut_mark: bool,
    pub supports_cut_every: Option<bool>,
    pub supports_chain: Option<bool>,
    pub supports_half_cut: bool,
    pub supports_special_tape: bool,
    pub special_tape_k: Option<u8>,
    pub supports_mirror: bool,
    pub supports_two_color: bool,
    pub supports_high_resolution: bool,
    pub supports_draft: bool,
    pub supports_status_notify: bool,
    pub sends_stored_up_print: bool,
    pub sends_color_info: bool,
    pub sends_copies_command: bool,
    pub sends_mode_reset_at_end: bool,
    pub cancel_command: CancelCommand,
    pub bt_socket_security: Option<BtSocketSecurity>,
    pub rfcomm_channel_observed: Option<u8>,
    pub min_feed_dots: u16,
    pub min_length_mm: Option<f64>,
    pub battery_format: Option<BatteryFormat>,
    pub editor_min_label_mm: Option<f64>,
    pub max_length_mm: Option<f64>,
    pub media: Vec<String>,
    #[serde(default)]
    pub quirks: Vec<String>,
    #[serde(default)]
    pub unknown: Vec<String>,
}

impl ModelRow {
    /// For every key that may be absent: `Some(is_present)`. `None` for a key name that is
    /// not an optional model key (so it can never legitimately appear in `unknown`).
    pub fn optional_key_present(&self, key: &str) -> Option<bool> {
        Some(match key {
            "usb_pid" => self.usb_pid.is_some(),
            "high_res_feed_dpi" => self.high_res_feed_dpi.is_some(),
            "protocol_version" => self.protocol_version.is_some(),
            "raster_is_default" => self.raster_is_default.is_some(),
            "supports_cut_every" => self.supports_cut_every.is_some(),
            "supports_chain" => self.supports_chain.is_some(),
            "special_tape_k" => self.special_tape_k.is_some(),
            "bt_socket_security" => self.bt_socket_security.is_some(),
            "rfcomm_channel_observed" => self.rfcomm_channel_observed.is_some(),
            "min_length_mm" => self.min_length_mm.is_some(),
            "battery_format" => self.battery_format.is_some(),
            "editor_min_label_mm" => self.editor_min_label_mm.is_some(),
            "max_length_mm" => self.max_length_mm.is_some(),
            _ => return None,
        })
    }
}

/// One `[[media]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaRow {
    pub id: String,
    pub geometry: Geometry,
    pub head_pins: u16,
    pub kind: TapeKind,
    pub width_mm: f64,
    pub length_mm: Option<u8>,
    pub media_width_byte: u8,
    pub status_media_type: u8,
    pub print_info_media_type: u8,
    pub print_info_media_type_high_res: Option<u8>,
    pub left_margin_pins: u16,
    pub print_pins: u16,
    pub right_margin_pins: u16,
    pub tape_width_dots: u16,
    pub default_feed_dots: u16,
    pub physical_length_dots: Option<u16>,
    pub printable_length_dots: Option<u16>,
}
