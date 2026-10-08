//! `ptouch status`. Connects, prints the decoded status (model, media, colours, errors,
//! phase, battery) and the raw hex; exits 1 when the printer reports an error.

use std::fmt::Write as _;
use std::io::Write as _;
use std::time::Duration;

use ptouch::model::BatteryFormat;
use ptouch::status::{Battery, PowerSource};
use ptouch::{MediaType, ModelProfile, Notification, Phase, Status, StatusType};

use super::{describe_tape, open_driver};
use crate::cli::{Cli, StatusArgs};
use crate::error::CliError;

/// Runs the subcommand.
///
/// # Errors
/// Connection errors; [`CliError::Printer`] when the (last) status reports an error.
pub fn run(cli: &Cli, args: &StatusArgs) -> Result<(), CliError> {
    let mut driver = open_driver(cli)?;
    let result = driver.connect();
    let profile = driver.session().profile();
    let mut status = match (&result, driver.session().last_status()) {
        (Ok(st), _) => st.clone(),
        // The handshake may fail on an error status; still show what the printer said.
        (Err(_), Some(st)) => st.clone(),
        (Err(_), None) => {
            let _ = driver.close();
            return result.map(|_| ());
        }
    };
    let _ = write!(
        std::io::stdout().lock(),
        "{}",
        format_status(&status, profile)
    );
    if let (Ok(_), Some(secs)) = (&result, args.watch) {
        // Poll until the link fails or the user interrupts; print only changes.
        loop {
            // Sleep in slices so Ctrl-C ends the watch promptly (and the link closes cleanly).
            let wake = std::time::Instant::now().checked_add(Duration::from_secs(secs));
            while wake.is_none_or(|w| std::time::Instant::now() < w) {
                if crate::interrupt::requested() {
                    let _ = driver.close();
                    return Err(CliError::Interrupted);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let next = driver.status()?;
            if next.raw != status.raw {
                let _ = writeln!(std::io::stdout().lock());
                let _ = write!(
                    std::io::stdout().lock(),
                    "{}",
                    format_status(&next, profile)
                );
                status = next;
            }
        }
    }
    driver.close()?;
    result?;
    if status.is_error() {
        return Err(CliError::Printer(status.errors));
    }
    Ok(())
}

fn media_type_name(m: MediaType) -> String {
    match m {
        MediaType::None => "no tape".into(),
        MediaType::Laminated => "laminated".into(),
        MediaType::NonLaminated => "non-laminated".into(),
        MediaType::Fabric => "fabric".into(),
        MediaType::HeatShrink21 => "heat-shrink tube 2:1".into(),
        MediaType::Tube => "tube".into(),
        MediaType::Fle => "FLe die-cut labels".into(),
        MediaType::FlexibleId => "flexible ID".into(),
        MediaType::Satin => "satin".into(),
        MediaType::SelfLaminating => "self-laminating".into(),
        MediaType::HeatShrink31 => "heat-shrink tube 3:1".into(),
        MediaType::Incompatible => "incompatible cassette".into(),
        other => format!("unknown (0x{:02X})", other.to_byte()),
    }
}

fn phase_name(p: Phase) -> String {
    match p {
        Phase::Receiving(0) => "ready".into(),
        Phase::Receiving(1) => "feeding".into(),
        Phase::Receiving(n) => format!("receiving (0x{n:04X})"),
        Phase::Printing(0x0014) => "cover open while receiving".into(),
        Phase::Printing(n) => format!("printing (0x{n:04X})"),
        other => format!("{other:?}"),
    }
}

fn status_type_name(t: StatusType) -> String {
    match t {
        StatusType::Reply => "reply".into(),
        StatusType::PrintingCompleted => "printing completed".into(),
        StatusType::Error => "error".into(),
        StatusType::ExitIfMode => "exit IF mode".into(),
        StatusType::TurnedOff => "turned off".into(),
        StatusType::Notification => "notification".into(),
        StatusType::PhaseChange => "phase change".into(),
        other => format!("0x{:02X}", other.to_byte()),
    }
}

fn battery_text(b: Battery) -> String {
    let src = |s: PowerSource| match s {
        PowerSource::Battery => "on battery",
        PowerSource::Ac => "on AC adapter",
    };
    match b {
        Battery::Unknown => "not reported".into(),
        Battery::Level {
            source,
            percent: Some(p),
        } => format!("{p} % ({})", src(source)),
        Battery::Level {
            source,
            percent: None,
        } => src(source).into(),
        Battery::NoBattery { source } => format!("no battery ({})", src(source)),
    }
}

/// Multi-line human-readable status (also used by tests).
#[must_use]
pub fn format_status(st: &Status, profile: Option<&ModelProfile>) -> String {
    let mut s = String::new();
    let model = profile.map_or("unknown model", |p| p.name);
    let _ = writeln!(
        s,
        "Printer       {model} (series 0x{:02X}, model 0x{:02X})",
        st.series_code, st.model_code
    );
    let tape = profile
        .and_then(|p| ptouch::tape_for_status(p, st.media_width_mm, st.media_type.to_byte()).ok());
    match (st.has_media(), tape) {
        (true, Some(t)) => {
            let _ = writeln!(
                s,
                "Tape          {} — {}",
                media_type_name(st.media_type),
                describe_tape(t)
            );
        }
        (true, None) => {
            let _ = writeln!(
                s,
                "Tape          {} mm {} (not in the media table)",
                st.media_width_mm,
                media_type_name(st.media_type)
            );
        }
        (false, _) => {
            let _ = writeln!(s, "Tape          {}", media_type_name(st.media_type));
        }
    }
    if st.has_media() {
        let _ = writeln!(
            s,
            "Colours       {} text on {} tape",
            st.text_color.name(),
            st.tape_color.name()
        );
    }
    let state = if st.is_error() {
        "ERROR".to_owned()
    } else if st.is_ready() {
        "ready".to_owned()
    } else {
        phase_name(st.phase)
    };
    let _ = writeln!(
        s,
        "State         {state} (status type {}, phase {})",
        status_type_name(st.status_type),
        phase_name(st.phase)
    );
    if st.errors.is_empty() {
        let _ = writeln!(s, "Errors        none");
    } else {
        let list: Vec<&str> = st.errors.iter().map(|e| e.message()).collect();
        let _ = writeln!(s, "Errors        {}", list.join(", "));
    }
    if st.notification != Notification::None {
        let _ = writeln!(s, "Notification  {:?}", st.notification);
    }
    let format: Option<BatteryFormat> = profile.and_then(|p| p.battery_format);
    let mut battery = battery_text(st.battery(format));
    if st.weak_battery() {
        battery.push_str(" — WEAK");
    }
    let _ = writeln!(s, "Battery       {battery}");
    let _ = writeln!(s, "Raw           {}", crate::driver::hex(&st.raw));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];

    #[test]
    fn formats_the_real_fixture() {
        let st = ptouch::parse_status(&FIXTURE).unwrap();
        let p = ptouch::profile_by_codes(0x30, 0x76);
        let s = format_status(&st, p);
        assert!(s.contains("PT-P710BT"), "{s}");
        assert!(s.contains("24 mm TZe"), "{s}");
        assert!(s.contains("black text on white tape"), "{s}");
        assert!(s.contains("State         ready"), "{s}");
        assert!(s.contains("Errors        none"), "{s}");
        assert!(s.contains("80 20 42 30 76"), "{s}");
    }
}
