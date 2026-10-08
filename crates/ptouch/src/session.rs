//! Sans-IO print session state machine (WP5).
//!
//! # Contract (quinn/str0m style)
//! The caller owns the transport and the clock; the session owns every protocol decision.
//! ```text
//! loop {
//!     while let Some(buf) = s.poll_transmit() { transport.write_all(&buf) }   // in order
//!     while let Some(ev)  = s.poll_event()    { ui.handle(ev) }
//!     let deadline = s.poll_timeout();                       // absolute ms, same clock as now_ms
//!     match transport.read(until deadline) {
//!         bytes => s.handle_input(&bytes, now_ms()),
//!         timeout => s.handle_timeout(now_ms()),
//!     }
//! }
//! ```
//! - Time is a caller-supplied monotonic `now_ms: u64`; the session never reads a clock.
//!   `handle_timeout` with a `now_ms` before the deadline is a no-op.
//! - Input is arbitrary chunks; frames are reassembled by [`StatusFramer`].
//! - The session never emits a command while a page is printing (PROTOCOL.md §6.8 step 2),
//!   except the poll fallback for models without confirmed push status (§6.8 step 4).
//!   [`Session::request_status`] returns [`Error::Busy`] in that window.
//! - A job is released page by page: `preamble + page 1`, then page *n+1* only after page *n*
//!   completed (§6.8 table), then [`crate::EncodedJob::epilogue`] after the last page.
//! - Preflight on [`Session::submit`] against the last status (§6.1 step 6): no errors,
//!   media present, ready phase, `media_width_byte` (and geometry) matches the job, job model
//!   matches the detected model.
//! - Errors from the printer end the job with [`Event::Failed`] carrying the page to resume
//!   from (§6.10: the last page whose "printing" phase change was received, else page 1); the
//!   session then queues the cancel sequence and returns to [`SessionState::Ready`] once a
//!   status poll shows the ready predicate. It never re-sends a partially transmitted job.
//! - Notification `03` (cooling) suspends the page clock (§6.8 step 4). The cooling state
//!   survives page boundaries: it ends only with notification `04` (cooling finished) or the
//!   next page's first "printing" frame, and while it lasts the next page is not released on
//!   the 2 s phase-frame timeout.
//! - Status type `04` (turned off) is fatal in every state except `Idle` and `Failed`
//!   ([`Error::PrinterOff`]). Errors that arrive while draining after the last page (the label
//!   is still being fed or cut, §6.10) end the job with [`Event::Failed`] (resume from the last
//!   page) and start recovery, as during printing.
//! - An error-type frame (`st[18]` = `02` / `18`) whose error bytes are all zero is reported as
//!   [`Error::Protocol`] (never as an empty [`Error::Printer`]).
//!
//! # Push vs poll (PROTOCOL.md §6.8 step 4)
//! The model table has no "pushes status" column, so the session classifies models from the
//! §6.8 list: PT-P300BT and the P900 family push unconditionally; PT-P710BT/P715eBT/E720BT
//! and PT-P910BT/E920BT push only when the job enables `ESC i ! 00` (the session looks for it
//! in the job's control prefix); every other model is treated as "push not confirmed" and
//! gets the poll fallback. A pushed frame on a polled job switches it to the push rule.
//! - **Push:** after a page is sent the session stays silent. A frame resets the silence
//!   clock; with no frame for `T_est + page_margin_ms` (cooling time excluded) the page fails
//!   with [`TimeoutKind::Page`].
//! - **Poll:** with no frame for `T_est` after the page, the session sends `ESC i S`, then again
//!   after every `poll_interval_ms` without completion, up to `max_ticks` polls.
//!
//! `T_est = page_time_base_ms + page_time_per_line_ms × lines`.
//!
//! # Completion (PROTOCOL.md §6.8 table)
//! `06`/printing → [`Event::PageStarted`]; `01` → [`Event::PageCompleted`] (on `start_end`
//! models the session then waits up to `phase_frame_wait_ms` for the trailing `06`/receiving
//! frame); `06`/receiving after printing, or a poll reply with the ready predicate, completes
//! the page. `PageStarted` is always emitted before `PageCompleted`, synthesised if the printer
//! never reported "printing" (poll fallback).
//!
//! # State machine
//! ```text
//! Idle --connect--> Handshaking{attempt} --valid status--> Ready
//!   Handshaking --timeout ×attempts--> Failed(Timeout(Handshake))
//! Ready --submit--> Printing{page,of} --page done--> Printing{page+1} … --> Draining --> Ready
//! Printing --error frame--> Recovering --ready status--> Ready      (Failed event emitted)
//! Draining --error frame--> Recovering                               (Failed event emitted)
//! any but Idle/Failed --turned off (04)--> Failed(PrinterOff)
//! any --cancel--> Recovering
//! ```
//! Leaving `Recovering` emits [`Event::Ready`] again. `Failed` (handshake failure, model
//! mismatch, printer turned off, recovery polls exhausted) needs a new [`Session::connect`].
//!
//! # Spec references
//! PROTOCOL.md §2.1 (wake-up: 3 attempts × 5 s, drain after `ESC i a 01`), §4.2–§4.5, §6.1,
//! §6.8 (normative completion state machine, `T_est`, push vs poll), §6.10; ARCHITECTURE.md
//! §5.4–§5.5.

use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;

use crate::encode::{
    EncodedJob, STATUS_REQUEST, cancel_sequence, generic_handshake_sequence, handshake_sequence,
};
use crate::error::{Error, TimeoutKind};
use crate::model::{Model, ModelProfile, PageCommand, profile_by_codes};
use crate::status::{Notification, Phase, PrinterErrors, Status, StatusFramer, StatusType};

/// Timing parameters. Defaults follow PROTOCOL.md §2.1 / §6.8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SessionConfig {
    /// Wait for a status reply per handshake attempt (5000).
    pub status_timeout_ms: u64,
    /// Handshake attempts, each re-sending invalidate + `ESC @` + `ESC i a 01` + `ESC i S` (3).
    pub status_attempts: u8,
    /// Input drained (ignored) after `ESC i a 01` before `ESC i S` (100).
    pub mode_switch_drain_ms: u64,
    /// `T_est` base per page (2500).
    pub page_time_base_ms: u64,
    /// `T_est` per raster line (10; UNVERIFIED, calibrate on hardware).
    pub page_time_per_line_ms: u64,
    /// Silence tolerated after `T_est` on push models (30_000).
    pub page_margin_ms: u64,
    /// Read tick / poll interval for models without push (10_000).
    pub poll_interval_ms: u64,
    /// Ticks without completion before giving up (180 ≈ 30 min).
    pub max_ticks: u16,
    /// Wait for the trailing phase-change frame after "printing completed" on start_end
    /// models (2000).
    pub phase_frame_wait_ms: u64,
    /// Swallow extra frames after the job (500).
    pub post_job_drain_ms: u64,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            status_timeout_ms: 5_000,
            status_attempts: 3,
            mode_switch_drain_ms: 100,
            page_time_base_ms: 2_500,
            page_time_per_line_ms: 10,
            page_margin_ms: 30_000,
            poll_interval_ms: 10_000,
            max_ticks: 180,
            phase_frame_wait_ms: 2_000,
            post_job_drain_ms: 500,
        }
    }
}

impl SessionConfig {
    /// Estimated print time `T_est` of a page with `lines` raster lines (PROTOCOL.md §6.8).
    #[must_use]
    pub fn page_time_ms(&self, lines: u32) -> u64 {
        self.page_time_base_ms
            .saturating_add(self.page_time_per_line_ms.saturating_mul(u64::from(lines)))
    }
}

/// Coarse session state for UIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum SessionState {
    /// Not connected; call [`Session::connect`].
    Idle,
    /// Waking the printer and waiting for the first valid status.
    Handshaking {
        /// 1-based attempt.
        attempt: u8,
    },
    /// Model and media known; a job may be submitted.
    Ready,
    /// A job is in progress.
    Printing {
        /// 1-based page currently sent/printing.
        page: u16,
        /// Total pages.
        of: u16,
    },
    /// Job finished; swallowing trailing frames.
    Draining,
    /// Cancel / error recovery in progress (cancel sent, waiting for the ready predicate).
    Recovering,
    /// Unrecoverable without a new [`Session::connect`].
    Failed,
}

/// Something the caller should know about.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub enum Event {
    /// Every successfully parsed status frame.
    Status(Status),
    /// Handshake done: model identified, media known. Also emitted when error recovery or a
    /// cancel brought the printer back to the ready predicate.
    Ready(Status),
    /// A page started printing (phase change → printing).
    PageStarted {
        /// 1-based page.
        page: u16,
    },
    /// A page completed (printing completed / phase → receiving).
    PageCompleted {
        /// 1-based page.
        page: u16,
    },
    /// All pages completed.
    JobCompleted,
    /// A notification frame (cover open/closed, cooling…).
    Notification(Notification),
    /// The handshake, a job or an explicit status request failed (or the job was cancelled:
    /// [`Error::Cancelled`]).
    Failed {
        /// Why.
        error: Error,
        /// For job errors: 1-based page to resume from (PROTOCOL.md §6.10); `None` outside a
        /// job.
        resume_from_page: Option<u16>,
    },
}

/// Whether and when a model pushes status frames while printing (PROTOCOL.md §6.8 step 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushKind {
    /// Pushes without `ESC i !` (P300BT; P900 family via PI_RECOVER).
    Always,
    /// Pushes after `ESC i ! 00`.
    AfterNotify,
    /// No confirmed push: poll fallback.
    Unconfirmed,
}

fn push_kind(model: Model) -> PushKind {
    match model {
        Model::PtP300bt | Model::PtP900 | Model::PtP900w | Model::PtP950nw => PushKind::Always,
        Model::PtP710bt
        | Model::PtP715ebt
        | Model::PtE720bt
        | Model::PtP910bt
        | Model::PtE920bt => PushKind::AfterNotify,
        _ => PushKind::Unconfirmed,
    }
}

/// `true` if `ESC i ! 00` appears in the job's control prefix (preamble + page 1 up to the
/// first `ESC i z`; raster data only follows `ESC i z`, so it cannot fake a match).
fn job_enables_notify(job: &EncodedJob) -> bool {
    const NOTIFY_ON: [u8; 4] = [0x1B, 0x69, 0x21, 0x00];
    const PRINT_INFO: [u8; 3] = [0x1B, 0x69, 0x7A];
    let scan = |bytes: &[u8]| -> (bool, bool) {
        let end = bytes
            .windows(PRINT_INFO.len())
            .position(|w| w == PRINT_INFO)
            .unwrap_or(bytes.len());
        let prefix = bytes.get(..end).unwrap_or(bytes);
        let found = prefix.windows(NOTIFY_ON.len()).any(|w| w == NOTIFY_ON);
        (found, end < bytes.len())
    };
    let (found, stop) = scan(&job.preamble);
    if found || stop {
        return found;
    }
    job.pages.first().is_some_and(|p| scan(p).0)
}

/// Geometry key of a status / job media-type byte (PROTOCOL.md §4.6.1): HS 2:1, FLe and HS 3:1
/// have their own tables, self-laminating may use SL or TZe geometry, all else is TZe.
fn same_geometry(a: u8, b: u8) -> bool {
    const TZE: u8 = 0x01;
    const SL: u8 = 0x16;
    let key = |t: u8| match t {
        0x11 | 0x13 | 0x17 | SL => t,
        _ => TZE,
    };
    let (a, b) = (key(a), key(b));
    a == b || (a == SL && b == TZE) || (a == TZE && b == SL)
}

/// The errors a frame reports. A cover-open notification or phase `01 0014` is an error even
/// when the error bytes are clear (PROTOCOL.md §4.3/§4.4); it is reported as `st[9] = 0x10`.
fn frame_errors(status: &Status) -> PrinterErrors {
    let mut e = status.errors;
    let cover_open =
        status.notification == Notification::CoverOpen || status.phase == Phase::Printing(0x0014);
    if e.is_empty() && cover_open {
        e.info2 |= 0x10;
    }
    e
}

/// The error an error frame reports: [`Error::Printer`] with the frame's errors, or
/// [`Error::Protocol`] when the frame is an error only by its status type (`02`, or the
/// undocumented `18`) and carries no error bit, so that a UI never shows an empty error set.
fn frame_error(status: &Status) -> Error {
    let errors = frame_errors(status);
    if !errors.is_empty() {
        return Error::Printer(errors);
    }
    Error::Protocol(match status.status_type {
        StatusType::Error => "the printer reported an error (status type 02) without error bits",
        _ => {
            "the printer reported an undocumented error status (status type 18) without error bits"
        }
    })
}

/// `st[11]` of laminated TZe, the only media that allows high-resolution printing
/// (PROTOCOL.md §5.4).
const LAMINATED: u8 = 0x01;

/// Preflight of PROTOCOL.md §6.1 step 6.
fn preflight(status: &Status, job: &EncodedJob) -> Result<(), Error> {
    if !status.has_media() {
        return Err(Error::NoMedia);
    }
    if status.status_type == StatusType::TurnedOff {
        return Err(Error::PrinterOff);
    }
    if status.is_error() {
        return Err(frame_error(status));
    }
    if !status.is_ready() {
        return Err(Error::NotReady);
    }
    if status.media_width_mm != job.media_width_byte
        || !same_geometry(status.media_type.to_byte(), job.media_type_byte)
    {
        return Err(Error::MediaMismatch {
            loaded_mm: status.media_width_mm,
            job_mm: job.media_width_byte,
        });
    }
    if job.high_resolution && status.media_type.to_byte() != LAMINATED {
        return Err(Error::Unsupported(
            "high-resolution printing needs laminated TZe tape",
        ));
    }
    Ok(())
}

/// Progress of the page in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageStep {
    /// Sent; no "printing" seen yet.
    Sent,
    /// "Printing" seen.
    Printing,
    /// "Printing completed" seen; waiting for the trailing phase change (start_end models).
    Completed,
}

/// Job progress (state `Printing`).
#[derive(Debug, Clone)]
struct PrintRun {
    /// 1-based page in flight.
    page: u16,
    of: u16,
    step: PageStep,
    started_event: bool,
    completed_event: bool,
    /// Last page whose "printing" was received (PROTOCOL.md §6.10 resend rule).
    resume: Option<u16>,
    /// Push rule active (otherwise poll fallback).
    push: bool,
    /// Poll fallback: `T_est` has elapsed and polls are being sent.
    polling: bool,
    /// A poll is outstanding (a type-00 reply is expected).
    awaiting_reply: bool,
    /// Polls sent for this page.
    ticks: u16,
    cooling: bool,
    /// Start of the current silence interval.
    clock_start: u64,
    /// Silence already used before a cooling pause.
    consumed: u64,
    /// `T_est` for the page.
    t_est: u64,
    /// When "printing completed" arrived.
    completed_at: u64,
    /// Next poll / cooling tick.
    next_tick: u64,
}

impl PrintRun {
    fn new(of: u16, push: bool, t_est: u64, now: u64) -> Self {
        Self {
            page: 1,
            of,
            step: PageStep::Sent,
            started_event: false,
            completed_event: false,
            resume: None,
            push,
            polling: false,
            awaiting_reply: false,
            ticks: 0,
            cooling: false,
            clock_start: now,
            consumed: 0,
            t_est,
            completed_at: now,
            next_tick: now,
        }
    }

    /// Moves on to the next page, sent at `now`. A cooling pause that started on the previous
    /// page carries over (the clock stays suspended, the cooling tick keeps running).
    fn next_page(&mut self, t_est: u64, now: u64) {
        *self = Self {
            page: self.page.saturating_add(1),
            resume: self.resume,
            push: self.push,
            cooling: self.cooling,
            next_tick: if self.cooling { self.next_tick } else { now },
            ..Self::new(self.of, self.push, t_est, now)
        };
    }

    /// Cooling ended at `now`: the silence clock restarts.
    fn stop_cooling(&mut self, now: u64) {
        if self.cooling {
            self.cooling = false;
            self.clock_start = now;
            self.consumed = 0;
        }
    }

    /// A frame arrived: the silence clock restarts (unless cooling suspends it).
    fn touch(&mut self, now: u64) {
        if !self.cooling {
            self.clock_start = now;
            self.consumed = 0;
        }
    }

    fn resume_page(&self) -> u16 {
        self.resume.unwrap_or(1)
    }
}

/// Recovery progress (state `Recovering`).
#[derive(Debug, Clone, Copy, Default)]
struct Recovery {
    /// `ESC i S` sent (otherwise still draining after the cancel sequence).
    awaiting: bool,
    /// A reply arrived since the last poll.
    replied: bool,
    /// Consecutive polls without any reply.
    silent: u8,
    /// Polls sent.
    polls: u16,
}

/// Internal state.
#[derive(Debug, Clone)]
enum Stage {
    Idle {
        /// An explicit status request is outstanding.
        request: bool,
    },
    Handshake {
        attempt: u8,
        /// `ESC i S` sent (otherwise draining after the mode switch).
        awaiting: bool,
    },
    Ready {
        request: bool,
    },
    Printing(PrintRun),
    Draining {
        /// Page to resume from if an error arrives while draining (the last page, §6.10).
        resume: u16,
    },
    Recovering(Recovery),
    Failed,
}

/// The print session (see module docs).
#[derive(Debug)]
pub struct Session {
    /// Detected (or expected) profile.
    profile: Option<&'static ModelProfile>,
    /// Profile given to [`Session::new`], verified on every handshake.
    expected: Option<&'static ModelProfile>,
    cfg: SessionConfig,
    stage: Stage,
    framer: StatusFramer,
    last_status: Option<Status>,
    transmit: VecDeque<Vec<u8>>,
    events: VecDeque<Event>,
    deadline: Option<u64>,
    job: Option<EncodedJob>,
}

impl Session {
    /// Creates a session. `profile = None` detects the model from the first status
    /// (`st[3]`/`st[4]`); `Some` additionally verifies it ([`Error::UnknownModel`] on mismatch).
    #[must_use]
    pub fn new(profile: Option<&'static ModelProfile>, cfg: SessionConfig) -> Self {
        Self {
            profile,
            expected: profile,
            cfg,
            stage: Stage::Idle { request: false },
            framer: StatusFramer::new(),
            last_status: None,
            transmit: VecDeque::new(),
            events: VecDeque::new(),
            deadline: None,
            job: None,
        }
    }

    /// Starts (or restarts) the handshake: drains input, queues invalidate + `ESC @` +
    /// `ESC i a 01`, then (after `mode_switch_drain_ms`) `ESC i S`.
    ///
    /// Restarting during a job abandons it with [`Event::Failed`] ([`Error::Cancelled`]); the
    /// handshake's reset clears the printer's buffer. Bytes queued but not yet taken with
    /// [`Session::poll_transmit`] are dropped.
    pub fn connect(&mut self, now_ms: u64) {
        if let Stage::Printing(run) = &self.stage {
            let resume = run.resume_page();
            self.events.push_back(Event::Failed {
                error: Error::Cancelled,
                resume_from_page: Some(resume),
            });
        }
        self.job = None;
        self.transmit.clear();
        self.framer.clear();
        self.profile = self.expected;
        self.start_attempt(1, now_ms);
    }

    /// Queues `ESC i S` while idle/ready.
    ///
    /// The reply arrives as [`Event::Status`] (and updates [`Session::last_status`]); without
    /// a reply within `status_timeout_ms` the session emits [`Event::Failed`] with
    /// [`TimeoutKind::Status`] and stays where it was. Calling it while draining after a job
    /// ends the drain.
    ///
    /// # Errors
    /// [`Error::Busy`] while handshaking, printing or recovering, and in
    /// [`SessionState::Failed`].
    pub fn request_status(&mut self, now_ms: u64) -> Result<(), Error> {
        match self.stage {
            Stage::Idle { .. } => self.stage = Stage::Idle { request: true },
            Stage::Ready { .. } | Stage::Draining { .. } => {
                self.stage = Stage::Ready { request: true }
            }
            Stage::Handshake { .. } | Stage::Printing(_) | Stage::Recovering(_) | Stage::Failed => {
                return Err(Error::Busy);
            }
        }
        self.transmit.push_back(STATUS_REQUEST.to_vec());
        self.deadline = Some(now_ms.saturating_add(self.cfg.status_timeout_ms));
        Ok(())
    }

    /// Submits an encoded job after preflight against the last status.
    ///
    /// # Errors
    /// [`Error::Busy`] unless [`SessionState::Ready`]; preflight errors
    /// ([`Error::Printer`], [`Error::NoMedia`], [`Error::NotReady`], [`Error::MediaMismatch`],
    /// [`Error::UnknownModel`], [`Error::Unsupported`] for a high-resolution job on tape that
    /// is not laminated TZe); [`Error::Empty`] for a job without pages; [`Error::InvalidInput`]
    /// for more than [`crate::encode::MAX_PAGES`] pages or a `page_lines` that does not match
    /// `pages`.
    pub fn submit(&mut self, mut job: EncodedJob, now_ms: u64) -> Result<(), Error> {
        if !matches!(self.stage, Stage::Ready { .. }) {
            return Err(Error::Busy);
        }
        if job.pages.is_empty() {
            return Err(Error::Empty);
        }
        if job.pages.len() > crate::encode::MAX_PAGES {
            return Err(Error::InvalidInput(
                "too many pages in one job (maximum 65535)",
            ));
        }
        if job.page_lines.len() != job.pages.len() {
            return Err(Error::InvalidInput("page_lines does not match pages"));
        }
        let (Some(profile), Some(status)) = (self.profile, self.last_status.as_ref()) else {
            return Err(Error::NotReady);
        };
        if job.model != profile.model {
            return Err(Error::UnknownModel {
                series: status.series_code,
                model: status.model_code,
            });
        }
        preflight(status, &job)?;

        let push = match push_kind(profile.model) {
            PushKind::Always => true,
            PushKind::AfterNotify => job_enables_notify(&job),
            PushKind::Unconfirmed => false,
        };
        let of = job.page_count();
        let t_est = self
            .cfg
            .page_time_ms(job.page_lines.first().copied().unwrap_or(0));
        let mut first = core::mem::take(&mut job.preamble);
        if let Some(page) = job.pages.first_mut() {
            first.append(page);
        }
        self.transmit.push_back(first);
        self.job = Some(job);
        let run = PrintRun::new(of, push, t_est, now_ms);
        self.arm_printing(&run);
        self.stage = Stage::Printing(run);
        Ok(())
    }

    /// Cancels the current job (or resets an idle printer): queues the model's cancel
    /// sequence and enters [`SessionState::Recovering`]. Pages already queued for transmit but
    /// not yet taken are dropped.
    ///
    /// A cancelled job ends with [`Event::Failed`] ([`Error::Cancelled`], with the §6.10 resume
    /// page). Cancelling a handshake returns to [`SessionState::Idle`]; cancelling while idle
    /// only queues the reset; it is a no-op while recovering or failed.
    pub fn cancel(&mut self, now_ms: u64) {
        match &self.stage {
            Stage::Printing(run) => {
                let resume = run.resume_page();
                self.events.push_back(Event::Failed {
                    error: Error::Cancelled,
                    resume_from_page: Some(resume),
                });
                self.enter_recovery(now_ms);
            }
            Stage::Ready { .. } | Stage::Draining { .. } => self.enter_recovery(now_ms),
            Stage::Handshake { .. } => {
                self.transmit.clear();
                self.events.push_back(Event::Failed {
                    error: Error::Cancelled,
                    resume_from_page: None,
                });
                self.stage = Stage::Idle { request: false };
                self.deadline = None;
            }
            Stage::Idle { .. } => {
                self.transmit.clear();
                let reset = self.reset_bytes();
                self.transmit.push_back(reset);
            }
            Stage::Recovering(_) | Stage::Failed => {}
        }
    }

    /// Feeds received bytes.
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: u64) {
        if let Stage::Handshake {
            awaiting: false, ..
        } = self.stage
        {
            // Draining after the mode switch: unsolicited frames are thrown away (§6.1 step 3).
            return;
        }
        self.framer.push(bytes);
        while let Some(frame) = self.framer.next_frame() {
            // A frame with a header that does not parse has already been skipped by the
            // framer; nothing else to do.
            if let Ok(status) = frame {
                self.on_frame(status, now_ms);
            }
        }
    }

    /// Advances timers; call when `now_ms ≥ poll_timeout()`.
    pub fn handle_timeout(&mut self, now_ms: u64) {
        if self.deadline.is_none_or(|d| now_ms < d) {
            return;
        }
        self.deadline = None;
        match self.stage.clone() {
            Stage::Idle { request: true } => {
                self.stage = Stage::Idle { request: false };
                self.status_timed_out();
            }
            Stage::Ready { request: true } => {
                self.stage = Stage::Ready { request: false };
                self.status_timed_out();
            }
            Stage::Idle { request: false } | Stage::Ready { request: false } | Stage::Failed => {}
            Stage::Handshake {
                attempt,
                awaiting: false,
            } => {
                self.framer.clear();
                self.transmit.push_back(STATUS_REQUEST.to_vec());
                self.stage = Stage::Handshake {
                    attempt,
                    awaiting: true,
                };
                self.deadline = Some(now_ms.saturating_add(self.cfg.status_timeout_ms));
            }
            Stage::Handshake {
                attempt,
                awaiting: true,
            } => {
                if attempt < self.cfg.status_attempts {
                    self.start_attempt(attempt.saturating_add(1), now_ms);
                } else {
                    self.fail(Error::Timeout(TimeoutKind::Handshake), None);
                }
            }
            Stage::Printing(run) => self.printing_timeout(run, now_ms),
            Stage::Draining { .. } => self.stage = Stage::Ready { request: false },
            Stage::Recovering(rec) => self.recovery_timeout(rec, now_ms),
        }
    }

    /// Next buffer to write, in order.
    pub fn poll_transmit(&mut self) -> Option<Vec<u8>> {
        self.transmit.pop_front()
    }

    /// Next event.
    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Absolute deadline (ms) at which [`Session::handle_timeout`] must be called.
    #[must_use]
    pub fn poll_timeout(&self) -> Option<u64> {
        self.deadline
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> SessionState {
        match &self.stage {
            Stage::Idle { .. } => SessionState::Idle,
            Stage::Handshake { attempt, .. } => SessionState::Handshaking { attempt: *attempt },
            Stage::Ready { .. } => SessionState::Ready,
            Stage::Printing(run) => SessionState::Printing {
                page: run.page,
                of: run.of,
            },
            Stage::Draining { .. } => SessionState::Draining,
            Stage::Recovering(_) => SessionState::Recovering,
            Stage::Failed => SessionState::Failed,
        }
    }

    /// Last successfully parsed status.
    #[must_use]
    pub fn last_status(&self) -> Option<&Status> {
        self.last_status.as_ref()
    }

    /// Model profile (given or detected).
    #[must_use]
    pub fn profile(&self) -> Option<&'static ModelProfile> {
        self.profile
    }

    /// The configuration.
    #[must_use]
    pub fn config(&self) -> &SessionConfig {
        &self.cfg
    }

    // ----- internals -----

    /// Queues the handshake bytes of attempt `attempt` and starts the drain.
    fn start_attempt(&mut self, attempt: u8, now: u64) {
        let bytes = match self.expected {
            Some(p) => handshake_sequence(p),
            None => generic_handshake_sequence(),
        };
        self.transmit.push_back(bytes);
        self.stage = Stage::Handshake {
            attempt,
            awaiting: false,
        };
        self.deadline = Some(now.saturating_add(self.cfg.mode_switch_drain_ms));
    }

    /// Enters [`SessionState::Failed`] and reports `error`.
    fn fail(&mut self, error: Error, resume_from_page: Option<u16>) {
        self.stage = Stage::Failed;
        self.deadline = None;
        self.job = None;
        self.events.push_back(Event::Failed {
            error,
            resume_from_page,
        });
    }

    fn status_timed_out(&mut self) {
        self.events.push_back(Event::Failed {
            error: Error::Timeout(TimeoutKind::Status),
            resume_from_page: None,
        });
    }

    /// Invalidate + reset for the known model, or a generous generic one.
    fn reset_bytes(&self) -> Vec<u8> {
        match self.profile {
            Some(p) => cancel_sequence(p),
            None => {
                let mut v = vec![0u8; 200];
                v.extend_from_slice(&[0x1B, 0x40]);
                v
            }
        }
    }

    /// Drops the job and queued bytes, queues the cancel sequence and starts recovery
    /// (PROTOCOL.md §6.10).
    fn enter_recovery(&mut self, now: u64) {
        self.job = None;
        self.transmit.clear();
        let reset = self.reset_bytes();
        self.transmit.push_back(reset);
        self.stage = Stage::Recovering(Recovery::default());
        self.deadline = Some(now.saturating_add(self.cfg.mode_switch_drain_ms));
    }

    fn on_frame(&mut self, status: Status, now: u64) {
        self.last_status = Some(status.clone());
        self.events.push_back(Event::Status(status.clone()));
        if status.status_type == StatusType::Notification {
            self.events
                .push_back(Event::Notification(status.notification));
        }
        if status.status_type == StatusType::TurnedOff {
            // Fatal in every state but Idle/Failed (PROTOCOL.md §4.2, §6.8 step 3).
            let resume = match &self.stage {
                Stage::Idle { .. } | Stage::Failed => return,
                Stage::Printing(run) => Some(run.resume_page()),
                Stage::Draining { resume } => Some(*resume),
                Stage::Handshake { .. } | Stage::Ready { .. } | Stage::Recovering(_) => None,
            };
            self.fail(Error::PrinterOff, resume);
            return;
        }
        match self.stage.clone() {
            Stage::Idle { request } => {
                if request && status.status_type == StatusType::Reply {
                    self.stage = Stage::Idle { request: false };
                    self.deadline = None;
                }
            }
            Stage::Ready { request } => {
                if request && status.status_type == StatusType::Reply {
                    self.stage = Stage::Ready { request: false };
                    self.deadline = None;
                }
            }
            Stage::Handshake { awaiting, .. } => {
                let answer =
                    status.status_type == StatusType::Reply || status.status_type.is_error();
                if awaiting && answer {
                    self.finish_handshake(&status);
                }
            }
            Stage::Printing(run) => self.printing_frame(run, &status, now),
            Stage::Draining { resume } => {
                // The last label may still be feeding or being cut (`01` does not mean it
                // left the printer, PROTOCOL.md §6.10): an error now still fails the job.
                if status.is_error() {
                    self.events.push_back(Event::Failed {
                        error: frame_error(&status),
                        resume_from_page: Some(resume),
                    });
                    self.enter_recovery(now);
                }
            }
            Stage::Failed => {}
            Stage::Recovering(mut rec) => {
                if rec.awaiting && status.status_type == StatusType::Reply {
                    if status.is_ready() {
                        self.stage = Stage::Ready { request: false };
                        self.deadline = None;
                        self.events.push_back(Event::Ready(status));
                    } else {
                        rec.replied = true;
                        self.stage = Stage::Recovering(rec);
                    }
                }
            }
        }
    }

    /// Validates the model of the first status (PROTOCOL.md §6.1 step 5).
    fn finish_handshake(&mut self, status: &Status) {
        let detected = match self.expected {
            Some(p) if p.series_code == status.series_code && p.model_code == status.model_code => {
                Some(p)
            }
            Some(_) => None,
            None => profile_by_codes(status.series_code, status.model_code),
        };
        let Some(profile) = detected else {
            self.fail(
                Error::UnknownModel {
                    series: status.series_code,
                    model: status.model_code,
                },
                None,
            );
            return;
        };
        self.profile = Some(profile);
        self.stage = Stage::Ready { request: false };
        self.deadline = None;
        self.events.push_back(Event::Ready(status.clone()));
    }

    /// One frame while a page is in flight (PROTOCOL.md §6.8 step 3 table).
    fn printing_frame(&mut self, mut run: PrintRun, status: &Status, now: u64) {
        let reply = status.status_type == StatusType::Reply;
        if !reply && !run.push {
            // A pushed frame on a polled job: switch to the push rule for the rest of the job.
            run.push = true;
            run.polling = false;
        }
        if status.is_error() {
            self.events.push_back(Event::Failed {
                error: frame_error(status),
                resume_from_page: Some(run.resume_page()),
            });
            self.enter_recovery(now);
            return;
        }
        match status.status_type {
            StatusType::Notification => match status.notification {
                Notification::CoolingStarted => {
                    if !run.cooling {
                        run.consumed = run
                            .consumed
                            .saturating_add(now.saturating_sub(run.clock_start));
                        run.cooling = true;
                    }
                    run.next_tick = now.saturating_add(self.cfg.poll_interval_ms);
                }
                Notification::CoolingFinished => {
                    if run.cooling {
                        run.stop_cooling(now);
                        if run.step == PageStep::Completed {
                            // Restart the wait for the trailing phase-change frame.
                            run.completed_at = now;
                        }
                    }
                }
                _ => run.touch(now),
            },
            StatusType::PhaseChange => match status.phase {
                Phase::Printing(_) => {
                    if run.step == PageStep::Sent {
                        // The first "printing" frame of a page: a cooling pause carried over
                        // from the previous page is over.
                        run.stop_cooling(now);
                    }
                    self.mark_printing(&mut run);
                    run.touch(now);
                }
                Phase::Receiving(_) if run.step != PageStep::Sent => {
                    self.page_done(run, now);
                    return;
                }
                _ => run.touch(now),
            },
            StatusType::PrintingCompleted => {
                if run.step != PageStep::Completed {
                    self.emit_completed(&mut run);
                    if self.page_command() == PageCommand::StartEnd {
                        run.step = PageStep::Completed;
                        run.completed_at = now;
                    } else {
                        self.page_done(run, now);
                        return;
                    }
                }
            }
            StatusType::Reply => {
                // Only a reply to our own poll counts; a late reply to an earlier request is
                // informational.
                if run.awaiting_reply {
                    run.awaiting_reply = false;
                    if status.is_ready() {
                        self.page_done(run, now);
                        return;
                    }
                    if matches!(status.phase, Phase::Printing(_)) {
                        self.mark_printing(&mut run);
                    }
                    run.next_tick = now.saturating_add(self.cfg.poll_interval_ms);
                }
            }
            _ => run.touch(now),
        }
        self.arm_printing(&run);
        self.stage = Stage::Printing(run);
    }

    fn page_command(&self) -> PageCommand {
        self.profile
            .map_or(PageCommand::StartEnd, |p| p.page_command)
    }

    fn mark_printing(&mut self, run: &mut PrintRun) {
        if run.step == PageStep::Sent {
            run.step = PageStep::Printing;
        }
        run.resume = Some(run.page);
        if !run.started_event {
            run.started_event = true;
            self.events.push_back(Event::PageStarted { page: run.page });
        }
    }

    fn emit_completed(&mut self, run: &mut PrintRun) {
        if !run.started_event {
            run.started_event = true;
            self.events.push_back(Event::PageStarted { page: run.page });
        }
        if !run.completed_event {
            run.completed_event = true;
            self.events
                .push_back(Event::PageCompleted { page: run.page });
        }
    }

    /// The page in flight is done: send the next one, or finish the job.
    fn page_done(&mut self, mut run: PrintRun, now: u64) {
        self.emit_completed(&mut run);
        let next = usize::from(run.page);
        let mut job = self.job.take();
        if run.page < run.of
            && let Some(j) = job.as_mut()
        {
            let bytes = j
                .pages
                .get_mut(next)
                .map(core::mem::take)
                .unwrap_or_default();
            let lines = j.page_lines.get(next).copied().unwrap_or(0);
            self.transmit.push_back(bytes);
            run.next_page(self.cfg.page_time_ms(lines), now);
            self.job = job;
            self.arm_printing(&run);
            self.stage = Stage::Printing(run);
            return;
        }
        if let Some(epilogue) = job.map(|j| j.epilogue)
            && !epilogue.is_empty()
        {
            self.transmit.push_back(epilogue);
        }
        self.events.push_back(Event::JobCompleted);
        self.stage = Stage::Draining {
            resume: run.resume.unwrap_or(run.page),
        };
        self.deadline = Some(now.saturating_add(self.cfg.post_job_drain_ms));
    }

    /// Sets the deadline for the page in flight.
    fn arm_printing(&mut self, run: &PrintRun) {
        let cfg = &self.cfg;
        // Cooling first: the next page is never released while the printer cools (§6.8).
        let deadline = if run.cooling {
            run.next_tick
        } else if run.step == PageStep::Completed {
            run.completed_at.saturating_add(cfg.phase_frame_wait_ms)
        } else if run.polling {
            run.next_tick
        } else {
            let budget = if run.push {
                run.t_est.saturating_add(cfg.page_margin_ms)
            } else {
                run.t_est
            };
            run.clock_start
                .saturating_add(budget.saturating_sub(run.consumed))
        };
        self.deadline = Some(deadline);
    }

    fn printing_timeout(&mut self, mut run: PrintRun, now: u64) {
        if run.cooling {
            // No limit while cooling (PROTOCOL.md §6.8 step 3); just keep ticking.
            run.next_tick = now.saturating_add(self.cfg.poll_interval_ms);
        } else if run.step == PageStep::Completed {
            // The trailing phase change did not come; "printing completed" is enough.
            self.page_done(run, now);
            return;
        } else if run.push || run.ticks >= self.cfg.max_ticks {
            self.events.push_back(Event::Failed {
                error: Error::Timeout(TimeoutKind::Page { page: run.page }),
                resume_from_page: Some(run.resume_page()),
            });
            self.enter_recovery(now);
            return;
        } else {
            // Poll fallback: T_est elapsed (first poll) or a tick without data.
            run.polling = true;
            run.awaiting_reply = true;
            run.ticks = run.ticks.saturating_add(1);
            run.next_tick = now.saturating_add(self.cfg.poll_interval_ms);
            self.transmit.push_back(STATUS_REQUEST.to_vec());
        }
        self.arm_printing(&run);
        self.stage = Stage::Printing(run);
    }

    fn recovery_timeout(&mut self, mut rec: Recovery, now: u64) {
        if rec.awaiting {
            rec.silent = if rec.replied {
                0
            } else {
                rec.silent.saturating_add(1)
            };
            if rec.silent >= self.cfg.status_attempts.max(1) {
                self.fail(Error::Timeout(TimeoutKind::Status), None);
                return;
            }
            if rec.polls >= self.cfg.max_ticks {
                self.fail(Error::NotReady, None);
                return;
            }
        }
        rec.awaiting = true;
        rec.replied = false;
        rec.polls = rec.polls.saturating_add(1);
        self.transmit.push_back(STATUS_REQUEST.to_vec());
        self.stage = Stage::Recovering(rec);
        self.deadline = Some(now.saturating_add(self.cfg.status_timeout_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job_with(preamble: &[u8], page: &[u8]) -> EncodedJob {
        EncodedJob {
            model: Model::PtP710bt,
            media_width_byte: 24,
            media_type_byte: 1,
            high_resolution: false,
            preamble: preamble.to_vec(),
            pages: vec![page.to_vec()],
            page_lines: vec![1],
            epilogue: Vec::new(),
        }
    }

    #[test]
    fn notify_detection_stops_at_print_info() {
        let pre = [0x00, 0x00, 0x1B, 0x40];
        let on = [
            0x1B, 0x69, 0x61, 0x01, 0x1B, 0x69, 0x21, 0x00, 0x1B, 0x69, 0x7A,
        ];
        assert!(job_enables_notify(&job_with(&pre, &on)));
        let off = [
            0x1B, 0x69, 0x61, 0x01, 0x1B, 0x69, 0x21, 0x01, 0x1B, 0x69, 0x7A,
        ];
        assert!(!job_enables_notify(&job_with(&pre, &off)));
        // After ESC i z the bytes are raster data and never count.
        let late = [0x1B, 0x69, 0x7A, 0x1B, 0x69, 0x21, 0x00];
        assert!(!job_enables_notify(&job_with(&pre, &late)));
        // In the preamble.
        assert!(job_enables_notify(&job_with(&on, &[])));
    }

    #[test]
    fn geometry_keys() {
        assert!(same_geometry(0x01, 0x01));
        assert!(same_geometry(0x01, 0x03));
        assert!(same_geometry(0x14, 0x01));
        assert!(same_geometry(0x16, 0x01));
        assert!(!same_geometry(0x11, 0x01));
        assert!(!same_geometry(0x11, 0x17));
        assert!(same_geometry(0x13, 0x13));
    }

    #[test]
    fn push_classification() {
        assert_eq!(push_kind(Model::PtP710bt), PushKind::AfterNotify);
        assert_eq!(push_kind(Model::PtP300bt), PushKind::Always);
        assert_eq!(push_kind(Model::PtE560bt), PushKind::Unconfirmed);
        assert_eq!(push_kind(Model::PtD610bt), PushKind::Unconfirmed);
    }
}
