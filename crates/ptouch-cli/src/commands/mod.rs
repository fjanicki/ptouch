//! Subcommand implementations. Each module exposes `run(&Cli, &Args) -> Result<(), CliError>`.
//!
//! Shared helpers here: endpoint resolution (`--device`/`--port`/`--bt`/`--tcp`/`--usb`,
//! `$PTOUCH_DEVICE`, single discovered device), model override parsing, tape selection,
//! `JobArgs` → `ptouch::JobOptions`, and the shared print / dry-run / preview tail.

mod decode;
mod discover;
mod fonts;
mod info;
mod print;
mod simulate;
mod status;
mod test_label;

use std::io::Write as _;
use std::path::{Path, PathBuf};

use ptouch::encode::CutMode;
use ptouch::{Bitmap, Compression, JobOptions, ModelProfile, SessionConfig, TapeKind, TapeSpec};
use ptouch_transport::discovery::DiscoverySource;
use ptouch_transport::{BtAddr, DiscoverOptions, Endpoint, OpenOptions, Transport};

use crate::cli::{Cli, Command, JobArgs};
use crate::driver::{Driver, Progress};
use crate::error::CliError;
use crate::render::preview;

/// Model assumed by offline commands when `--model` is not given.
pub(crate) const DEFAULT_MODEL: &str = "PT-P710BT";
/// Environment variable naming the default endpoint.
pub(crate) const DEVICE_ENV: &str = "PTOUCH_DEVICE";

/// Dispatches the parsed command line.
///
/// # Errors
/// Whatever the subcommand fails with.
pub fn run(cli: Cli) -> Result<(), CliError> {
    match &cli.command {
        Command::Status(args) => status::run(&cli, args),
        Command::Print(args) => print::run(&cli, args),
        Command::TestLabel(args) => test_label::run(&cli, args),
        Command::List(args) => discover::run(&cli, args),
        Command::Info(args) => info::run(&cli, args),
        Command::Decode(args) => decode::run(&cli, args),
        Command::Fonts(args) => fonts::run(&cli, args),
    }
}

/// Resolves the connection flags / `$PTOUCH_DEVICE` / the single discovered device to an
/// endpoint.
pub(crate) fn resolve_endpoint(cli: &Cli) -> Result<Endpoint, CliError> {
    let mut explicit = Vec::new();
    if let Some(path) = &cli.port {
        explicit.push(Endpoint::Serial { path: path.clone() });
    }
    if let Some(bt) = &cli.bt {
        explicit.push(resolve_bt(bt)?);
    }
    if let Some(tcp) = &cli.tcp {
        explicit.push(format!("tcp:{tcp}").parse::<Endpoint>()?);
    }
    if cli.usb {
        explicit.push(Endpoint::Usb {
            vendor_id: ptouch::model::USB_VENDOR_ID,
            product_id: None,
        });
    }
    if let Some(dev) = &cli.device {
        explicit.push(dev.parse::<Endpoint>()?);
    }
    match explicit.len() {
        0 => {}
        1 => return Ok(explicit.remove(0)),
        _ => {
            return Err(CliError::Usage(
                "use only one of --device, --port, --bt, --tcp and --usb".into(),
            ));
        }
    }
    if let Some(dev) = std::env::var(DEVICE_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(dev.trim().parse::<Endpoint>()?);
    }
    auto_endpoint()
}

/// `true` if `s` looks like a Bluetooth address (`XX:XX:XX:XX:XX:XX` or with `-`).
fn looks_like_bt_addr(s: &str) -> bool {
    let parts: Vec<&str> = s.split([':', '-']).collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `--bt` argument: an address, or the name of a paired device.
fn resolve_bt(arg: &str) -> Result<Endpoint, CliError> {
    if looks_like_bt_addr(arg) {
        let addr: BtAddr = arg.replace('-', ":").parse()?;
        return Ok(Endpoint::Bluetooth {
            addr,
            channel: None,
        });
    }
    let opts = DiscoverOptions {
        serial: false,
        bluetooth: true,
        usb: false,
        inquiry: None,
    };
    let found = ptouch_transport::discover(&opts)?;
    let mut matches: Vec<_> = found
        .into_iter()
        .filter(|d| matches!(d.endpoint, Endpoint::Bluetooth { .. }))
        .filter(|d| {
            d.label.eq_ignore_ascii_case(arg)
                || d.label
                    .to_ascii_lowercase()
                    .starts_with(&arg.to_ascii_lowercase())
        })
        .collect();
    match matches.len() {
        0 => Err(CliError::Usage(format!(
            "no paired Bluetooth device named {arg:?}; pair it first or pass its address"
        ))),
        1 => Ok(matches.remove(0).endpoint),
        _ => Err(CliError::AmbiguousDevice(
            matches
                .iter()
                .map(|d| format!("  {}  ({})", d.endpoint, d.label))
                .collect(),
        )),
    }
}

/// Key that identifies one physical printer across discovery sources
/// (`cu.PT-P710BTxxxx` and `PT-P710BTxxxx` are the same device).
fn device_key(label: &str) -> String {
    let base = label.rsplit('/').next().unwrap_or(label);
    let base = base
        .strip_prefix("cu.")
        .or_else(|| base.strip_prefix("tty."))
        .unwrap_or(base);
    let base = base
        .strip_suffix("-SerialPort")
        .or_else(|| base.strip_suffix("-Port"))
        .unwrap_or(base);
    base.to_ascii_lowercase()
}

/// Lower is preferred when one printer shows up through several sources.
fn source_rank(source: DiscoverySource) -> u8 {
    match source {
        DiscoverySource::Usb => 0,
        DiscoverySource::BluetoothPaired => 1,
        DiscoverySource::Serial => 2,
        _ => 3,
    }
}

fn auto_endpoint() -> Result<Endpoint, CliError> {
    let found = ptouch_transport::discover(&DiscoverOptions::default())?;
    let mut best: Vec<(String, u8, ptouch_transport::DiscoveredDevice)> = Vec::new();
    for d in found {
        let key = device_key(&d.label);
        let rank = source_rank(d.source);
        if let Some(slot) = best.iter_mut().find(|(k, _, _)| *k == key) {
            if rank < slot.1 {
                *slot = (key, rank, d);
            }
        } else {
            best.push((key, rank, d));
        }
    }
    match best.len() {
        0 => Err(CliError::NoDevice),
        1 => Ok(best.remove(0).2.endpoint),
        _ => Err(CliError::AmbiguousDevice(
            best.iter()
                .map(|(_, _, d)| format!("  {}  ({})", d.endpoint, d.label))
                .collect(),
        )),
    }
}

/// Looks up a model by name, accepting a missing `PT-` prefix.
pub(crate) fn find_model(name: &str) -> Option<&'static ModelProfile> {
    let name = name.trim();
    ptouch::model::profile_by_name(name).or_else(|| {
        let prefixed = format!("PT-{name}");
        ptouch::model::profile_by_name(&prefixed)
    })
}

fn unknown_model(name: &str) -> CliError {
    let names: Vec<&str> = ptouch::profiles().iter().map(|p| p.name).collect();
    CliError::Usage(format!(
        "unknown model {name:?}; known models: {}",
        names.join(", ")
    ))
}

/// `--model` → profile.
pub(crate) fn model_override(cli: &Cli) -> Result<Option<&'static ModelProfile>, CliError> {
    cli.model
        .as_deref()
        .map(|name| find_model(name).ok_or_else(|| unknown_model(name)))
        .transpose()
}

/// Profile for offline work: `--model`, else [`DEFAULT_MODEL`].
pub(crate) fn offline_profile(cli: &Cli) -> Result<&'static ModelProfile, CliError> {
    match model_override(cli)? {
        Some(p) => Ok(p),
        None => find_model(DEFAULT_MODEL).ok_or_else(|| unknown_model(DEFAULT_MODEL)),
    }
}

/// Human name of a tape kind.
pub(crate) fn kind_name(kind: TapeKind) -> &'static str {
    match kind {
        TapeKind::Tze => "TZe",
        TapeKind::Hs2 => "heat-shrink 2:1",
        TapeKind::Hs3 => "heat-shrink 3:1",
        TapeKind::Sl => "self-laminating",
        TapeKind::Fle => "FLe labels",
    }
}

/// `"12 mm TZe (tze128-12, 70 printable dots)"`.
pub(crate) fn describe_tape(tape: &TapeSpec) -> String {
    format!(
        "{} mm {} ({}, {} printable dots)",
        format_mm_x10(u32::from(tape.width_mm_x10)),
        kind_name(tape.kind),
        tape.id,
        tape.print_pins
    )
}

/// `35` → `"3.5"`, `240` → `"24"`.
pub(crate) fn format_mm_x10(v: u32) -> String {
    if v.is_multiple_of(10) {
        format!("{}", v / 10)
    } else {
        format!("{}.{}", v / 10, v % 10)
    }
}

/// How the user asked for a tape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TapeRequest {
    /// A width byte (`--tape 24`, `--tape 3.5` → 4): any media of that width.
    Width(u8),
    /// A specific media entry (`--tape hs2-128-11.7`).
    Exact(&'static TapeSpec),
}

/// Parses `--tape` for `profile`.
pub(crate) fn parse_tape(profile: &ModelProfile, spec: &str) -> Result<TapeRequest, CliError> {
    let s = spec.trim();
    if let Some(t) = profile.media.iter().find(|t| t.id.eq_ignore_ascii_case(s)) {
        return Ok(TapeRequest::Exact(t));
    }
    let num = s.strip_suffix("mm").unwrap_or(s).trim();
    let widths = || {
        let mut w: Vec<String> = profile
            .media
            .iter()
            .filter(|t| t.kind == TapeKind::Tze)
            .map(|t| format_mm_x10(u32::from(t.width_mm_x10)))
            .collect();
        w.dedup();
        w.join(", ")
    };
    let Ok(mm) = num.parse::<f64>() else {
        return Err(CliError::Usage(format!(
            "--tape {spec:?} is neither a width in mm nor a media id of {} (widths: {}; see \
             `ptouch info {}`)",
            profile.name,
            widths(),
            profile.name
        )));
    };
    let x10 = (mm * 10.0).round();
    let by_x10 = profile
        .media
        .iter()
        .find(|t| f64::from(t.width_mm_x10) == x10 && t.kind == TapeKind::Tze)
        .or_else(|| {
            profile
                .media
                .iter()
                .find(|t| f64::from(t.media_width_byte) == mm && t.kind == TapeKind::Tze)
        });
    by_x10
        .map(|t| TapeRequest::Width(t.media_width_byte))
        .ok_or_else(|| {
            CliError::Usage(format!(
                "{} has no {num} mm tape (widths: {})",
                profile.name,
                widths()
            ))
        })
}

/// Tape for offline work: the request, else 24 mm TZe, else the widest TZe.
pub(crate) fn offline_tape(
    profile: &'static ModelProfile,
    spec: Option<&str>,
) -> Result<&'static TapeSpec, CliError> {
    let tze = |byte: u8| ptouch::tape_spec(profile, byte, TapeKind::Tze);
    let tape = match spec.map(|s| parse_tape(profile, s)).transpose()? {
        Some(TapeRequest::Exact(t)) => Some(t),
        Some(TapeRequest::Width(b)) => tze(b),
        None => tze(24).or_else(|| {
            profile
                .media
                .iter()
                .copied()
                .filter(|t| t.kind == TapeKind::Tze)
                .max_by_key(|t| t.print_pins)
        }),
    };
    tape.ok_or_else(|| CliError::Usage(format!("{} has no usable tape", profile.name)))
}

/// Checks a `--tape` request against the loaded tape; returns the tape to render for.
pub(crate) fn check_loaded_tape(
    profile: &ModelProfile,
    loaded: &'static TapeSpec,
    spec: Option<&str>,
) -> Result<&'static TapeSpec, CliError> {
    let Some(spec) = spec else { return Ok(loaded) };
    let (ok, requested) = match parse_tape(profile, spec)? {
        TapeRequest::Exact(t) => (t.id == loaded.id, describe_tape(t)),
        TapeRequest::Width(b) => (
            b == loaded.media_width_byte,
            format!("{} mm tape", spec.trim().trim_end_matches("mm")),
        ),
    };
    if ok {
        Ok(loaded)
    } else {
        Err(CliError::TapeMismatch {
            loaded: describe_tape(loaded),
            requested,
        })
    }
}

/// Rejects a label length (in normal-resolution dots) above what `profile` can print on
/// `tape`, before anything that long is allocated (PROTOCOL.md §5.6).
pub(crate) fn check_label_length(
    profile: &ModelProfile,
    tape: &TapeSpec,
    dots: u64,
    what: &str,
) -> Result<(), CliError> {
    match profile.max_lines_for(tape, false) {
        Some(max) if dots > u64::from(max) => Err(CliError::Usage(format!(
            "{what} gives a label of {dots} dots; {} prints at most {max} dots ({} mm) on {}",
            profile.name,
            u64::from(max) * 254 / (u64::from(profile.dpi.max(1)) * 10),
            describe_tape(tape)
        ))),
        _ => Ok(()),
    }
}

/// `JobArgs` → `JobOptions` for `profile` (software mirror is handled by the caller).
pub(crate) fn job_options(args: &JobArgs, profile: &ModelProfile) -> JobOptions {
    JobOptions {
        cut: if args.half_cut {
            CutMode::HalfCut
        } else if args.no_cut {
            CutMode::None
        } else {
            CutMode::EveryLabel
        },
        mirror: args.mirror && profile.caps.mirror,
        chain: args.chain,
        special_tape: args.special_tape,
        high_resolution: args.high_res,
        feed_margin_dots: args.margin,
        compression: args.no_compression.then_some(Compression::None),
        ..JobOptions::default()
    }
}

/// Renders the pages for `tape` and applies high-res stretching, software mirror, copies and
/// `--from-page`.
pub(crate) fn prepare_pages(
    profile: &'static ModelProfile,
    tape: &'static TapeSpec,
    job: &JobArgs,
    pages_for: &dyn Fn(&'static ModelProfile, &'static TapeSpec) -> Result<Vec<Bitmap>, CliError>,
) -> Result<Vec<Bitmap>, CliError> {
    if job.high_res && profile.feed_dpi(true).is_none() {
        return Err(CliError::Usage(format!(
            "{} has no high-resolution mode",
            profile.name
        )));
    }
    // High-res line doubling and the software mirror are library logic shared by every UI.
    let requested = JobOptions {
        mirror: job.mirror,
        ..job_options(job, profile)
    };
    let (base, _) = ptouch::prepare_pages(profile, tape, &pages_for(profile, tape)?, &requested)?;
    let mut pages = Vec::with_capacity(base.len() * usize::from(job.copies));
    for _ in 0..job.copies {
        pages.extend(base.iter().cloned());
    }
    let total = pages.len();
    let skip = usize::from(job.from_page.unwrap_or(1)) - 1;
    if skip >= total {
        return Err(CliError::Usage(format!(
            "--from-page {} is past the end of the job ({total} pages)",
            skip + 1
        )));
    }
    Ok(pages.split_off(skip))
}

/// Opens the transport for the command line's endpoint and wraps it in a driver.
pub(crate) fn open_driver(cli: &Cli) -> Result<Driver<Box<dyn Transport>>, CliError> {
    let endpoint = resolve_endpoint(cli)?;
    let model = model_override(cli)?;
    let opts = OpenOptions {
        model_hint: model,
        ..OpenOptions::default()
    };
    if cli.verbose > 0 {
        eprintln!("Opening {}…", endpoint_kind(&endpoint));
    }
    let transport = ptouch_transport::open(&endpoint, &opts)?;
    if cli.verbose > 0 {
        eprintln!("Connected via {}", transport.info().label);
    }
    let cfg = SessionConfig {
        status_timeout_ms: cli.timeout.saturating_mul(1000).max(500),
        ..SessionConfig::default()
    };
    Ok(Driver::new(transport, model, cfg, cli.verbose))
}

/// Endpoint kind for messages (never prints a Bluetooth address).
fn endpoint_kind(e: &Endpoint) -> String {
    match e {
        Endpoint::Serial { path } => format!("serial port {path}"),
        Endpoint::Bluetooth { .. } => "Bluetooth RFCOMM".to_owned(),
        Endpoint::Usb { .. } => "USB".to_owned(),
        Endpoint::Tcp { host, port } => format!("TCP {host}:{port}"),
        Endpoint::Virtual { width_mm } => format!("virtual printer ({width_mm} mm)"),
        _ => "printer".to_owned(),
    }
}

/// Shared tail of `print` / `test-label`: preview and/or dry run offline, or connect +
/// preflight + print with progress output.
pub(crate) fn print_pages(
    cli: &Cli,
    job: &JobArgs,
    pages_for: &dyn Fn(&'static ModelProfile, &'static TapeSpec) -> Result<Vec<Bitmap>, CliError>,
) -> Result<(), CliError> {
    if job.is_offline() {
        return offline(cli, job, pages_for);
    }

    let mut driver = open_driver(cli)?;
    let status = driver.connect()?;
    let profile = driver
        .session()
        .profile()
        .ok_or(ptouch::Error::UnknownModel {
            series: status.series_code,
            model: status.model_code,
        })?;
    if status.is_error() {
        return Err(CliError::Printer(status.errors));
    }
    if !status.has_media() {
        return Err(ptouch::Error::NoMedia.into());
    }
    let loaded =
        ptouch::tape_for_status(profile, status.media_width_mm, status.media_type.to_byte())?;
    let tape = check_loaded_tape(profile, loaded, job.tape.as_deref())?;
    let pages = prepare_pages(profile, tape, job, pages_for)?;
    let refs: Vec<&Bitmap> = pages.iter().collect();
    let encoded = ptouch::encode_job(profile, tape, &refs, &job_options(job, profile))?;
    let of = encoded.page_count();
    eprintln!(
        "Printing {of} label(s) on {} with {}…",
        describe_tape(tape),
        profile.name
    );
    let first = job.from_page.unwrap_or(1) - 1;
    driver
        .print(encoded, &mut |p| report_progress(p, first))
        .map_err(|e| match e {
            CliError::JobFailed {
                error,
                resume_from_page,
                pages,
            } => CliError::JobFailed {
                error,
                resume_from_page: resume_from_page.map(|p| p + first),
                pages: pages + first,
            },
            CliError::LinkLost {
                source,
                resume_from_page,
                pages,
            } => CliError::LinkLost {
                source,
                resume_from_page: resume_from_page.map(|p| p + first),
                pages: pages + first,
            },
            other => other,
        })?;
    eprintln!("Done.");
    driver.close()
}

/// Progress lines on stderr; `offset` maps job pages back to `--from-page` numbering.
fn report_progress(p: Progress, offset: u16) {
    match p {
        Progress::Sent { page, of } => {
            eprintln!("  label {}/{}: sent", page + offset, of + offset);
        }
        Progress::Printing { page } => eprintln!("  label {}: printing…", page + offset),
        Progress::Done { page } => eprintln!("  label {}: done", page + offset),
        Progress::Notice(ptouch::Notification::CoolingStarted) => {
            eprintln!("  the print head is cooling down; printing resumes automatically…");
        }
        Progress::Notice(ptouch::Notification::CoolingFinished) => {
            eprintln!("  cooling finished");
        }
        Progress::Notice(n) => eprintln!("  printer notification: {n:?}"),
    }
}

fn offline(
    cli: &Cli,
    job: &JobArgs,
    pages_for: &dyn Fn(&'static ModelProfile, &'static TapeSpec) -> Result<Vec<Bitmap>, CliError>,
) -> Result<(), CliError> {
    let profile = offline_profile(cli)?;
    let tape = offline_tape(profile, job.tape.as_deref())?;
    let pages = prepare_pages(profile, tape, job, pages_for)?;
    let feed_dpi = profile.feed_dpi(job.high_res).unwrap_or(profile.dpi);
    let first = pages.first().map_or(0, Bitmap::length);
    eprintln!(
        "{} on {}: {} label(s), {} dots long ({:.1} mm of print data)",
        profile.name,
        describe_tape(tape),
        pages.len(),
        first,
        f64::from(first) * 25.4 / f64::from(feed_dpi.max(1)),
    );

    if job.preview {
        let mut out = std::io::stdout().lock();
        let mut shown: Vec<&Bitmap> = Vec::new();
        for (i, page) in pages.iter().enumerate() {
            if shown.contains(&page) {
                continue;
            }
            shown.push(page);
            if pages.len() > 1 {
                let _ = writeln!(out, "label {}:", i + 1);
            }
            let _ = write!(out, "{}", preview::ascii(page, preview::MAX_ASCII_COLUMNS));
        }
    }
    if let Some(path) = &job.preview_png {
        let style = preview::PngStyle {
            margin_dots: u32::from(job.margin.unwrap_or(tape.default_feed_dots)),
            edge_dots: u32::from(tape.tape_width_dots.saturating_sub(tape.print_pins) / 2),
            ..preview::PngStyle::default()
        };
        for (i, page) in pages.iter().enumerate() {
            let p = numbered_path(path, i, pages.len());
            preview::write_png(page, &p, &style)?;
            eprintln!("wrote {}", p.display());
        }
    }
    if job.dry_run {
        dry_run(profile, tape, job, &pages)?;
    }
    Ok(())
}

/// Encodes, writes (file or hex to stdout) and checks the job with the virtual printer.
fn dry_run(
    profile: &'static ModelProfile,
    tape: &'static TapeSpec,
    job: &JobArgs,
    pages: &[Bitmap],
) -> Result<(), CliError> {
    let report = dry_run_report(profile, tape, job, pages)?;
    let bytes = &report.bytes;
    match &job.out {
        Some(path) => {
            std::fs::write(path, bytes).map_err(|e| CliError::file(path, e))?;
            eprintln!("wrote {} bytes to {}", bytes.len(), path.display());
        }
        None => {
            let mut out = std::io::stdout().lock();
            for chunk in bytes.chunks(32) {
                let _ = writeln!(out, "{}", crate::driver::hex(chunk));
            }
        }
    }
    report.print_summary(pages);
    Ok(())
}

/// Everything a dry run learns about a job, without printing anything.
#[derive(Debug)]
pub(crate) struct DryRunReport {
    /// The encoded job, byte-exact.
    pub bytes: Vec<u8>,
    /// The byte stream decoded offline ([`ptouch::decode_job`]).
    pub decoded: Result<ptouch::virtual_printer::parser::DecodedJob, ptouch::Error>,
    /// The job printed by a [`ptouch::Session`] on a simulated [`ptouch::VirtualPrinter`].
    pub simulated: Result<simulate::SimReport, CliError>,
}

impl DryRunReport {
    /// `true` if the offline decode returned exactly `pages` (see [`same_prefix`]).
    pub(crate) fn decoded_matches(&self, pages: &[Bitmap]) -> bool {
        self.decoded
            .as_ref()
            .is_ok_and(|d| pages_match(&d.pages, pages))
    }

    /// `true` if the simulated print produced exactly `pages` (see [`same_prefix`]).
    pub(crate) fn simulated_matches(&self, pages: &[Bitmap]) -> bool {
        self.simulated
            .as_ref()
            .is_ok_and(|s| pages_match(&s.printed, pages))
    }

    /// Reports both checks on stderr (never fails the dry run).
    fn print_summary(&self, pages: &[Bitmap]) {
        let verdict = |same: bool| {
            if same {
                ", content matches"
            } else {
                ", CONTENT DIFFERS from the rendered label"
            }
        };
        match &self.decoded {
            Ok(decoded) => {
                eprintln!(
                    "virtual printer: {} command(s), {} label(s){}",
                    decoded.commands.len(),
                    decoded.pages.len(),
                    verdict(self.decoded_matches(pages))
                );
                for v in &decoded.violations {
                    eprintln!("virtual printer: violation: {v:?}");
                }
            }
            Err(e) => eprintln!("virtual printer: cannot decode the job: {e}"),
        }
        match &self.simulated {
            Ok(sim) => {
                eprintln!(
                    "simulated print (session + virtual printer): {} label(s) in {:.1} s{}",
                    sim.printed.len(),
                    sim.elapsed_ms as f64 / 1000.0,
                    verdict(self.simulated_matches(pages))
                );
                for v in &sim.violations {
                    eprintln!("simulated print: violation: {v:?}");
                }
            }
            Err(e) => eprintln!("simulated print FAILED: {e}"),
        }
    }
}

/// Encodes `pages`, decodes the bytes offline and prints them through a simulated session.
///
/// # Errors
/// Encoder errors (geometry, unsupported options). Decode and simulation failures are
/// recorded in the report instead.
pub(crate) fn dry_run_report(
    profile: &'static ModelProfile,
    tape: &'static TapeSpec,
    job: &JobArgs,
    pages: &[Bitmap],
) -> Result<DryRunReport, CliError> {
    let refs: Vec<&Bitmap> = pages.iter().collect();
    let encoded = ptouch::encode_job(profile, tape, &refs, &job_options(job, profile))?;
    let bytes = encoded.to_bytes();
    let decoded = ptouch::decode_job(profile, &bytes);
    let simulated = simulate::simulate_print(profile, tape, encoded);
    Ok(DryRunReport {
        bytes,
        decoded,
        simulated,
    })
}

/// Page-by-page [`same_prefix`].
fn pages_match(decoded: &[Bitmap], orig: &[Bitmap]) -> bool {
    decoded.len() == orig.len() && decoded.iter().zip(orig).all(|(d, p)| same_prefix(d, p))
}

/// `true` if `decoded` starts with `orig` (the encoder may pad short pages at the end) and
/// the rest is blank. Hardware mirror is not applied by the decoder, matching `orig`.
fn same_prefix(decoded: &Bitmap, orig: &Bitmap) -> bool {
    decoded.height() == orig.height()
        && decoded.length() >= orig.length()
        && (0..orig.length()).all(|x| decoded.line(x) == orig.line(x))
        && (orig.length()..decoded.length()).all(|x| decoded.line(x).iter().all(|&b| b == 0))
}

/// `out.pbm` → `out-2.pbm` for page index 1 of several.
pub(crate) fn numbered_path(path: &Path, index: usize, count: usize) -> PathBuf {
    if count <= 1 {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = match path.extension() {
        Some(ext) => format!("{stem}-{}.{}", index + 1, ext.to_string_lossy()),
        None => format!("{stem}-{}", index + 1),
    };
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p710() -> &'static ModelProfile {
        find_model("PT-P710BT").unwrap()
    }

    #[test]
    fn model_names() {
        assert_eq!(find_model("pt-p710bt").map(|p| p.name), Some("PT-P710BT"));
        assert_eq!(find_model("P710BT").map(|p| p.name), Some("PT-P710BT"));
        assert!(find_model("PT-NOPE").is_none());
    }

    #[test]
    fn tape_parsing() {
        let p = p710();
        assert_eq!(parse_tape(p, "24").unwrap(), TapeRequest::Width(24));
        assert_eq!(parse_tape(p, "24mm").unwrap(), TapeRequest::Width(24));
        assert_eq!(parse_tape(p, "3.5").unwrap(), TapeRequest::Width(4));
        assert_eq!(parse_tape(p, "4").unwrap(), TapeRequest::Width(4));
        assert!(matches!(
            parse_tape(p, "hs2-128-11.7").unwrap(),
            TapeRequest::Exact(t) if t.id == "hs2-128-11.7"
        ));
        assert!(parse_tape(p, "36").is_err());
        assert!(parse_tape(p, "wide").is_err());
        assert_eq!(offline_tape(p, None).unwrap().id, "tze128-24");
        assert_eq!(offline_tape(p, Some("12")).unwrap().print_pins, 70);
    }

    #[test]
    fn loaded_tape_check() {
        let p = p710();
        let t12 = ptouch::tape_spec(p, 12, TapeKind::Tze).unwrap();
        assert_eq!(check_loaded_tape(p, t12, None).unwrap().id, "tze128-12");
        assert_eq!(
            check_loaded_tape(p, t12, Some("12")).unwrap().id,
            "tze128-12"
        );
        let err = check_loaded_tape(p, t12, Some("24")).unwrap_err();
        assert!(matches!(err, CliError::TapeMismatch { .. }));
        assert!(err.to_string().contains("12 mm"), "{err}");
    }

    #[test]
    fn options_mapping() {
        use clap::Parser;
        let cli = Cli::parse_from([
            "ptouch",
            "print",
            "--text",
            "x",
            "--no-cut",
            "--chain",
            "--margin",
            "0",
            "--no-compression",
            "--mirror",
        ]);
        let Command::Print(a) = &cli.command else {
            panic!()
        };
        let o = job_options(&a.job, p710());
        assert_eq!(o.cut, CutMode::None);
        assert!(o.chain);
        assert_eq!(o.feed_margin_dots, Some(0));
        assert_eq!(o.compression, Some(Compression::None));
        assert_eq!(o.mirror, p710().caps.mirror);
    }

    #[test]
    fn copies_and_from_page() {
        use clap::Parser;
        let cli = Cli::parse_from([
            "ptouch",
            "print",
            "--text",
            "x",
            "--copies",
            "3",
            "--from-page",
            "2",
            "--preview",
        ]);
        let Command::Print(a) = &cli.command else {
            panic!()
        };
        let p = p710();
        let t = offline_tape(p, None).unwrap();
        let pages =
            prepare_pages(p, t, &a.job, &|_, t| Ok(vec![Bitmap::new(5, t.print_pins)])).unwrap();
        assert_eq!(pages.len(), 2);
    }

    #[test]
    fn endpoint_helpers() {
        assert!(!looks_like_bt_addr("XX:XX:XX:XX:XX:XX"));
        assert!(looks_like_bt_addr("00:11:22:aa:BB:cc"));
        assert!(looks_like_bt_addr("00-11-22-aa-BB-cc"));
        assert!(!looks_like_bt_addr("PT-P710BTxxxx"));
        assert_eq!(device_key("/dev/cu.PT-P710BTxxxx"), "pt-p710btxxxx");
        assert_eq!(device_key("PT-P710BTxxxx"), "pt-p710btxxxx");
        assert_eq!(device_key("cu.PT-P710BTxxxx-SerialPort"), "pt-p710btxxxx");
    }

    #[test]
    fn numbered_paths() {
        let p = Path::new("/tmp/out.pbm");
        assert_eq!(numbered_path(p, 0, 1), PathBuf::from("/tmp/out.pbm"));
        assert_eq!(numbered_path(p, 1, 3), PathBuf::from("/tmp/out-2.pbm"));
        assert_eq!(numbered_path(Path::new("x"), 0, 2), PathBuf::from("x-1"));
    }

    #[test]
    fn prefix_comparison() {
        let mut a = Bitmap::new(3, 8);
        a.set(1, 2, true);
        let mut b = Bitmap::new(5, 8);
        b.set(1, 2, true);
        assert!(same_prefix(&b, &a));
        b.set(4, 0, true);
        assert!(!same_prefix(&b, &a));
    }
}
