//! `ptouch info`. Prints the model table (offline): all models, or one model with its
//! media/print-area table (PROTOCOL.md §5.2).

use std::fmt::Write as _;
use std::io::Write as _;

use ptouch::ModelProfile;
use ptouch::model::PageCommand;

use super::{find_model, format_mm_x10, kind_name, unknown_model};
use crate::cli::{Cli, InfoArgs};
use crate::error::CliError;

/// Runs the subcommand.
///
/// # Errors
/// [`CliError::Usage`] for an unknown model name.
pub fn run(_cli: &Cli, args: &InfoArgs) -> Result<(), CliError> {
    match &args.model {
        None => {
            let _ = write!(std::io::stdout().lock(), "{}", model_table());
        }
        Some(name) => {
            let p = find_model(name).ok_or_else(|| unknown_model(name))?;
            let _ = write!(std::io::stdout().lock(), "{}", model_details(p));
        }
    }
    Ok(())
}

fn links(p: &ModelProfile) -> String {
    let mut v = Vec::new();
    if p.transports.bluetooth {
        v.push("Bluetooth");
    }
    if p.transports.ble {
        v.push("BLE");
    }
    if p.has_usb() {
        v.push("USB");
    }
    if p.transports.network {
        v.push("network");
    }
    if v.is_empty() {
        "—".to_owned()
    } else {
        v.join(", ")
    }
}

/// One line per model.
#[must_use]
pub fn model_table() -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "{:<12} {:<6} {:>5} {:>4} {:>8}  {:<26} {:>5}",
        "MODEL", "CODES", "PINS", "DPI", "MAX TAPE", "LINKS", "MEDIA"
    );
    for p in ptouch::profiles() {
        let _ = writeln!(
            s,
            "{:<12} {:02X}/{:02X}  {:>5} {:>4} {:>5} mm  {:<26} {:>5}",
            p.name,
            p.series_code,
            p.model_code,
            p.head_pins,
            p.dpi,
            p.max_tape_mm,
            links(p),
            p.media.len()
        );
    }
    let _ = writeln!(s, "\nDetails and print areas: ptouch info <MODEL>");
    s
}

fn yes(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

fn maybe(b: Option<bool>) -> &'static str {
    match b {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    }
}

/// Model summary plus its media table.
#[must_use]
pub fn model_details(p: &ModelProfile) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "{}", p.name);
    if !p.aliases.is_empty() {
        let _ = writeln!(s, "  aliases          {}", p.aliases.join(", "));
    }
    let _ = writeln!(
        s,
        "  status codes     series 0x{:02X}, model 0x{:02X}",
        p.series_code, p.model_code
    );
    if let Some(pid) = p.usb_pid {
        let _ = writeln!(
            s,
            "  USB              {:04x}:{pid:04x}",
            ptouch::model::USB_VENDOR_ID
        );
    }
    let _ = writeln!(s, "  links            {}", links(p));
    let hi = p
        .high_res_feed_dpi
        .map_or(String::new(), |d| format!(", high-res feed {d} dpi"));
    let _ = writeln!(
        s,
        "  head             {} pins ({} bytes/line), {} dpi{hi}",
        p.head_pins, p.bytes_per_line, p.dpi
    );
    let _ = writeln!(
        s,
        "  page command     {}",
        match p.page_command {
            PageCommand::StartEnd => "start/end",
            PageCommand::StartNextEnd => "start/next/end",
        }
    );
    let _ = writeln!(
        s,
        "  compression      {}",
        match p.default_compression {
            ptouch::Compression::PackBits => "PackBits",
            ptouch::Compression::None => "none",
        }
    );
    let c = &p.caps;
    let _ = writeln!(
        s,
        "  cutter           auto cut {}, half cut {}, chain {}, cut marks {}",
        yes(c.auto_cut),
        yes(c.half_cut),
        maybe(c.chain),
        yes(c.cut_mark)
    );
    let _ = writeln!(
        s,
        "  features         hardware mirror {}, high-res {}, special tape {}, status push {}",
        yes(c.mirror),
        yes(c.high_resolution),
        yes(c.special_tape),
        yes(c.status_notify)
    );
    let len =
        |v: Option<u32>| v.map_or("unknown".to_owned(), |v| format!("{} mm", format_mm_x10(v)));
    let _ = writeln!(
        s,
        "  label length     min {} (incl. margins), max {}",
        len(p.min_length_mm_x10.map(u32::from)),
        len(p.max_length_mm_x10)
    );
    if let Some(ch) = p.rfcomm_channel_observed {
        let _ = writeln!(s, "  RFCOMM channel   {ch} (observed; SDP is tried first)");
    }
    for q in p.quirks {
        let _ = writeln!(s, "  note             {q}");
    }

    let _ = writeln!(
        s,
        "\n  {:<16} {:<16} {:>6} {:>4}  {:>4} {:>5} {:>5}  {:>9} {:>4}",
        "MEDIA", "KIND", "WIDTH", "BYTE", "LEFT", "PRINT", "RIGHT", "TAPE DOTS", "FEED"
    );
    for t in p.media {
        let _ = writeln!(
            s,
            "  {:<16} {:<16} {:>3} mm {:>4}  {:>4} {:>5} {:>5}  {:>9} {:>4}",
            t.id,
            kind_name(t.kind),
            format_mm_x10(u32::from(t.width_mm_x10)),
            t.media_width_byte,
            t.left_margin_pins,
            t.print_pins,
            t.right_margin_pins,
            t.tape_width_dots,
            t.default_feed_dots
        );
    }
    let _ = writeln!(
        s,
        "\n  LEFT/PRINT/RIGHT are head pins (pin 0 = LSB of the last byte, PROTOCOL.md §5.1);\n  \
         PRINT is the label height in dots for --text/--image. FEED is the default ESC i d margin."
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p710bt_details() {
        let p = find_model("PT-P710BT").unwrap();
        let s = model_details(p);
        for pins in ["24", "32", "50", "70", "112", "128"] {
            assert!(
                s.lines().any(
                    |l| l.starts_with("  tze128-") && l.split_whitespace().nth(6) == Some(pins)
                ),
                "{pins} missing in\n{s}"
            );
        }
        assert!(s.contains("series 0x30, model 0x76"));
        assert!(model_table().contains("PT-P710BT"));
    }
}
