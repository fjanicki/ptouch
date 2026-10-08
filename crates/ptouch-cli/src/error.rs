//! CLI error type and user-facing remedies.

use std::fmt::Write as _;

use ptouch::{PrinterError, PrinterErrors};
use ptouch_transport::TransportError;

/// Everything a subcommand can fail with.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CliError {
    /// Protocol-core error.
    #[error(transparent)]
    Protocol(#[from] ptouch::Error),
    /// Transport error.
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// The printer reported one or more errors (cover open, no tape, …).
    #[error("printer error: {}", describe_errors(.0))]
    Printer(PrinterErrors),
    /// A job ended with an error; some pages may have printed.
    #[error("{}", describe_job_failure(.error, *.resume_from_page, *.pages))]
    JobFailed {
        /// Why.
        error: ptouch::Error,
        /// 1-based page to resend from (PROTOCOL.md §6.10), if known.
        resume_from_page: Option<u16>,
        /// Pages in the job.
        pages: u16,
    },
    /// The link failed while a job was printing; the page in flight may or may not have
    /// printed.
    #[error("{}", describe_link_loss(.source, *.resume_from_page, *.pages))]
    LinkLost {
        /// The transport failure.
        source: TransportError,
        /// 1-based page that was in flight (resend from here, PROTOCOL.md §2.1/§6.10).
        resume_from_page: Option<u16>,
        /// Pages in the job.
        pages: u16,
    },
    /// The user pressed Ctrl-C outside a print (the link was closed cleanly).
    #[error("interrupted")]
    Interrupted,
    /// The requested tape is not the one in the printer.
    #[error("tape mismatch: the printer has {loaded} loaded, but {requested} was requested")]
    TapeMismatch {
        /// Description of the loaded tape.
        loaded: String,
        /// Description of the requested tape.
        requested: String,
    },
    /// No printer found by auto-discovery.
    #[error("no printer found")]
    NoDevice,
    /// Several printers found by auto-discovery.
    #[error("several printers found; pick one with --device:\n{}", .0.join("\n"))]
    AmbiguousDevice(Vec<String>),
    /// The session made no progress within the driver's safety limit.
    #[error("the printer stopped responding during {0}")]
    Stalled(&'static str),
    /// File I/O.
    #[error("{path}: {source}")]
    File {
        /// Path involved.
        path: std::path::PathBuf,
        /// Underlying error.
        source: std::io::Error,
    },
    /// Image decoding.
    #[error("cannot decode image {path}: {reason}")]
    Image {
        /// Path involved.
        path: std::path::PathBuf,
        /// Why.
        reason: String,
    },
    /// Font loading / rendering.
    #[error("font error: {0}")]
    Font(String),
    /// Bad combination of arguments not caught by clap.
    #[error("{0}")]
    Usage(String),
}

impl CliError {
    /// Wraps an I/O error with the path it concerns.
    pub fn file(path: impl Into<std::path::PathBuf>, source: std::io::Error) -> Self {
        Self::File {
            path: path.into(),
            source,
        }
    }

    /// A one-line remedy for common failures (e.g. "power-cycle the printer", "close other
    /// programs using the port", "grant your terminal Bluetooth access"), if any.
    #[must_use]
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::Protocol(e) | Self::JobFailed { error: e, .. } => protocol_hint(e),
            Self::Transport(e) | Self::LinkLost { source: e, .. } => transport_hint(e),
            Self::Printer(errors) => errors.headline().map(printer_error_hint),
            Self::TapeMismatch { .. } => Some(
                "load the matching cassette, or omit --tape to use the loaded tape \
                 (check it with `ptouch status`)",
            ),
            Self::NoDevice => Some(
                "pair the printer in the system Bluetooth settings (or connect USB) and run \
                 `ptouch list`; or pass --port, --bt, --tcp or --device",
            ),
            Self::AmbiguousDevice(_) => {
                Some("set $PTOUCH_DEVICE to avoid passing --device every time")
            }
            Self::Stalled(_) => {
                Some("power-cycle the printer; make sure no other program holds the connection")
            }
            Self::Font(_) => {
                Some("run `ptouch fonts` to list usable fonts, or pass a .ttf/.otf file")
            }
            Self::Image { .. } => Some("convert the image to PNG (or PBM/PGM)"),
            Self::File { .. } | Self::Usage(_) | Self::Interrupted => None,
        }
    }
}

fn protocol_hint(e: &ptouch::Error) -> Option<&'static str> {
    use ptouch::{Error, TimeoutKind};
    match e {
        Error::Timeout(TimeoutKind::Handshake) => Some(
            "the printer did not answer: switch it on (or wake it with the power button), close \
             other programs using it (P-touch Editor, another ptouch), or power-cycle it",
        ),
        Error::Timeout(TimeoutKind::Status) => Some("power-cycle the printer and try again"),
        Error::Timeout(TimeoutKind::Page { .. }) => {
            Some("check the printer for a tape jam or an open cover; resume with --from-page")
        }
        Error::MediaMismatch { .. } => {
            Some("load the matching cassette, or omit --tape to render for the loaded tape")
        }
        Error::NoMedia => Some("insert a tape cassette and close the cover"),
        Error::NotReady => Some("wait until the printer is idle, then try again"),
        Error::Printer(errors) => errors.headline().map(printer_error_hint),
        Error::PrinterOff => Some("switch the printer on and try again"),
        Error::UnknownModel { .. } => Some(
            "the printer is not the model given with --model (omit --model to auto-detect), or \
             it is not supported yet",
        ),
        Error::Unsupported(_) => Some("see `ptouch info <model>` for what the model supports"),
        Error::TooLong { .. } => Some("shorten the text, use a smaller --size, or split the label"),
        Error::BitmapSize { .. } | Error::UnsupportedMedia { .. } => {
            Some("check --tape against `ptouch info <model>`")
        }
        _ => None,
    }
}

fn printer_error_hint(e: PrinterError) -> &'static str {
    match e {
        PrinterError::CoverOpen => "close the cassette cover and try again",
        PrinterError::NoMedia | PrinterError::WrongMedia => {
            "check that a supported cassette is inserted correctly"
        }
        PrinterError::EndOfMedia => "the tape ran out: insert a new cassette",
        PrinterError::CutterJam => "open the cover and clear the cutter jam",
        PrinterError::WeakBatteries => "charge the battery or connect the AC adapter",
        PrinterError::Overheating => "let the printer cool down for a few minutes",
        PrinterError::PrinterInUse => "another program is printing; wait or close it",
        _ => "power-cycle the printer; if the error persists, check the cassette",
    }
}

fn transport_hint(e: &TransportError) -> Option<&'static str> {
    match e {
        TransportError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => Some(
            "permission denied: on Linux add yourself to the dialout/lp group; on macOS grant \
             your terminal Bluetooth access (System Settings › Privacy & Security › Bluetooth)",
        ),
        TransportError::Io(_) | TransportError::Serial(_) => Some(
            "close other programs using the port (P-touch Editor, screen, another ptouch); \
             if the port is gone, re-pair the printer",
        ),
        TransportError::Bluetooth { .. } => Some(
            "make sure Bluetooth is on and your terminal may use it (macOS: System Settings › \
             Privacy & Security › Bluetooth); power-cycle the printer if it was connected \
             elsewhere",
        ),
        TransportError::NoWorkingChannel => Some(
            "power-cycle the printer, and make sure no other device or program is connected to it",
        ),
        TransportError::NotFound(_) => Some("run `ptouch list` to see the available printers"),
        TransportError::Usb { .. } => Some(
            "if the Editor Lite lamp is on, hold the Editor Lite button until it goes off; \
             close P-touch Editor; on Linux check the udev permissions",
        ),
        TransportError::Unsupported(_) => {
            Some("this connection type is not available here; try --port with the serial device")
        }
        TransportError::InvalidEndpoint { .. } => Some(
            "examples: serial:/dev/cu.PT-P710BTxxxx, bt:XX:XX:XX:XX:XX:XX, usb:, tcp:host, virtual:24",
        ),
        TransportError::Closed | TransportError::WriteTimeout => {
            Some("the link dropped: power-cycle the printer and reconnect")
        }
        TransportError::Protocol(p) => protocol_hint(p),
        _ => None,
    }
}

/// `"cover open, no media"` (every reported error, in precedence order).
fn describe_errors(errors: &PrinterErrors) -> String {
    let mut out = String::new();
    for (i, e) in errors.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(e.message());
    }
    if out.is_empty() {
        let _ = write!(
            out,
            "status type error (st[7] {:02X}, st[8] {:02X}, st[9] {:02X})",
            errors.extended, errors.info1, errors.info2
        );
    }
    out
}

fn describe_job_failure(error: &ptouch::Error, resume: Option<u16>, pages: u16) -> String {
    let what = match error {
        ptouch::Error::Printer(errs) => format!("printer error: {}", describe_errors(errs)),
        other => other.to_string(),
    };
    match resume {
        Some(1) | None => format!("print failed: {what}; nothing was printed completely"),
        Some(p) => format!(
            "print failed on page {p} of {pages}: {what}; pages 1–{} printed. Resume with \
             --from-page {p}",
            p - 1
        ),
    }
}

fn describe_link_loss(source: &TransportError, resume: Option<u16>, pages: u16) -> String {
    match resume {
        Some(p) if p > 1 => format!(
            "the link to the printer was lost during page {p} of {pages}: {source}; pages 1–{} \
             printed, page {p} may be incomplete. Resume with --from-page {p}",
            p - 1
        ),
        _ => format!(
            "the link to the printer was lost during page 1 of {pages}: {source}; page 1 may be \
             incomplete, nothing else was printed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_cover_common_failures() {
        let e = CliError::from(ptouch::Error::Timeout(ptouch::TimeoutKind::Handshake));
        assert!(e.hint().is_some_and(|h| h.contains("power-cycle")));
        let e = CliError::from(ptouch::Error::NoMedia);
        assert!(e.hint().is_some());
        let e = CliError::Transport(TransportError::NoWorkingChannel);
        assert!(e.hint().is_some());
        let e = CliError::Usage("x".into());
        assert!(e.hint().is_none());
    }

    #[test]
    fn job_failure_mentions_resume_page() {
        let s = describe_job_failure(&ptouch::Error::Cancelled, Some(3), 4);
        assert!(s.contains("--from-page 3"), "{s}");
        let s = describe_job_failure(&ptouch::Error::Cancelled, None, 4);
        assert!(s.contains("nothing was printed"), "{s}");
        let s = describe_link_loss(&TransportError::Closed, Some(2), 3);
        assert!(s.contains("--from-page 2"), "{s}");
    }
}
