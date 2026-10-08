//! Command-line definition (clap derive).
//!
//! # Contract (ARCHITECTURE.md §4.4, §8.5)
//! ```text
//! ptouch [connection] [--model <name>] [--timeout <s>] [-v…] <command>
//!   connection: --device <endpoint> | --port <path> | --bt <addr|name> | --tcp <host[:port]> | --usb
//!               (default: $PTOUCH_DEVICE, else the single discovered printer)
//!   status                                   print decoded status (exit 1 on printer error)
//!   print  (--text "…" [--font <file|family>] [--size px] [--align left|center|right]
//!           | --image file.png|.pbm|.pgm [--dither …] [--threshold n] [--invert] …)
//!          [--tape 24|3.5|<media id>] [--copies N] [--chain] [--no-cut] [--half-cut]
//!          [--mirror] [--margin dots] [--high-res] [--length mm] [--padding dots]
//!          [--dry-run [--out job.bin]] [--preview] [--preview-png file.png]
//!   test-label (orientation | ruler [--length mm]) [job options as for print]
//!   list   (alias: discover) [--inquiry <s>]  list candidate printers
//!   info   [<model>]                          model table / one model's media table (offline)
//!   decode <job.bin> [--out pages.pbm] [--preview]   offline decode via the virtual printer
//!   fonts  [<query>]                          list system fonts usable with --font
//! ```
//! `--device` takes the `ptouch_transport::Endpoint` syntax (`serial:/dev/cu.PT-P710BTxxxx`,
//! `bt:XX:XX:XX:XX:XX:XX`, `usb:`, `tcp:host`, `virtual:24`). `-v` logs every frame
//! (`>>`/`<<` hex), `-vv` also the session events.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Top-level arguments.
#[derive(Debug, Parser)]
#[command(
    name = "ptouch",
    version,
    about = "Brother P-touch label printer tool",
    long_about = "Brother P-touch label printer tool.\n\n\
        Connection: --device <endpoint>, --port <serial path>, --bt <address or name>, \
        --tcp <host>, --usb, or $PTOUCH_DEVICE; with none of them the single discovered \
        printer is used (see `ptouch list`)."
)]
pub struct Cli {
    /// Printer endpoint (`serial:/dev/cu.PT-P710BTxxxx`, `bt:XX:XX:XX:XX:XX:XX`, `usb:`,
    /// `tcp:host`, `virtual:24`); falls back to $PTOUCH_DEVICE.
    #[arg(short, long, global = true, value_name = "ENDPOINT")]
    pub device: Option<String>,
    /// Serial device node (e.g. /dev/cu.PT-P710BTxxxx, COM5, /dev/rfcomm0).
    #[arg(long, global = true, value_name = "PATH")]
    pub port: Option<String>,
    /// Bluetooth printer by address (XX:XX:XX:XX:XX:XX) or paired device name (PT-P710BTxxxx).
    #[arg(long, global = true, value_name = "ADDR|NAME")]
    pub bt: Option<String>,
    /// Network printer (raw TCP, default port 9100).
    #[arg(long, global = true, value_name = "HOST[:PORT]")]
    pub tcp: Option<String>,
    /// First Brother USB printer.
    #[arg(long, global = true)]
    pub usb: bool,
    /// Model override (e.g. PT-P710BT); normally detected from the status reply. Offline
    /// commands (--dry-run, --preview, decode) default to PT-P710BT.
    #[arg(long, global = true)]
    pub model: Option<String>,
    /// Status timeout in seconds per handshake attempt.
    #[arg(long, global = true, default_value_t = 5)]
    pub timeout: u64,
    /// Verbose: -v hex packet log, -vv also session events.
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,
    /// Subcommand.
    #[command(subcommand)]
    pub command: Command,
}

impl Cli {
    /// Number of explicit connection flags given (`--device`, `--port`, `--bt`, `--tcp`,
    /// `--usb`); more than one is a usage error.
    #[must_use]
    pub fn connection_flags(&self) -> usize {
        [
            self.device.is_some(),
            self.port.is_some(),
            self.bt.is_some(),
            self.tcp.is_some(),
            self.usb,
        ]
        .into_iter()
        .filter(|&b| b)
        .count()
    }

    /// `true` when the command will open a printer connection (and therefore needs the
    /// platform event loop, PROTOCOL.md §2.2 step 6). Offline commands run directly.
    #[must_use]
    pub fn needs_connection(&self) -> bool {
        match &self.command {
            Command::Status(_) | Command::List(_) => true,
            Command::Print(a) => !a.job.is_offline(),
            Command::TestLabel(a) => !a.job.is_offline(),
            Command::Info(_) | Command::Decode(_) | Command::Fonts(_) => false,
        }
    }
}

/// Subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Query and decode the printer status.
    Status(StatusArgs),
    /// Print text or an image.
    Print(PrintArgs),
    /// Print a built-in test label.
    TestLabel(TestLabelArgs),
    /// List candidate printers (serial, Bluetooth, USB).
    #[command(alias = "discover")]
    List(ListArgs),
    /// Show the model/media table (offline).
    Info(InfoArgs),
    /// Decode a job file with the virtual printer and write the pages as PBM.
    Decode(DecodeArgs),
    /// List system fonts usable with `print --font`.
    Fonts(FontsArgs),
}

/// Options shared by commands that produce a job.
#[derive(Debug, Args)]
pub struct JobArgs {
    /// Tape: width in mm (3.5, 6, 9, 12, 18, 24, 36) or a media id from `ptouch info <model>`
    /// (e.g. hs2-128-11.7). Default: the loaded tape (24 mm offline).
    #[arg(long, value_name = "MM|ID")]
    pub tape: Option<String>,
    /// Number of copies (pages of one job).
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u16).range(1..=999))]
    pub copies: u16,
    /// Start at this page of the job (to resume after an error, PROTOCOL.md §6.10).
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u16).range(1..))]
    pub from_page: Option<u16>,
    /// Chain printing: do not feed/cut after the last label.
    #[arg(long)]
    pub chain: bool,
    /// Do not cut between labels.
    #[arg(long, conflicts_with = "half_cut")]
    pub no_cut: bool,
    /// Half cut between labels, full cut at the end (half-cut models only).
    #[arg(long)]
    pub half_cut: bool,
    /// Special tape (fabric, stencil): no cut, special feed.
    #[arg(long)]
    pub special_tape: bool,
    /// Mirror (hardware where supported, else software).
    #[arg(long)]
    pub mirror: bool,
    /// High-resolution feed (doubles the dots along the label; laminated tape only).
    #[arg(long)]
    pub high_res: bool,
    /// Feed margin (ESC i d) in dots; default per tape (14 = 2 mm).
    #[arg(long, value_name = "DOTS")]
    pub margin: Option<u16>,
    /// Disable PackBits compression.
    #[arg(long)]
    pub no_compression: bool,
    /// Do not talk to a printer: encode the job, write the bytes to --out (or a hex dump to
    /// stdout), then decode them and print them through a simulated session on the virtual
    /// printer to check the result.
    #[arg(long)]
    pub dry_run: bool,
    /// Output file for --dry-run (raw job bytes).
    #[arg(long, requires = "dry_run", value_name = "FILE")]
    pub out: Option<PathBuf>,
    /// Do not print: show the label as ASCII art on stdout.
    #[arg(long)]
    pub preview: bool,
    /// Do not print: write the label as a PNG (4× scale, tape and ink colours).
    #[arg(long, value_name = "FILE")]
    pub preview_png: Option<PathBuf>,
}

impl JobArgs {
    /// `true` when no printer connection is needed (dry run or preview).
    #[must_use]
    pub fn is_offline(&self) -> bool {
        self.dry_run || self.preview || self.preview_png.is_some()
    }
}

/// Horizontal alignment of text lines (and of the content within a fixed `--length`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Default)]
pub enum Align {
    /// Flush to the start of the label.
    Left,
    /// Centred.
    #[default]
    Center,
    /// Flush to the end of the label.
    Right,
}

/// `print` arguments.
#[derive(Debug, Args)]
pub struct PrintArgs {
    /// Text to print; `\n` (a real newline or the two characters) separates lines; `-`
    /// reads stdin.
    #[arg(long, conflicts_with = "image", required_unless_present = "image")]
    pub text: Option<String>,
    /// Font for --text: a TrueType/OpenType file, a system font name (see `ptouch fonts`),
    /// or `builtin` (5×7 bitmap font, the default).
    #[arg(long, requires = "text", value_name = "FILE|NAME")]
    pub font: Option<String>,
    /// Font size in dots (default: fill the print height).
    #[arg(long, value_name = "DOTS")]
    pub size: Option<f32>,
    /// Alignment of text lines.
    #[arg(long, value_enum, default_value_t = Align::Center)]
    pub align: Align,
    /// Blank dots before and after the content along the label.
    #[arg(long, default_value_t = 0, value_name = "DOTS")]
    pub padding: u32,
    /// Fixed label length in mm (content aligned with --align); default: fit the content.
    #[arg(long, value_name = "MM")]
    pub length: Option<f32>,
    /// Image file (PNG, PBM, PGM); scaled to the print height unless --no-scale. Image
    /// width runs along the label.
    #[arg(long)]
    pub image: Option<PathBuf>,
    /// Keep the image at 1:1 dots.
    #[arg(long, requires = "image")]
    pub no_scale: bool,
    /// Bi-level conversion for --image.
    #[arg(long, value_enum, default_value_t = DitherArg::Threshold)]
    pub dither: DitherArg,
    /// Threshold level 0–255 for --dither threshold.
    #[arg(long, default_value_t = 128)]
    pub threshold: u8,
    /// Brightness −100…100 for --image.
    #[arg(long, default_value_t = 0, allow_hyphen_values = true,
          value_parser = clap::value_parser!(i8).range(-100..=100))]
    pub brightness: i8,
    /// Contrast −100…100 for --image.
    #[arg(long, default_value_t = 0, allow_hyphen_values = true,
          value_parser = clap::value_parser!(i8).range(-100..=100))]
    pub contrast: i8,
    /// Gamma for --image (1.0 = linear).
    #[arg(long, default_value_t = 1.0)]
    pub gamma: f32,
    /// Invert the image (white ink areas become black).
    #[arg(long)]
    pub invert: bool,
    /// Job options.
    #[command(flatten)]
    pub job: JobArgs,
}

/// Dither choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DitherArg {
    /// Fixed threshold.
    Threshold,
    /// Floyd–Steinberg.
    FloydSteinberg,
    /// Atkinson.
    Atkinson,
    /// Bayer 4×4.
    Bayer4,
    /// Bayer 8×8.
    Bayer8,
}

/// `test-label` arguments.
#[derive(Debug, Args)]
pub struct TestLabelArgs {
    /// Which pattern.
    #[arg(value_enum)]
    pub kind: TestLabelKind,
    /// Ruler length in mm.
    #[arg(long, default_value_t = 60, value_name = "MM",
          value_parser = clap::value_parser!(u16).range(5..=500))]
    pub length: u16,
    /// Job options.
    #[command(flatten)]
    pub job: JobArgs,
}

/// Test patterns (ARCHITECTURE.md §5.1, PROTOCOL.md §9.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TestLabelKind {
    /// §9.1 edge bars + arrow + "START" + asymmetric glyphs + pin-0 edge line: fixes
    /// orientation/mirroring.
    Orientation,
    /// mm ruler along the length + pin ruler across the tape: fixes scale and print area.
    Ruler,
}

/// `status` arguments.
#[derive(Debug, Args)]
pub struct StatusArgs {
    /// Keep polling every this many seconds and print changes (stop with Ctrl-C).
    #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u64).range(1..))]
    pub watch: Option<u64>,
}

/// `list` arguments.
#[derive(Debug, Args)]
pub struct ListArgs {
    /// Also run a Bluetooth inquiry for this many seconds.
    #[arg(long, value_name = "SECONDS")]
    pub inquiry: Option<u64>,
}

/// `info` arguments.
#[derive(Debug, Args)]
pub struct InfoArgs {
    /// Model name (e.g. PT-P710BT); omitted = list all models.
    pub model: Option<String>,
}

/// `decode` arguments.
#[derive(Debug, Args)]
pub struct DecodeArgs {
    /// Job file (as written by --dry-run --out).
    pub input: PathBuf,
    /// Output PBM; with several pages, `-1`, `-2`… are inserted before the extension.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Show the decoded pages as ASCII art.
    #[arg(long)]
    pub preview: bool,
}

/// `fonts` arguments.
#[derive(Debug, Args)]
pub struct FontsArgs {
    /// Only fonts whose name contains this text (case-insensitive).
    pub query: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn offline_detection() {
        let cli = Cli::parse_from(["ptouch", "print", "--text", "Hi", "--preview"]);
        assert!(!cli.needs_connection());
        let cli = Cli::parse_from(["ptouch", "print", "--text", "Hi"]);
        assert!(cli.needs_connection());
        let cli = Cli::parse_from(["ptouch", "info"]);
        assert!(!cli.needs_connection());
    }

    #[test]
    fn out_requires_dry_run() {
        let r = Cli::try_parse_from(["ptouch", "print", "--text", "x", "--out", "a.bin"]);
        assert!(r.is_err());
    }
}
