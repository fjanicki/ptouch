//! `ptouch settings get|set|list`: printer-stored settings (Auto Power Off, Auto Power On).
//!
//! PROTOCOL.md §3.6, docs/SETTINGS-PLAN.md §2. All bytes and the transaction sequence come
//! from the core (`ptouch::settings`, `Session::read_settings` / `write_settings`); this module
//! only parses arguments, asks for confirmation and prints.
//!
//! - `get` reads (no confirmation needed).
//! - `set` connects, reads the current value, asks for confirmation (`--yes` skips it; without
//!   a terminal on stdin and without `--yes` it refuses before connecting), writes, and reads
//!   the value back. An unchanged value sends no write unless `--force` is given.
//! - `set --dry-run` prints the exact buffers of the change, produced by the real session
//!   against the virtual printer, without connecting.
//! - `list` shows the settings and allowed values of `--model` offline.

use std::io::{BufRead as _, IsTerminal as _, Write as _};

use ptouch::settings::{LabelSource, SettingSpec};
use ptouch::virtual_printer::{Behaviour, VirtualPrinter};
use ptouch::{
    Event, Model, ModelProfile, Session, SessionConfig, SettingId, SettingReading, SettingReport,
    SettingValue, setting_spec, settings_for,
};
use ptouch_transport::{Transport, TransportKind};

use super::{offline_profile, offline_tape, open_driver};
use crate::cli::{Cli, SettingsAction, SettingsArgs, SettingsGetArgs, SettingsSetArgs};
use crate::driver::{Driver, hex};
use crate::error::CliError;

/// Models whose settings support has been verified on real hardware (PROTOCOL.md §9.1 items
/// 12–14). Empty: every `set` warns.
const HARDWARE_VERIFIED: &[Model] = &[];

/// Column widths of the `get` table.
const ID_WIDTH: usize = 24;
const VALUE_WIDTH: usize = 8;

/// Runs the subcommand.
///
/// # Errors
/// Connection and printer errors; [`CliError::Refused`] / [`CliError::SettingsUnsupported`]
/// (exit 2) for requests refused before anything is written.
pub fn run(cli: &Cli, args: &SettingsArgs) -> Result<(), CliError> {
    match &args.action {
        SettingsAction::Get(a) => get(cli, a),
        SettingsAction::Set(a) => set(cli, a),
        SettingsAction::List => list(cli),
    }
}

fn setting_names() -> String {
    SettingId::ALL
        .iter()
        .map(|id| id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn parse_id(s: &str) -> Result<SettingId, CliError> {
    SettingId::parse(s.trim()).ok_or_else(|| {
        CliError::Refused(format!(
            "unknown setting {s:?}; settings: {}",
            setting_names()
        ))
    })
}

/// `get` arguments → ids (empty or `all` = every id), without duplicates.
fn parse_ids(args: &[String]) -> Result<Vec<SettingId>, CliError> {
    if args.is_empty() || args.iter().any(|a| a.trim() == "all") {
        return Ok(SettingId::ALL.to_vec());
    }
    let mut ids = Vec::new();
    for a in args {
        let id = parse_id(a)?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// The spec of `id` on `profile`, or the matching refusal.
fn spec_for(profile: &ModelProfile, id: SettingId) -> Result<&'static SettingSpec, CliError> {
    if settings_for(profile).is_empty() {
        return Err(CliError::SettingsUnsupported(profile.name.to_owned()));
    }
    setting_spec(profile, id)
        .ok_or_else(|| CliError::Refused(format!("{} has no {id} setting", profile.name)))
}

/// `value` must be in the model's list.
fn check_offered(
    profile: &ModelProfile,
    spec: &SettingSpec,
    value: SettingValue,
) -> Result<(), CliError> {
    if spec.byte_for(value).is_some() {
        return Ok(());
    }
    Err(CliError::Refused(format!(
        "{} is not offered for {} on {}; allowed for {}: {}",
        spec.display_value(value),
        spec.id,
        profile.name,
        profile.name,
        spec.allowed_values_text()
    )))
}

/// Brother's name for the setting. A name from the printer's information report (PT-P710BT
/// timers, whose Setting Tool labels are reversed; PROTOCOL.md §8 #34) does not say which
/// power source the timer is for in plain words, so that is spelled out.
fn label(spec: &SettingSpec) -> String {
    match spec.label_source {
        LabelSource::InfoReport => {
            let power = match spec.id {
                SettingId::AutoPowerOffBattery => "battery",
                SettingId::AutoPowerOff => "USB/AC power",
                _ => "",
            };
            let sep = if power.is_empty() { "" } else { "; " };
            format!("{power}{sep}information report: \"{}\"", spec.brother_label)
        }
        _ => spec.brother_label.to_owned(),
    }
}

/// A failed write: the printer may already hold the new value, whatever ended the write
/// (an error reply, a lost link, Ctrl-C). Keeps the original exit code.
fn write_failure(e: CliError) -> CliError {
    match e {
        CliError::Protocol(p) => CliError::SettingsWriteFailed(p),
        other => CliError::SettingsWriteInterrupted(Box::new(other)),
    }
}

fn model_of<T: Transport>(driver: &Driver<T>) -> Result<&'static ModelProfile, CliError> {
    driver
        .session()
        .profile()
        .ok_or(CliError::Protocol(ptouch::Error::NotReady))
}

// ----- get -----

fn get(cli: &Cli, args: &SettingsGetArgs) -> Result<(), CliError> {
    let ids = parse_ids(&args.settings)?;
    let mut driver = open_driver(cli)?;
    let result = read_on(&mut driver, &ids);
    let closed = driver.close();
    let (profile, report) = result?;
    closed?;
    let mut out = std::io::stdout().lock();
    for r in &report {
        let Some(spec) = setting_spec(profile, r.id) else {
            continue;
        };
        let _ = writeln!(
            out,
            "{:<ID_WIDTH$} {:<VALUE_WIDTH$} ({})",
            r.id.as_str(),
            spec.display_reading(r.reading),
            label(spec)
        );
        if cli.verbose > 0 {
            let _ = writeln!(out, "    << {}", hex(&r.raw));
        }
    }
    Ok(())
}

fn read_on<T: Transport>(
    driver: &mut Driver<T>,
    ids: &[SettingId],
) -> Result<(&'static ModelProfile, Vec<SettingReport>), CliError> {
    driver.connect()?;
    let profile = model_of(driver)?;
    for id in ids {
        spec_for(profile, *id)?;
    }
    let report = driver.read_settings(ids)?;
    Ok((profile, report))
}

// ----- set -----

fn set(cli: &Cli, args: &SettingsSetArgs) -> Result<(), CliError> {
    let id = parse_id(&args.setting)?;
    let value = SettingValue::parse(id.kind(), &args.value).ok_or_else(|| {
        CliError::Refused(format!(
            "{:?} is not a value for {id}; use {}",
            args.value,
            match id.kind() {
                ptouch::settings::SettingKind::Toggle => "on or off",
                _ => "never, a number of minutes (10, 10min) or hours (2h)",
            }
        ))
    })?;
    if args.dry_run {
        return dry_run(cli, id, value);
    }
    if !args.yes && !std::io::stdin().is_terminal() {
        return Err(CliError::Refused(
            "refusing to change a printer setting without --yes (stdin is not a terminal)".into(),
        ));
    }
    let mut driver = open_driver(cli)?;
    let result = set_on(cli, &mut driver, id, value, args);
    let closed = driver.close();
    result?;
    closed?;
    Ok(())
}

fn set_on<T: Transport>(
    cli: &Cli,
    driver: &mut Driver<T>,
    id: SettingId,
    value: SettingValue,
    args: &SettingsSetArgs,
) -> Result<(), CliError> {
    driver.connect()?;
    let profile = model_of(driver)?;
    let spec = spec_for(profile, id)?;
    check_offered(profile, spec, value)?;
    let link_note = match driver.transport_kind() {
        TransportKind::Rfcomm => Some("Bluetooth path untested"),
        TransportKind::Serial => Some("serial / Bluetooth SPP path untested"),
        _ => None,
    };
    let verified_model = HARDWARE_VERIFIED.contains(&profile.model);
    match (verified_model, link_note) {
        (false, note) => eprintln!(
            "warning: settings support on {} is untested on hardware{}",
            profile.name,
            note.map(|n| format!(" ({n})")).unwrap_or_default()
        ),
        (true, Some(note)) => eprintln!("warning: {note}"),
        (true, None) => {}
    }

    let current = driver.read_settings(&[id])?;
    let reading = current
        .first()
        .map(|r| r.reading)
        .ok_or(CliError::Protocol(ptouch::Error::Protocol(
            "empty settings report",
        )))?;
    let wanted = spec.display_value(value);
    let current_text = spec.display_reading(reading);
    println!("current: {current_text}");
    if reading == SettingReading::Value(value) && !args.force {
        println!("already {wanted}");
        return Ok(());
    }
    if !args.yes {
        confirm(&format!(
            "Change {id} on {} from {current_text} to {wanted}? [y/N] ",
            profile.name
        ))?;
    }
    let (report, verified) = driver
        .write_settings(&[(id, value)])
        .map_err(write_failure)?;
    if cli.verbose > 0 {
        for r in &report {
            eprintln!("    << {}", hex(&r.raw));
        }
    }
    if verified {
        println!("{id} = {wanted} (verified)");
        return Ok(());
    }
    let got = report
        .first()
        .map_or_else(|| "nothing".to_owned(), |r| spec.display_reading(r.reading));
    Err(CliError::SettingNotVerified { wanted, got })
}

/// Asks on the terminal; anything but `y`/`yes` declines.
fn confirm(question: &str) -> Result<(), CliError> {
    eprint!("{question}");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| CliError::file("<stdin>", e))?;
    if crate::interrupt::requested() {
        return Err(CliError::Interrupted);
    }
    match line.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok(()),
        _ => Err(CliError::Refused("not changed".into())),
    }
}

// ----- set --dry-run -----

fn dry_run(cli: &Cli, id: SettingId, value: SettingValue) -> Result<(), CliError> {
    let profile = offline_profile(cli)?;
    let spec = spec_for(profile, id)?;
    check_offered(profile, spec, value)?;
    let (buffers, verified) = simulate_write(profile, id, value)?;
    eprintln!(
        "dry run: {} {id} = {}: after reading the current value, a change sends these \
         buffers (one write each; the second half is the read-back){}",
        profile.name,
        spec.display_value(value),
        if verified {
            ""
        } else {
            " — the virtual printer did not verify it"
        }
    );
    let mut out = std::io::stdout().lock();
    for b in &buffers {
        let _ = writeln!(out, "{}", hex(b));
    }
    Ok(())
}

/// Runs `write_settings` through the real session against the virtual printer on a simulated
/// clock; returns every buffer of the write transaction (read-back included).
fn simulate_write(
    profile: &'static ModelProfile,
    id: SettingId,
    value: SettingValue,
) -> Result<(Vec<Vec<u8>>, bool), CliError> {
    let tape = offline_tape(profile, None)?;
    let mut printer = VirtualPrinter::new(profile, tape, Behaviour::Normal);
    let mut session = Session::new(Some(profile), SessionConfig::default());
    let mut now = 0u64;
    let mut sent = Vec::new();
    let mut writing = false;
    session.connect(now);
    for _ in 0..10_000 {
        while let Some(buf) = session.poll_transmit() {
            printer.handle_input(&buf, now);
            if writing {
                sent.push(buf);
            }
        }
        let mut started = false;
        while let Some(ev) = session.poll_event() {
            match ev {
                Event::Ready(_) if !writing => {
                    session.write_settings(&[(id, value)], now)?;
                    writing = true;
                    started = true;
                }
                Event::SettingsWritten { verified, .. } => {
                    sent.extend(std::iter::from_fn(|| session.poll_transmit()));
                    return Ok((sent, verified));
                }
                Event::Failed { error, .. } => return Err(error.into()),
                _ => {}
            }
        }
        if started {
            continue;
        }
        let next = [printer.next_output_at(), session.poll_timeout()]
            .into_iter()
            .flatten()
            .min();
        let Some(next) = next else {
            break;
        };
        now = now.max(next);
        while let Some(reply) = printer.poll_output(now) {
            session.handle_input(&reply, now);
        }
        if session.poll_timeout().is_some_and(|due| due <= now) {
            session.handle_timeout(now);
        }
    }
    Err(CliError::Stalled("the simulated settings change"))
}

// ----- list -----

fn list(cli: &Cli) -> Result<(), CliError> {
    let profile = offline_profile(cli)?;
    let specs = settings_for(profile);
    if specs.is_empty() {
        return Err(CliError::SettingsUnsupported(profile.name.to_owned()));
    }
    let mut out = std::io::stdout().lock();
    let _ = writeln!(
        out,
        "{} settings{}:",
        profile.name,
        if HARDWARE_VERIFIED.contains(&profile.model) {
            ""
        } else {
            " (untested on hardware)"
        }
    );
    for spec in specs {
        let _ = writeln!(
            out,
            "  {:<ID_WIDTH$} {}  ({})",
            spec.id.as_str(),
            spec.allowed_values_text(),
            label(spec)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p710() -> &'static ModelProfile {
        ptouch::profile(Model::PtP710bt).unwrap_or_else(|| unreachable!())
    }

    #[test]
    fn ids() {
        assert_eq!(parse_ids(&[]).ok(), Some(SettingId::ALL.to_vec()));
        assert_eq!(
            parse_ids(&["auto-power-off".into(), "all".into()]).ok(),
            Some(SettingId::ALL.to_vec())
        );
        assert_eq!(
            parse_ids(&[
                "auto-power-off-li-ion".into(),
                "auto-power-off-battery".into()
            ])
            .ok(),
            Some(vec![SettingId::AutoPowerOffBattery])
        );
        assert!(matches!(
            parse_ids(&["sleep".into()]),
            Err(CliError::Refused(m)) if m.contains("auto-power-on")
        ));
    }

    #[test]
    fn dry_run_buffers_come_from_the_session() {
        let (bufs, verified) =
            simulate_write(p710(), SettingId::AutoPowerOff, SettingValue::Minutes(10))
                .unwrap_or_else(|e| panic!("{e}"));
        assert!(verified);
        let hexes: Vec<String> = bufs.iter().map(|b| hex(b)).collect();
        // PT-P710BT USB/AC timer = selector 00 (PROTOCOL.md §8 #34).
        assert_eq!(
            hexes,
            [
                "1B 40 1B 69 61 01",
                "1B 69 55 41 00 00 01",
                "1B 7E 53 1B 69 61 FF",
                "1B 40 1B 69 61 01",
                "1B 69 55 41 01 00",
                "1B 69 61 FF",
            ]
        );
        let (bufs, _) = simulate_write(
            p710(),
            SettingId::AutoPowerOffBattery,
            SettingValue::Minutes(60),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let hexes: Vec<String> = bufs.iter().map(|b| hex(b)).collect();
        assert_eq!(hexes[1], "1B 69 55 41 00 01 06");
        assert_eq!(hexes[4], "1B 69 55 41 01 01");
    }

    #[test]
    fn refusals() {
        let spec = setting_spec(p710(), SettingId::AutoPowerOff).unwrap_or_else(|| unreachable!());
        let e = check_offered(p710(), spec, SettingValue::Minutes(120));
        assert!(
            matches!(&e, Err(CliError::Refused(m)) if m.ends_with("allowed for PT-P710BT: never, 10, 20, 30, 40, 50, 60 min")),
            "{e:?}"
        );
        let e560 = ptouch::profile(Model::PtE560bt).unwrap_or_else(|| unreachable!());
        assert!(matches!(
            spec_for(e560, SettingId::AutoPowerOn),
            Err(CliError::SettingsUnsupported(m)) if m == "PT-E560BT"
        ));
        // Never Brother's Mac tool label on the P710BT timers: it is reversed there.
        assert_eq!(
            label(spec),
            "USB/AC power; information report: \"AutoPowerOff(adp)\""
        );
        let bat =
            setting_spec(p710(), SettingId::AutoPowerOffBattery).unwrap_or_else(|| unreachable!());
        assert_eq!(
            label(bat),
            "battery; information report: \"AutoPowerOff(Bat)\""
        );
        let on = setting_spec(p710(), SettingId::AutoPowerOn).unwrap_or_else(|| unreachable!());
        assert_eq!(label(on), "Auto Power On");
        let p900 = ptouch::profile(Model::PtP900w).unwrap_or_else(|| unreachable!());
        let ac = setting_spec(p900, SettingId::AutoPowerOff).unwrap_or_else(|| unreachable!());
        assert_eq!(label(ac), "Auto Power Off (AC/DC)");
    }

    /// Regression: a write ended by Ctrl-C or a link failure still warns that the printer may
    /// have stored the value, and keeps its exit code.
    #[test]
    fn interrupted_write_warns() {
        let e = write_failure(CliError::Interrupted);
        assert_eq!(e.exit_code(), crate::interrupt::EXIT_CODE);
        let text = e.to_string();
        assert!(text.starts_with("interrupted;"), "{text}");
        assert!(text.contains("may have stored the new value"), "{text}");

        let e = write_failure(CliError::Transport(
            ptouch_transport::TransportError::Closed,
        ));
        assert_eq!(e.exit_code(), 1);
        assert!(e.to_string().contains("may have stored the new value"));

        let e = write_failure(CliError::Protocol(ptouch::Error::Timeout(
            ptouch::TimeoutKind::SettingsReply,
        )));
        assert!(matches!(e, CliError::SettingsWriteFailed(_)));
        assert!(e.to_string().contains("may have stored the new value"));
    }
}
