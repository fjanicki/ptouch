//! Blocking driver loop: runs a sans-IO [`ptouch::Session`] over a
//! [`ptouch_transport::Transport`].
//!
//! # Contract (ARCHITECTURE.md §4.3 "Pump", §5.4–§5.5)
//! - Clock: `now_ms` = milliseconds since the driver was created (`Instant`, monotonic).
//! - Pump step: drain `poll_transmit()` → `transport.write_all` (in order, sequential); drain
//!   `poll_event()` → returned/logged; read with timeout = `poll_timeout() − now` (capped at
//!   200 ms so Ctrl-C stays responsive); bytes → `handle_input`, timeout →
//!   `handle_timeout`.
//! - Ctrl-C ([`crate::interrupt`]) is checked on every pump step: a job in progress is
//!   cancelled through the session (its cancel sequence is sent, the resume page reported as
//!   [`CliError::JobFailed`] with [`ptouch::Error::Cancelled`]); any other wait ends with
//!   [`CliError::Interrupted`]. The transport is then closed normally.
//! - A failed job always reports its resume page: errors while sending the cancel sequence are
//!   ignored, and a transport failure mid-job becomes [`CliError::LinkLost`] with the page in
//!   flight. Errors the printer reports right after the last page (while the session drains)
//!   still fail the job.
//! - Closing waits [`ERROR_CLOSE_WAIT`] after a failure (PROTOCOL.md §2.1 "Timing": 3 s after an
//!   error; the transport itself waits the first 500 ms).
//! - `connect()` runs until `Event::Ready` or `Event::Failed`; `print()` until
//!   `Event::JobCompleted` or `Event::Failed`, calling `on_progress` for page events.
//! - Verbose logging prints `>> ` / `<< ` hex lines to stderr (never the user's BT address).
//! - No protocol decisions here: anything that needs one belongs in the session. The only
//!   local policy is a generous wall-clock safety net ([`CliError::Stalled`]) in case the
//!   session ever stops scheduling timeouts.

use std::time::{Duration, Instant};

use ptouch::{EncodedJob, Event, Notification, Session, SessionConfig, SessionState, Status};
use ptouch_transport::Transport;

use crate::error::CliError;

/// Longest single read wait, so the loop stays responsive.
const MAX_READ_WAIT_MS: u64 = 200;
/// Bytes shown per logged buffer at `-v` (whole buffers at `-vvv`).
const LOG_BYTES: usize = 48;
/// Extra wait after closing a link that saw an error, on top of the transport's own 500 ms
/// close wait (PROTOCOL.md §2.1 "Timing": 3 s after an error).
pub const ERROR_CLOSE_WAIT: Duration = Duration::from_millis(2_500);

/// Page progress callback payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    /// Page bytes handed to the transport.
    Sent {
        /// 1-based page.
        page: u16,
        /// Total pages.
        of: u16,
    },
    /// Printer reported the page printing.
    Printing {
        /// 1-based page.
        page: u16,
    },
    /// Printer reported the page done.
    Done {
        /// 1-based page.
        page: u16,
    },
    /// The printer pushed a notification (cooling, cover…).
    Notice(Notification),
}

/// Session + transport + clock.
pub struct Driver<T: Transport> {
    transport: T,
    session: Session,
    start: Instant,
    verbose: u8,
    /// Last page for which [`Progress::Sent`] was reported.
    sent_page: u16,
    /// `Sent` progress noticed while writing, delivered by `print`.
    pending_sent: Vec<Progress>,
    /// Ctrl-C source ([`crate::interrupt::requested`]; replaceable in tests).
    interrupt: fn() -> bool,
    /// The interrupt has been acted on (cancel sent or error returned) and is not re-raised.
    interrupt_handled: bool,
    /// A job or the link failed: wait `error_close_wait` after closing.
    failed: bool,
    /// [`ERROR_CLOSE_WAIT`] (zero in tests).
    error_close_wait: Duration,
}

impl<T: Transport> Driver<T> {
    /// Wraps an open transport.
    pub fn new(
        transport: T,
        profile: Option<&'static ptouch::ModelProfile>,
        cfg: SessionConfig,
        verbose: u8,
    ) -> Self {
        Self {
            transport,
            session: Session::new(profile, cfg),
            start: Instant::now(),
            verbose,
            sent_page: 0,
            pending_sent: Vec::new(),
            interrupt: crate::interrupt::requested,
            interrupt_handled: false,
            failed: false,
            error_close_wait: ERROR_CLOSE_WAIT,
        }
    }

    /// Handshake; returns the first valid status.
    ///
    /// # Errors
    /// The session's handshake failure (e.g. [`ptouch::Error::Timeout`]), transport errors.
    pub fn connect(&mut self) -> Result<Status, CliError> {
        let now = self.now_ms();
        self.session.connect(now);
        let limit = self.safety_limit_ms(true);
        loop {
            for ev in self.pump()? {
                match ev {
                    Event::Ready(st) => return Ok(st),
                    Event::Failed { error, .. } => return Err(error.into()),
                    _ => {}
                }
            }
            self.check_stalled(now, limit, "the connection handshake")?;
        }
    }

    /// Fresh status (idle only).
    ///
    /// # Errors
    /// [`ptouch::Error::Busy`] while a job runs, timeouts, transport errors.
    pub fn status(&mut self) -> Result<Status, CliError> {
        let now = self.now_ms();
        self.session.request_status(now)?;
        let limit = self.safety_limit_ms(false);
        loop {
            for ev in self.pump()? {
                match ev {
                    Event::Status(st) => return Ok(st),
                    Event::Failed { error, .. } => return Err(error.into()),
                    _ => {}
                }
            }
            self.check_stalled(now, limit, "the status request")?;
        }
    }

    /// Submits and paces a job to completion.
    ///
    /// # Errors
    /// Preflight errors from [`Session::submit`], [`CliError::JobFailed`] when the printer
    /// reports an error mid-job, transport errors.
    pub fn print(
        &mut self,
        job: EncodedJob,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), CliError> {
        let pages = job.page_count();
        let now = self.now_ms();
        self.sent_page = 0;
        self.pending_sent.clear();
        self.session.submit(job, now)?;
        loop {
            let events = match self.pump() {
                Ok(events) => events,
                Err(e) => return Err(self.job_error(e, pages)),
            };
            for p in self.pending_sent.drain(..) {
                on_progress(p);
            }
            let mut events = events.into_iter();
            while let Some(ev) = events.next() {
                match ev {
                    Event::PageStarted { page } => on_progress(Progress::Printing { page }),
                    Event::PageCompleted { page } => on_progress(Progress::Done { page }),
                    Event::Notification(n) => on_progress(Progress::Notice(n)),
                    Event::JobCompleted => {
                        // The last label may still be fed out or cut: an error the printer
                        // reports while the session drains still fails the job. A link
                        // failure after completion does not (every page printed).
                        let mut late: Vec<Event> = events.collect();
                        late.extend(self.finish_drain().unwrap_or_default());
                        if let Some((error, resume_from_page)) = first_failure(late) {
                            return Err(CliError::JobFailed {
                                error,
                                resume_from_page,
                                pages,
                            });
                        }
                        return Ok(());
                    }
                    Event::Failed {
                        error,
                        resume_from_page,
                    } => {
                        // Let the session send its cancel sequence before we give up; a link
                        // that fails meanwhile must not hide the resume page.
                        let _ = self.finish_drain();
                        return Err(CliError::JobFailed {
                            error,
                            resume_from_page,
                            pages,
                        });
                    }
                    _ => {}
                }
            }
            // No wall-clock limit here: the session owns the (long, cooling-aware) page
            // timeouts of PROTOCOL.md §6.8.
        }
    }

    /// The session (for `last_status`, `profile`).
    pub fn session(&self) -> &Session {
        &self.session
    }

    /// Closes the transport (after a failure, dropping the driver then waits
    /// [`ERROR_CLOSE_WAIT`]).
    ///
    /// # Errors
    /// Transport teardown failures.
    pub fn close(mut self) -> Result<(), CliError> {
        self.transport.close().map_err(CliError::from)
    }

    /// A pump error during a job: a transport failure while a page is in flight keeps the
    /// page to resume from (PROTOCOL.md §2.1: never re-send a partial job blindly).
    fn job_error(&mut self, e: CliError, pages: u16) -> CliError {
        self.failed = true;
        // The session may already have reported the job's failure (e.g. a printer error whose
        // cancel sequence could not be written): that report wins and keeps its resume page.
        if let Some((error, resume_from_page)) = first_failure(self.drain_events()) {
            return CliError::JobFailed {
                error,
                resume_from_page,
                pages,
            };
        }
        match (e, self.session.state()) {
            (CliError::Transport(source), SessionState::Printing { page, .. }) => {
                CliError::LinkLost {
                    source,
                    resume_from_page: Some(page),
                    pages,
                }
            }
            (e, _) => e,
        }
    }

    /// One pump step (see module docs); returns the events produced.
    fn pump(&mut self) -> Result<Vec<Event>, CliError> {
        if !self.interrupt_handled && (self.interrupt)() {
            self.interrupt_handled = true;
            self.failed = true;
            if matches!(self.session.state(), SessionState::Printing { .. }) {
                // The session queues its cancel sequence and reports Failed(Cancelled) with
                // the resume page; the caller then drains the recovery as for any failure.
                let now = self.now_ms();
                self.session.cancel(now);
            } else {
                return Err(CliError::Interrupted);
            }
        }
        let result = self.pump_inner();
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn pump_inner(&mut self) -> Result<Vec<Event>, CliError> {
        self.flush_transmit()?;
        let mut events = self.drain_events();
        if !events.is_empty() {
            return Ok(events);
        }

        let now = self.now_ms();
        let wait = self
            .session
            .poll_timeout()
            .map_or(MAX_READ_WAIT_MS, |d| d.saturating_sub(now))
            .min(MAX_READ_WAIT_MS);
        let mut buf = [0u8; 512];
        let n = self.transport.read(&mut buf, Duration::from_millis(wait))?;
        let now = self.now_ms();
        if let Some(bytes) = buf.get(..n).filter(|b| !b.is_empty()) {
            self.log("<<", bytes);
            self.session.handle_input(bytes, now);
        }
        if self.session.poll_timeout().is_some_and(|d| now >= d) {
            self.session.handle_timeout(now);
        }

        self.flush_transmit()?;
        events.extend(self.drain_events());
        Ok(events)
    }

    /// Writes every queued buffer, noting page transmissions for progress.
    fn flush_transmit(&mut self) -> Result<(), CliError> {
        while let Some(buf) = self.session.poll_transmit() {
            self.log(">>", &buf);
            self.transport.write_all(&buf)?;
            if let SessionState::Printing { page, of } = self.session.state()
                && page != self.sent_page
            {
                self.sent_page = page;
                self.pending_sent.push(Progress::Sent { page, of });
            }
        }
        Ok(())
    }

    fn drain_events(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        while let Some(ev) = self.session.poll_event() {
            if self.verbose >= 2 {
                eprintln!("[{:>7} ms] event {ev:?}", self.now_ms());
            }
            if matches!(ev, Event::Failed { .. }) {
                self.failed = true;
            }
            events.push(ev);
        }
        events
    }

    /// After the job: keep pumping while the session drains trailing frames / recovers, so
    /// the epilogue or cancel sequence reaches the printer before the link closes. Returns the
    /// events produced meanwhile.
    fn finish_drain(&mut self) -> Result<Vec<Event>, CliError> {
        let start = self.now_ms();
        let limit = self.safety_limit_ms(false);
        let mut events = Vec::new();
        while matches!(
            self.session.state(),
            SessionState::Draining | SessionState::Recovering
        ) && self.now_ms().saturating_sub(start) < limit
        {
            events.extend(self.pump()?);
        }
        self.flush_transmit()?;
        Ok(events)
    }

    /// Wall-clock safety net for a wait that the session should end by itself.
    fn safety_limit_ms(&self, handshake: bool) -> u64 {
        // The handshake may take `attempts × timeout` plus drains; add a generous margin.
        let per = 30_000u64;
        if handshake { per * 4 } else { per }
    }

    fn check_stalled(&self, since: u64, limit: u64, what: &'static str) -> Result<(), CliError> {
        if self.now_ms().saturating_sub(since) > limit {
            Err(CliError::Stalled(what))
        } else {
            Ok(())
        }
    }

    fn log(&self, dir: &str, bytes: &[u8]) {
        if self.verbose == 0 {
            return;
        }
        let shown = if self.verbose >= 3 {
            bytes
        } else {
            bytes.get(..LOG_BYTES).unwrap_or(bytes)
        };
        let mut line = hex(shown);
        if shown.len() < bytes.len() {
            line.push_str(&format!(" … ({} bytes)", bytes.len()));
        }
        eprintln!("[{:>7} ms] {dir} {line}", self.now_ms());
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

impl<T: Transport> Drop for Driver<T> {
    fn drop(&mut self) {
        // `close` is idempotent; closing here makes the error wait follow the close.
        let _ = self.transport.close();
        if self.failed {
            std::thread::sleep(self.error_close_wait);
        }
    }
}

/// The first [`Event::Failed`] among `events`.
fn first_failure(events: Vec<Event>) -> Option<(ptouch::Error, Option<u16>)> {
    events.into_iter().find_map(|ev| match ev {
        Event::Failed {
            error,
            resume_from_page,
        } => Some((error, resume_from_page)),
        _ => None,
    })
}

/// Space-separated upper-case hex.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02X}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};

    use ptouch::encode::JobOptions;
    use ptouch::{Bitmap, Model, TapeKind};
    use ptouch_transport::{TransportError, TransportInfo, TransportKind};

    use super::*;

    /// The real PT-P710BT idle reply.
    const FIXTURE: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];

    fn frame(status_type: u8, phase: u8, info2: u8) -> [u8; 32] {
        let mut f = FIXTURE;
        f[18] = status_type;
        f[19] = phase;
        f[9] = info2;
        f
    }

    /// What the scripted printer does with the n-th page write (0-based).
    type Script = Box<dyn FnMut(usize, &[u8], &mut VecDeque<u8>) -> Result<(), TransportError>>;

    /// Answers `ESC i S` with the fixture; hands every other write to `script`.
    struct Mock {
        inbox: VecDeque<u8>,
        writes: Vec<Vec<u8>>,
        page_writes: usize,
        script: Script,
        info: TransportInfo,
    }

    impl Mock {
        fn new(script: Script) -> Self {
            Self {
                inbox: VecDeque::new(),
                writes: Vec::new(),
                page_writes: 0,
                script,
                info: TransportInfo {
                    kind: TransportKind::Virtual,
                    label: "mock".into(),
                    max_write: None,
                },
            }
        }
    }

    impl Transport for Mock {
        fn write_all(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
            self.writes.push(bytes.to_vec());
            if bytes == ptouch::STATUS_REQUEST {
                self.inbox.extend(FIXTURE);
                return Ok(());
            }
            // Raster pages end with 0C / 1A; everything else (handshake, cancel) is control.
            if bytes.windows(3).any(|w| w == [0x1B, 0x69, 0x7A]) {
                let n = self.page_writes;
                self.page_writes += 1;
                return (self.script)(n, bytes, &mut self.inbox);
            }
            (self.script)(usize::MAX, bytes, &mut self.inbox)
        }

        fn read(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize, TransportError> {
            if self.inbox.is_empty() {
                std::thread::sleep(Duration::from_millis(1));
                return Ok(0);
            }
            let n = buf.len().min(self.inbox.len());
            for (d, s) in buf.iter_mut().zip(self.inbox.drain(..n)) {
                *d = s;
            }
            Ok(n)
        }

        fn close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }

        fn info(&self) -> &TransportInfo {
            &self.info
        }
    }

    fn p710() -> &'static ptouch::ModelProfile {
        ptouch::profile(Model::PtP710bt).unwrap()
    }

    fn driver(script: Script) -> Driver<Mock> {
        let mut d = Driver::new(Mock::new(script), Some(p710()), SessionConfig::default(), 0);
        d.interrupt = || false;
        d.error_close_wait = Duration::ZERO;
        d
    }

    fn three_pages() -> EncodedJob {
        let tape = ptouch::tape_spec(p710(), 24, TapeKind::Tze).unwrap();
        let page = Bitmap::new(40, tape.print_pins);
        ptouch::encode_job(p710(), tape, &[&page, &page, &page], &JobOptions::default()).unwrap()
    }

    fn page_done(inbox: &mut VecDeque<u8>) {
        inbox.extend(frame(0x06, 0x01, 0)); // printing
        inbox.extend(frame(0x01, 0x00, 0)); // printing completed
        inbox.extend(frame(0x06, 0x00, 0)); // back to receiving
    }

    #[test]
    fn failed_job_keeps_resume_page_when_the_cancel_write_fails() {
        let mut d = driver(Box::new(|n, bytes, inbox| match n {
            0 => {
                page_done(inbox);
                Ok(())
            }
            1 => {
                inbox.extend(frame(0x02, 0x00, 0x10)); // cover open
                Ok(())
            }
            usize::MAX if bytes.len() == 102 => Err(TransportError::Closed), // cancel write
            _ => Ok(()),
        }));
        d.connect().unwrap();
        let err = d.print(three_pages(), &mut |_| {}).unwrap_err();
        assert!(
            matches!(
                err,
                CliError::JobFailed {
                    resume_from_page: Some(_),
                    pages: 3,
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[test]
    fn link_loss_mid_job_reports_the_page_in_flight() {
        let mut d = driver(Box::new(|n, _, inbox| match n {
            0 => {
                page_done(inbox);
                Ok(())
            }
            1 => Err(TransportError::Closed),
            _ => Ok(()),
        }));
        d.connect().unwrap();
        let err = d.print(three_pages(), &mut |_| {}).unwrap_err();
        assert!(
            matches!(
                err,
                CliError::LinkLost {
                    resume_from_page: Some(2),
                    pages: 3,
                    ..
                }
            ),
            "{err:?}"
        );
        assert!(err.to_string().contains("--from-page 2"), "{err}");
    }

    #[test]
    fn error_right_after_the_last_page_fails_the_job() {
        let mut d = driver(Box::new(|n, _, inbox| {
            if n == 0 {
                page_done(inbox);
                inbox.extend(frame(0x02, 0x00, 0x04)); // e.g. cutter jam while cutting
            }
            Ok(())
        }));
        d.connect().unwrap();
        let tape = ptouch::tape_spec(p710(), 24, TapeKind::Tze).unwrap();
        let page = Bitmap::new(40, tape.print_pins);
        let job = ptouch::encode_job(p710(), tape, &[&page], &JobOptions::default()).unwrap();
        let err = d.print(job, &mut |_| {}).unwrap_err();
        assert!(matches!(err, CliError::JobFailed { .. }), "{err:?}");
    }

    static PRINT_INTERRUPT: AtomicBool = AtomicBool::new(false);

    #[test]
    fn ctrl_c_cancels_the_job_and_sends_the_cancel_sequence() {
        let mut d = driver(Box::new(|n, bytes, inbox| {
            if n == 0 {
                // Page 1 is printing when the user presses Ctrl-C.
                inbox.extend(frame(0x06, 0x01, 0));
                PRINT_INTERRUPT.store(true, Ordering::SeqCst);
            }
            if n == usize::MAX && bytes.len() == 102 {
                inbox.extend(FIXTURE); // ready again after the cancel
            }
            Ok(())
        }));
        d.interrupt = || PRINT_INTERRUPT.load(Ordering::SeqCst);
        d.connect().unwrap();
        let err = d.print(three_pages(), &mut |_| {}).unwrap_err();
        assert!(
            matches!(
                err,
                CliError::JobFailed {
                    error: ptouch::Error::Cancelled,
                    resume_from_page: Some(1),
                    ..
                }
            ),
            "{err:?}"
        );
        let cancel: Vec<u8> = [vec![0u8; 100], vec![0x1B, 0x40]].concat();
        assert!(d.transport.writes.contains(&cancel), "cancel sequence sent");
        assert!(d.failed);
    }

    #[test]
    fn ctrl_c_outside_a_job_returns_interrupted() {
        let mut d = driver(Box::new(|_, _, _| Ok(())));
        d.interrupt = || true;
        assert!(matches!(d.connect(), Err(CliError::Interrupted)));
    }

    #[test]
    fn hex_formatting() {
        assert_eq!(hex(&[0x80, 0x20, 0x42]), "80 20 42");
        assert_eq!(hex(&[]), "");
    }
}
