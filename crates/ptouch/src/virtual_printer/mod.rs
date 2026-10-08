//! Device-side test double (WP5, feature `virtual`).
//!
//! # Contract
//! - [`VirtualPrinter`] consumes the exact bytes a host sends (any chunking) and produces the
//!   32-byte status frames a real PT printer would, following PROTOCOL.md §6.8 "per-model
//!   observed push behaviour" (P710BT: after `1A`/`0C` → `06`/phase printing, `01` printing
//!   completed, `06`/phase receiving). Progress is pushed when `ESC i ! 00` was received, and
//!   without it on the models §6.8 lists as pushing anyway (PT-P300BT always; P900/P900W/
//!   P950NW when `ESC i z` n1 carries PI_RECOVER `0x80`); otherwise the printer is silent.
//! - A page counts as printing until the frame that completes it for the host: the trailing
//!   phase change on `start_end` models, the `01` "printing completed" frame on
//!   `start_next_end` models (PROTOCOL.md §6.8 step 3).
//! - `ESC i S` is answered with a type-`00` reply built from the configured media (the idle
//!   reply equals the real fixture for PT-P710BT + 24 mm laminated white/black). While a page
//!   prints, the reply reports phase "printing".
//! - Raster data is parsed with [`parser::JobParser`] and decoded (PackBits or raw) back into
//!   [`crate::Bitmap`]s via the inverse of the §5.1 pin mapping and of the model's
//!   [`crate::ModelProfile::feed_order`] (PROTOCOL.md §5.3), so a decoded page is the label
//!   **as it physically reads** (column 0 = left end with the text upright, row 0 = top edge)
//!   and tests can assert `printed() == input bitmaps`. For PT models the first raster line
//!   received becomes the last column (\[HW\] orientation test label, PT-P710BT). Line
//!   numbers in [`parser::Violation`]s count raster lines in the order received. The hardware
//!   mirror bit (`ESC i M` 0x80) is not applied: a hardware-mirrored page decodes unmirrored,
//!   whereas a software-mirrored page ([`crate::prepare_pages`]) decodes mirrored.
//! - Protocol violations a real printer punishes are reported like the printer would:
//!   media width mismatch in `ESC i z` (or [`Behaviour::WrongMedia`]) → error frame with
//!   `st[9] = 0x01`; a page without `ESC i z` → the same error (PT-P710BT firmware behaviour,
//!   PROTOCOL.md §3.1); data outside the print area, line-count mismatches, unsupported or
//!   out-of-order commands and a command while printing → recorded in
//!   [`VirtualPrinter::violations`]. After an error the printer discards everything except
//!   `ESC i S` until it is reset with `ESC @` or `ESC i 18` (PROTOCOL.md §6.10).
//! - Time: frames become available from `poll_output(now_ms)` after simulated print time
//!   ([`VirtualTiming`], [`Behaviour`]), so session timeouts can be tested deterministically.
//!   The printer never reads a clock: `now_ms` comes from the caller and must not go
//!   backwards.
//!
//! Used by: session tests (WP5), `ptouch decode` and `--virtual` endpoint (WP7), the future
//! wasm `MockTransport`.

pub mod parser;

use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;

use crate::bitmap::Bitmap;
use crate::error::Error;
use crate::model::{FeedOrder, Model, ModelProfile, PageCommand, TapeKind, TapeSpec};
use crate::packbits::packbits_decode;
use crate::status::{STATUS_HEADER, STATUS_LEN};
use parser::{Command, DecodedJob, JobParser, Violation};

/// Scripted device behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum Behaviour {
    /// Behaves like a healthy printer.
    #[default]
    Normal,
    /// Never answers anything (asleep / wrong RFCOMM channel).
    Silent,
    /// Answers status requests but never pushes print progress (E560BT without `ESC i ! 00`).
    NoPush,
    /// Cover opens while printing page `n` (1-based, counted since the printer was created):
    /// error frame `st[9] = 0x10`. The cover counts as closed again once the host resets the
    /// printer (`ESC @` / `ESC i 18`).
    CoverOpenOnPage(u16),
    /// Rejects every `ESC i z` with a wrong-media error frame (`st[9] = 0x01`), as if the
    /// cassette did not match the job although the status reports the configured tape.
    WrongMedia,
    /// Sends `n` extra phase-change frames after each completion (P300BT-class).
    ExtraFrames(u8),
    /// Pushes a cooling notification (start, then finish) during page `n`; printing pauses for
    /// [`VirtualTiming::cooling_ms`].
    CoolingOnPage(u16),
    /// No cassette loaded: `st[10] = 0`, `st[11] = 00`, `st[8] = 0x01` (no media).
    NoMedia,
}

/// Simulated timing of a [`VirtualPrinter`] (all in ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct VirtualTiming {
    /// Delay of a status reply after `ESC i S` (20).
    pub reply_delay_ms: u64,
    /// Delay from the end of page data to the "printing" phase change (50).
    pub start_delay_ms: u64,
    /// Fixed print time per page (500).
    pub base_print_ms: u64,
    /// Print time per raster line (5).
    pub per_line_ms: u64,
    /// Delay between "printing completed" and the phase change to receiving (30).
    pub phase_delay_ms: u64,
    /// Cooling pause for [`Behaviour::CoolingOnPage`] (60 000).
    pub cooling_ms: u64,
}

impl Default for VirtualTiming {
    fn default() -> Self {
        Self {
            reply_delay_ms: 20,
            start_delay_ms: 50,
            base_print_ms: 500,
            per_line_ms: 5,
            phase_delay_ms: 30,
            cooling_ms: 60_000,
        }
    }
}

// Status frame field values (PROTOCOL.md §4.2–§4.5).
const TYPE_REPLY: u8 = 0x00;
const TYPE_COMPLETED: u8 = 0x01;
const TYPE_ERROR: u8 = 0x02;
const TYPE_NOTIFICATION: u8 = 0x05;
const TYPE_PHASE: u8 = 0x06;
const PHASE_RECEIVING: u8 = 0x00;
const PHASE_PRINTING: u8 = 0x01;
const NOTE_COOLING_STARTED: u8 = 0x03;
const NOTE_COOLING_FINISHED: u8 = 0x04;
const INFO1_NO_MEDIA: u8 = 0x01;
const INFO2_WRONG_MEDIA: u8 = 0x01;
const INFO2_COVER_OPEN: u8 = 0x10;
const TAPE_COLOR_WHITE: u8 = 0x01;
const TEXT_COLOR_BLACK: u8 = 0x08;
const COUNTRY_CODE: u8 = 0x30;
/// `ESC i z` n1 bit asking the printer to push recovery/progress status (PROTOCOL.md §3.2.1).
const PI_RECOVER: u8 = 0x80;

/// The three error bytes of a frame: `st[7]`, `st[8]`, `st[9]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct ErrorBytes {
    extended: u8,
    info1: u8,
    info2: u8,
}

/// The virtual printer (see module docs).
#[derive(Debug)]
pub struct VirtualPrinter {
    profile: &'static ModelProfile,
    tape: &'static TapeSpec,
    behaviour: Behaviour,
    parser: parser::JobParser,
    output: VecDeque<(u64, [u8; STATUS_LEN])>,
    printed: Vec<Bitmap>,
    violations: Vec<parser::Violation>,
    timing: VirtualTiming,
    assembler: Assembler,
    /// `ESC i ! 00` received (persists until power-off, PROTOCOL.md §3.1).
    notify: bool,
    /// Last `ESC i z` n1 carried PI_RECOVER (`0x80`).
    recover: bool,
    /// Last `ESC i M` value, echoed in `st[15]`.
    mode: u8,
    /// End of the current printing window (exclusive).
    busy_until: Option<u64>,
    /// Error that takes effect at a scheduled time (cover opening mid-page).
    pending_error: Option<(u64, ErrorBytes)>,
    /// Current error state; while set, everything except `ESC i S` and resets is discarded.
    error: Option<ErrorBytes>,
    /// Pages received so far (1-based number of the last one).
    pages_received: u16,
    /// Latest `now_ms` seen.
    now: u64,
}

impl VirtualPrinter {
    /// A printer of `profile` with `tape` loaded.
    #[must_use]
    pub fn new(
        profile: &'static ModelProfile,
        tape: &'static TapeSpec,
        behaviour: Behaviour,
    ) -> Self {
        Self {
            profile,
            tape,
            behaviour,
            parser: JobParser::new(),
            output: VecDeque::new(),
            printed: Vec::new(),
            violations: Vec::new(),
            timing: VirtualTiming::default(),
            assembler: Assembler::new(profile, Some(tape), false),
            notify: false,
            recover: false,
            mode: 0,
            busy_until: None,
            pending_error: None,
            error: None,
            pages_received: 0,
            now: 0,
        }
    }

    /// Replaces the simulated timing.
    #[must_use]
    pub fn with_timing(mut self, timing: VirtualTiming) -> Self {
        self.timing = timing;
        self
    }

    /// The simulated timing.
    #[must_use]
    pub fn timing(&self) -> &VirtualTiming {
        &self.timing
    }

    /// The configured behaviour.
    #[must_use]
    pub fn behaviour(&self) -> Behaviour {
        self.behaviour
    }

    /// Feeds host → printer bytes received at `now_ms`.
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: u64) {
        self.advance(now_ms);
        self.parser.push(bytes);
        loop {
            let offset = self.parser.offset();
            let Some(cmd) = self.parser.next_command() else {
                break;
            };
            self.on_command(&cmd, offset);
        }
    }

    /// Next status frame due at or before `now_ms`.
    pub fn poll_output(&mut self, now_ms: u64) -> Option<[u8; STATUS_LEN]> {
        self.advance(now_ms);
        match self.output.front() {
            Some(&(at, _)) if at <= self.now => self.output.pop_front().map(|(_, f)| f),
            _ => None,
        }
    }

    /// When the next frame becomes due, if any is scheduled.
    #[must_use]
    pub fn next_output_at(&self) -> Option<u64> {
        self.output.front().map(|(t, _)| *t)
    }

    /// Pages printed so far, decoded to bitmaps of `tape.print_pins` height.
    #[must_use]
    pub fn printed(&self) -> &[Bitmap] {
        &self.printed
    }

    /// Protocol violations observed so far.
    #[must_use]
    pub fn violations(&self) -> &[parser::Violation] {
        &self.violations
    }

    /// `true` while a page is printing at `now_ms` (the window in which the host must stay
    /// silent, PROTOCOL.md §6.8 step 2).
    #[must_use]
    pub fn is_printing(&self, now_ms: u64) -> bool {
        self.busy_until.is_some_and(|end| now_ms < end)
    }

    /// The idle `ESC i S` reply for the configured profile and tape.
    #[must_use]
    pub fn idle_status(&self) -> [u8; STATUS_LEN] {
        let mut f = self.base_frame(ErrorBytes::default());
        f[15] = 0;
        f
    }

    // ----- internals -----

    /// Applies time-triggered state changes up to `now_ms`.
    fn advance(&mut self, now_ms: u64) {
        self.now = self.now.max(now_ms);
        if let Some((at, err)) = self.pending_error
            && at <= self.now
        {
            self.pending_error = None;
            self.error = Some(err);
            // The printer stops: nothing it had planned after the error happens.
            self.output.retain(|(t, _)| *t <= at);
        }
    }

    /// Whether print progress is pushed (PROTOCOL.md §6.8 "per-model observed push
    /// behaviour").
    fn pushes(&self) -> bool {
        if matches!(self.behaviour, Behaviour::NoPush | Behaviour::Silent) {
            return false;
        }
        let unsolicited = match self.profile.model {
            Model::PtP300bt => true,
            Model::PtP900 | Model::PtP900w | Model::PtP950nw => self.recover,
            _ => false,
        };
        self.notify || unsolicited
    }

    fn on_command(&mut self, cmd: &Command, offset: usize) {
        let now = self.now;
        let exempt = match cmd {
            Command::Invalidate(_) | Command::Initialize | Command::Cancel => true,
            Command::StatusRequest => !self.pushes(),
            _ => false,
        };
        if !exempt && self.is_printing(now) {
            self.violations
                .push(Violation::CommandWhilePrinting { offset });
        }
        match cmd {
            Command::Initialize | Command::Cancel => {
                self.reset();
                return;
            }
            Command::StatusRequest => {
                if self.behaviour != Behaviour::Silent {
                    let reply = self.reply_frame(now);
                    self.schedule(now.saturating_add(self.timing.reply_delay_ms), reply);
                }
                return;
            }
            _ => {}
        }
        if self.error.is_some() {
            // The printer has discarded its buffer and ignores data until reset.
            return;
        }
        match cmd {
            Command::StatusNotification(n) => self.notify = *n == 0,
            Command::VariousMode(m) => self.mode = *m,
            _ => {}
        }
        let step = self.assembler.apply(cmd, offset);
        self.violations.append(&mut self.assembler.violations);
        match step {
            Ok(Step::PrintInfo(n)) => self.check_print_info(&n),
            Ok(Step::Page(page)) => self.page_done(page),
            // Lenient mode never fails; keep the arm for totality.
            Ok(Step::None) | Err(_) => {}
        }
    }

    /// `ESC @` / `ESC i 18`: clears the buffer, cancels printing and clears errors.
    fn reset(&mut self) {
        let now = self.now;
        self.output.retain(|(t, _)| *t <= now);
        self.pending_error = None;
        self.error = None;
        self.busy_until = None;
        self.assembler.reset();
    }

    /// Media check on `ESC i z` (PROTOCOL.md §3.2.1: mismatch → `st[9] = 0x01`).
    fn check_print_info(&mut self, n: &[u8; 10]) {
        self.recover = n[0] & PI_RECOVER != 0;
        let kind_ok = n[0] & 0x02 == 0
            || n[1] == self.tape.print_info_media_type
            || self.tape.print_info_media_type_high_res == Some(n[1]);
        let mismatch = self.behaviour == Behaviour::WrongMedia
            || self.behaviour == Behaviour::NoMedia
            || n[2] != self.tape.media_width_byte
            || !kind_ok;
        if mismatch {
            self.raise(ErrorBytes {
                info2: INFO2_WRONG_MEDIA,
                ..ErrorBytes::default()
            });
        }
    }

    /// Enters the error state now and pushes an error frame.
    fn raise(&mut self, err: ErrorBytes) {
        let now = self.now;
        self.error = Some(err);
        self.busy_until = None;
        self.output.retain(|(t, _)| *t <= now);
        if self.behaviour != Behaviour::Silent {
            let f = self.frame(TYPE_ERROR, PHASE_RECEIVING, 0, err);
            self.schedule(now.saturating_add(self.timing.reply_delay_ms), f);
        }
    }

    fn page_done(&mut self, page: PageOut) {
        if page.missing_info {
            // P710BT firmware rejects raster data without ESC i z (PROTOCOL.md §3.1).
            self.raise(ErrorBytes {
                info2: INFO2_WRONG_MEDIA,
                ..ErrorBytes::default()
            });
            return;
        }
        if let Some(bitmap) = page.bitmap {
            self.printed.push(bitmap);
        }
        self.pages_received = self.pages_received.saturating_add(1);
        self.schedule_print(page.lines);
    }

    /// Schedules the frames of one page print (PROTOCOL.md §6.3/§6.8).
    fn schedule_print(&mut self, lines: u32) {
        let t = self.timing;
        let page_no = self.pages_received;
        let start = self
            .now
            .max(self.busy_until.unwrap_or(0))
            .saturating_add(t.start_delay_ms);
        let duration = t
            .base_print_ms
            .saturating_add(t.per_line_ms.saturating_mul(u64::from(lines)));
        let push = self.pushes();
        let none = ErrorBytes::default();

        if push {
            let f = self.frame(TYPE_PHASE, PHASE_PRINTING, 0, none);
            self.schedule(start, f);
        }

        if self.behaviour == Behaviour::CoverOpenOnPage(page_no) {
            let at = start.saturating_add(duration / 2);
            let err = ErrorBytes {
                info2: INFO2_COVER_OPEN,
                ..ErrorBytes::default()
            };
            if push {
                let f = self.frame(TYPE_ERROR, PHASE_RECEIVING, 0, err);
                self.schedule(at, f);
            }
            self.pending_error = Some((at, err));
            self.busy_until = Some(at);
            return;
        }

        let mut done = start.saturating_add(duration);
        if self.behaviour == Behaviour::CoolingOnPage(page_no) {
            let cool_at = start.saturating_add(duration / 2);
            let cool_end = cool_at.saturating_add(t.cooling_ms);
            if push {
                let f = self.frame(
                    TYPE_NOTIFICATION,
                    PHASE_PRINTING,
                    NOTE_COOLING_STARTED,
                    none,
                );
                self.schedule(cool_at, f);
                let f = self.frame(
                    TYPE_NOTIFICATION,
                    PHASE_PRINTING,
                    NOTE_COOLING_FINISHED,
                    none,
                );
                self.schedule(cool_end, f);
            }
            done = done.saturating_add(t.cooling_ms);
        }

        let extra = match self.behaviour {
            Behaviour::ExtraFrames(n) => u64::from(n),
            _ => 0,
        };
        // The host may continue after the frame that completes the page: the first phase
        // change to receiving on start_end models, "printing completed" otherwise (§6.8
        // step 3). Extra frames trail it.
        let end = match self.profile.page_command {
            PageCommand::StartEnd => done.saturating_add(t.phase_delay_ms),
            PageCommand::StartNextEnd => done,
        };
        if push {
            let f = self.frame(TYPE_COMPLETED, PHASE_PRINTING, 0, none);
            self.schedule(done, f);
            let f = self.frame(TYPE_PHASE, PHASE_RECEIVING, 0, none);
            for k in 1..=1 + extra {
                self.schedule(done.saturating_add(t.phase_delay_ms.saturating_mul(k)), f);
            }
        }
        self.busy_until = Some(end);
    }

    /// Inserts a frame keeping the queue ordered by time (FIFO among equal times).
    fn schedule(&mut self, at: u64, frame: [u8; STATUS_LEN]) {
        let idx = self.output.partition_point(|(t, _)| *t <= at);
        self.output.insert(idx, (at, frame));
    }

    /// Reply to `ESC i S` at `now`.
    fn reply_frame(&self, now: u64) -> [u8; STATUS_LEN] {
        let phase = if self.is_printing(now) {
            PHASE_PRINTING
        } else {
            PHASE_RECEIVING
        };
        self.frame(TYPE_REPLY, phase, 0, self.error.unwrap_or_default())
    }

    fn frame(&self, status_type: u8, phase: u8, notification: u8, err: ErrorBytes) -> [u8; 32] {
        let mut f = self.base_frame(err);
        f[18] = status_type;
        f[19] = phase;
        f[22] = notification;
        f
    }

    /// Type-`00`, phase-receiving frame for the configured printer and media, with `err` ORed
    /// into the error bytes.
    fn base_frame(&self, err: ErrorBytes) -> [u8; STATUS_LEN] {
        let mut f = [0u8; STATUS_LEN];
        f[..3].copy_from_slice(&STATUS_HEADER);
        f[3] = self.profile.series_code;
        f[4] = self.profile.model_code;
        f[5] = COUNTRY_CODE;
        f[7] = err.extended;
        f[8] = err.info1;
        f[9] = err.info2;
        if self.behaviour == Behaviour::NoMedia {
            f[8] |= INFO1_NO_MEDIA;
        } else {
            f[10] = self.tape.media_width_byte;
            f[11] = self.tape.status_media_type;
            f[17] = self.tape.length_mm.unwrap_or(0);
            f[24] = TAPE_COLOR_WHITE;
            f[25] = TEXT_COLOR_BLACK;
        }
        f[15] = self.mode;
        f
    }
}

/// Decodes a complete job byte stream offline (for `ptouch decode job.bin`): every page as a
/// bitmap of the print-area height inferred from `ESC i z` n3 and `profile`.
///
/// Rule violations (unknown bytes, line-count mismatches, ink outside the print area, …) do
/// not stop the decode; they are listed in [`parser::DecodedJob::violations`].
///
/// # Errors
/// [`crate::Error::Corrupt`] for malformed streams (truncated command, undecodable raster
/// line, raster data before any `ESC i z`), [`crate::Error::UnsupportedMedia`] when the width
/// byte has no media entry.
pub fn decode_job(
    profile: &'static ModelProfile,
    bytes: &[u8],
) -> Result<parser::DecodedJob, crate::Error> {
    let mut parser = JobParser::new();
    parser.push(bytes);
    let mut asm = Assembler::new(profile, None, true);
    let mut commands = Vec::new();
    let mut pages = Vec::new();
    loop {
        let offset = parser.offset();
        let cmd = match parser.next_command() {
            Some(cmd) => cmd,
            None => match parser.finish() {
                Some(cmd @ Command::Invalidate(_)) => cmd,
                Some(_) => {
                    return Err(Error::Corrupt {
                        what: "job (truncated command)",
                        offset,
                    });
                }
                None => break,
            },
        };
        if let Step::Page(page) = asm.apply(&cmd, offset)?
            && let Some(bitmap) = page.bitmap
        {
            pages.push(bitmap);
        }
        commands.push(cmd);
    }
    Ok(DecodedJob {
        commands,
        pages,
        violations: asm.violations,
    })
}

/// Media entry of `profile` described by `ESC i z` n1..n10: width n3, and n2 when n1 flags it
/// as valid (`0x02`); otherwise TZe geometry is preferred (PROTOCOL.md §3.2.1, §4.6.1).
fn tape_for_print_info(profile: &ModelProfile, n: &[u8; 10]) -> Option<&'static TapeSpec> {
    let mut candidates = profile
        .media
        .iter()
        .copied()
        .filter(move |t| t.media_width_byte == n[2]);
    if n[0] & 0x02 != 0 {
        candidates.find(|t| {
            t.print_info_media_type == n[1] || t.print_info_media_type_high_res == Some(n[1])
        })
    } else {
        let all: Vec<&'static TapeSpec> = candidates.collect();
        all.iter()
            .copied()
            .find(|t| t.kind == TapeKind::Tze)
            .or_else(|| all.first().copied())
    }
}

/// Why a command is not supported by the model, if it is not (PROTOCOL.md §3.1–§3.2).
fn unsupported(profile: &ModelProfile, cmd: &Command) -> Option<&'static str> {
    let caps = &profile.caps;
    match *cmd {
        Command::CutEvery(_) if caps.cut_every == Some(false) => Some("ESC i A (cut every)"),
        Command::AdvancedMode(k) if k & 0x04 != 0 && !caps.half_cut => Some("half cut"),
        Command::AdvancedMode(k) if k & 0x40 != 0 && !caps.high_resolution => {
            Some("high resolution")
        }
        Command::AdvancedMode(k) if k & 0x01 != 0 && !caps.draft => Some("draft resolution"),
        Command::AdvancedMode(k) if k & 0x10 != 0 && !caps.special_tape => Some("special tape"),
        Command::VariousMode(m) if m & 0x80 != 0 && !caps.mirror => Some("hardware mirror"),
        Command::Compression(2) if !caps.compression => Some("PackBits compression"),
        Command::Compression(c) if c != 0 && c != 2 => Some("compression mode"),
        _ => None,
    }
}

/// What a command did to the page being assembled.
enum Step {
    /// Nothing visible outside.
    None,
    /// `ESC i z` was accepted for the current page.
    PrintInfo([u8; 10]),
    /// A page ended (`0C` / `1A`).
    Page(PageOut),
}

/// A finished page.
struct PageOut {
    /// Decoded page; `None` when no geometry was known.
    bitmap: Option<Bitmap>,
    /// Raster lines received.
    lines: u32,
    /// The page had no `ESC i z`.
    missing_info: bool,
}

/// Device-side page assembly and validation shared by [`VirtualPrinter`] (lenient: problems
/// become violations) and [`decode_job`] (strict: malformed data is an error).
#[derive(Debug)]
struct Assembler {
    profile: &'static ModelProfile,
    /// The loaded tape (virtual printer) or `None` (infer from `ESC i z`).
    fixed_tape: Option<&'static TapeSpec>,
    strict: bool,
    /// 1-based number of the page being assembled.
    page: u16,
    /// The next page is the first page of a job (n9 rule).
    first_of_job: bool,
    info: Option<[u8; 10]>,
    /// Geometry of the current page (or of the last page, for raster data without `ESC i z`).
    tape: Option<&'static TapeSpec>,
    compression: u8,
    /// Packed bitmap lines of the current page.
    lines: Vec<u8>,
    received: u32,
    missing_info: bool,
    outside_reported: bool,
    violations: Vec<Violation>,
}

impl Assembler {
    fn new(
        profile: &'static ModelProfile,
        fixed_tape: Option<&'static TapeSpec>,
        strict: bool,
    ) -> Self {
        Self {
            profile,
            fixed_tape,
            strict,
            page: 1,
            first_of_job: true,
            info: None,
            tape: fixed_tape,
            compression: 0,
            lines: Vec::new(),
            received: 0,
            missing_info: false,
            outside_reported: false,
            violations: Vec::new(),
        }
    }

    /// `ESC @` / cancel: drops the partial page and the settings.
    fn reset(&mut self) {
        self.first_of_job = true;
        self.compression = 0;
        self.clear_page();
    }

    fn clear_page(&mut self) {
        self.info = None;
        self.lines.clear();
        self.received = 0;
        self.missing_info = false;
        self.outside_reported = false;
    }

    fn apply(&mut self, cmd: &Command, offset: usize) -> Result<Step, Error> {
        if let Some(what) = unsupported(self.profile, cmd) {
            self.violations
                .push(Violation::UnsupportedCommand { offset, what });
        }
        match cmd {
            Command::Initialize | Command::Cancel => self.reset(),
            Command::Unknown(_) => self.violations.push(Violation::UnknownCommand { offset }),
            Command::PrintInfo(n) => {
                if self.received > 0 {
                    self.violations.push(Violation::OutOfOrder {
                        offset,
                        what: "ESC i z after raster data",
                    });
                }
                let tape = match self.fixed_tape {
                    Some(t) => t,
                    None => {
                        tape_for_print_info(self.profile, n).ok_or(Error::UnsupportedMedia {
                            width_mm: n[2],
                            media_type: n[1],
                        })?
                    }
                };
                self.tape = Some(tape);
                self.info = Some(*n);
                return Ok(Step::PrintInfo(*n));
            }
            Command::Compression(c) => {
                self.control_order(offset);
                self.compression = *c;
            }
            Command::VariousMode(_)
            | Command::AdvancedMode(_)
            | Command::CutEvery(_)
            | Command::Margin(_)
            | Command::Copies(_)
            | Command::StoredUpPrint(_)
            | Command::LineControl(_)
            | Command::ColorInfo(_) => self.control_order(offset),
            Command::RasterLine(payload) => self.raster(Some(payload), offset)?,
            Command::ZeroLine => self.raster(None, offset)?,
            Command::Print => return Ok(Step::Page(self.end_page(false))),
            Command::PrintLast => return Ok(Step::Page(self.end_page(true))),
            Command::Invalidate(_)
            | Command::StatusRequest
            | Command::CommandMode(_)
            | Command::StatusNotification(_)
            | Command::NonPrint(_) => {}
        }
        Ok(Step::None)
    }

    /// Page-control commands belong before the raster data.
    fn control_order(&mut self, offset: usize) {
        if self.received > 0 {
            self.violations.push(Violation::OutOfOrder {
                offset,
                what: "control command after raster data",
            });
        }
    }

    fn raster(&mut self, payload: Option<&[u8]>, offset: usize) -> Result<(), Error> {
        if self.info.is_none() && !self.missing_info {
            self.missing_info = true;
            self.violations
                .push(Violation::MissingPrintInfo { page: self.page });
        }
        let Some(tape) = self.tape else {
            return Err(Error::Corrupt {
                what: "job (raster data before ESC i z)",
                offset,
            });
        };
        let width = usize::from(self.profile.bytes_per_line);
        let line_no = self.received;
        let head = match payload {
            None => {
                if self.compression != 2 {
                    self.violations
                        .push(Violation::ZeroLineWithoutCompression { offset });
                }
                Ok(vec![0u8; width])
            }
            Some(data) if self.compression == 2 => {
                packbits_decode(data, width).map_err(|_| Error::Corrupt {
                    what: "packbits",
                    offset,
                })
            }
            Some(data) if data.len() == width => Ok(data.to_vec()),
            Some(_) => Err(Error::Corrupt {
                what: "raster line",
                offset,
            }),
        };
        let head = match head {
            Ok(h) => h,
            Err(e) if self.strict => return Err(e),
            Err(_) => {
                self.violations.push(Violation::MalformedRasterLine {
                    page: self.page,
                    line: line_no,
                });
                vec![0u8; width]
            }
        };
        let stride = Bitmap::stride_for(tape.print_pins);
        let start = self.lines.len();
        self.lines.resize(start + stride, 0);
        let outside = head_to_dots(&head, tape, &mut self.lines[start..]);
        if outside && !self.outside_reported {
            self.outside_reported = true;
            self.violations.push(Violation::DataOutsidePrintArea {
                page: self.page,
                line: line_no,
            });
        }
        self.received = self.received.saturating_add(1);
        Ok(())
    }

    fn end_page(&mut self, last: bool) -> PageOut {
        let page = self.page;
        let missing_info = match self.info {
            None => {
                if !self.missing_info {
                    self.violations.push(Violation::MissingPrintInfo { page });
                }
                true
            }
            Some(n) => {
                let declared = u32::from_le_bytes([n[4], n[5], n[6], n[7]]);
                if declared != self.received {
                    self.violations.push(Violation::LineCountMismatch {
                        page,
                        declared,
                        received: self.received,
                    });
                }
                let expected = match self.profile.page_command {
                    PageCommand::StartEnd => u8::from(!self.first_of_job),
                    PageCommand::StartNextEnd if last => 2,
                    PageCommand::StartNextEnd => u8::from(!self.first_of_job),
                };
                if n[8] != expected {
                    self.violations.push(Violation::PagePosition {
                        page,
                        got: n[8],
                        expected,
                    });
                }
                false
            }
        };
        // `lines` holds the raster lines in the order received; put them back in canvas
        // order (PROTOCOL.md §5.3) so the page reads like the printed label.
        let bitmap = self.tape.and_then(|t| {
            Bitmap::from_packed(
                self.received,
                t.print_pins,
                core::mem::take(&mut self.lines),
            )
            .ok()
            .map(|received| match self.profile.feed_order() {
                FeedOrder::LastColumnFirst => received.reversed(),
                FeedOrder::FirstColumnFirst => received,
            })
        });
        let out = PageOut {
            bitmap,
            lines: self.received,
            missing_info,
        };
        self.page = self.page.saturating_add(1);
        self.first_of_job = last;
        self.clear_page();
        out
    }
}

/// Inverse of the PROTOCOL.md §5.1 pin mapping: transmitted bit `t` of `head` in
/// `[right, right + print)` becomes bitmap dot `right + print − 1 − t` in `dots` (packed
/// MSB-first, zeroed by the caller). Returns `true` if any bit outside the print area is set.
fn head_to_dots(head: &[u8], tape: &TapeSpec, dots: &mut [u8]) -> bool {
    let right = usize::from(tape.right_margin_pins);
    let print = usize::from(tape.print_pins);
    let mut outside = false;
    for (i, &byte) in head.iter().enumerate() {
        if byte == 0 {
            continue;
        }
        for bit in 0..8 {
            if byte & (0x80 >> bit) == 0 {
                continue;
            }
            let t = i * 8 + bit;
            if t < right || t >= right + print {
                outside = true;
                continue;
            }
            let p = right + print - 1 - t;
            if let Some(d) = dots.get_mut(p / 8) {
                *d |= 0x80 >> (p % 8);
            }
        }
    }
    outside
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tape(print: u16, left: u16, right: u16) -> TapeSpec {
        TapeSpec {
            id: "test",
            geometry: crate::model::Geometry::Pt128,
            head_pins: 128,
            kind: TapeKind::Tze,
            width_mm_x10: 120,
            media_width_byte: 12,
            length_mm: None,
            status_media_type: 1,
            print_info_media_type: 1,
            print_info_media_type_high_res: None,
            left_margin_pins: left,
            print_pins: print,
            right_margin_pins: right,
            tape_width_dots: 84,
            default_feed_dots: 14,
            physical_length_dots: None,
            printable_length_dots: None,
        }
    }

    #[test]
    fn inverse_pin_mapping_12mm_worked_example() {
        // PROTOCOL.md §5.1: all 70 dots set on 12 mm.
        let head = [
            0x00, 0x00, 0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0, 0, 0,
        ];
        let t = tape(70, 29, 29);
        let mut dots = [0u8; 9];
        assert!(!head_to_dots(&head, &t, &mut dots));
        assert_eq!(dots, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFC]);
    }

    #[test]
    fn inverse_pin_mapping_single_dots() {
        let t = tape(70, 29, 29);
        // Dot 0 → transmitted bit right + print − 1 = 98 (byte 12, bit 2 from MSB).
        let mut head = [0u8; 16];
        head[12] = 0x20;
        let mut dots = [0u8; 9];
        assert!(!head_to_dots(&head, &t, &mut dots));
        assert_eq!(dots[0], 0x80);
        // Dot 69 → transmitted bit 29 (byte 3, bit 5 from MSB).
        let mut head = [0u8; 16];
        head[3] = 0x04;
        let mut dots = [0u8; 9];
        assert!(!head_to_dots(&head, &t, &mut dots));
        assert_eq!(dots[8], 0x04);
        // Bit 0 is in the right margin.
        let mut head = [0u8; 16];
        head[0] = 0x80;
        assert!(head_to_dots(&head, &t, &mut [0u8; 9]));
    }
}
