//! Session ⇄ VirtualPrinter conversations with a simulated clock (WP5, ARCHITECTURE.md §8.1).

// Test helpers outside `#[test]` fns are not covered by clippy's `allow-*-in-tests`;
// failing loudly is the point of a test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ptouch::encode::JobOptions;
use ptouch::virtual_printer::{Behaviour, VirtualPrinter, VirtualTiming};
use ptouch::{
    Bitmap, EncodedJob, Error, Event, Model, ModelProfile, Notification, Session, SessionConfig,
    SessionState, TapeSpec, TimeoutKind, encode_job, profile,
};

/// The real PT-P710BT reply (tests/fixtures/status/p710bt_24mm_laminated_idle.hex).
const FIXTURE: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

fn model(m: Model) -> &'static ModelProfile {
    profile(m).expect("model in table")
}

fn tape(p: &'static ModelProfile, width: u8) -> &'static TapeSpec {
    p.media
        .iter()
        .copied()
        .find(|t| t.media_width_byte == width && t.kind == ptouch::TapeKind::Tze)
        .expect("tape in table")
}

/// A recognisable page: a diagonal plus a page-specific bar.
fn page(t: &TapeSpec, length: u32, seed: u32) -> Bitmap {
    let h = u32::from(t.print_pins);
    Bitmap::from_fn(length, t.print_pins, |x, y| {
        let y = u32::from(y);
        y == x % h || (x + seed).is_multiple_of(7) || y == (seed * 5) % h
    })
}

fn job(
    p: &'static ModelProfile,
    t: &'static TapeSpec,
    pages: &[Bitmap],
    opts: &JobOptions,
) -> EncodedJob {
    let refs: Vec<&Bitmap> = pages.iter().collect();
    encode_job(p, t, &refs, opts).expect("encodes")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chunking {
    /// Everything due at the same instant in one read.
    Whole,
    /// Each frame split 7 + 25 (observed RFCOMM fragmentation).
    Split7,
    /// One byte per read.
    Bytes,
}

/// Drives a [`Session`] against a [`VirtualPrinter`] on a simulated clock.
struct Harness {
    s: Session,
    vp: VirtualPrinter,
    now: u64,
    chunking: Chunking,
    events: Vec<(u64, Event)>,
    sent: Vec<(u64, Vec<u8>)>,
}

impl Harness {
    fn new(expected: Option<&'static ModelProfile>, vp: VirtualPrinter) -> Self {
        Self::with_config(expected, vp, SessionConfig::default())
    }

    fn with_config(
        expected: Option<&'static ModelProfile>,
        vp: VirtualPrinter,
        cfg: SessionConfig,
    ) -> Self {
        Self {
            s: Session::new(expected, cfg),
            vp,
            now: 1_000,
            chunking: Chunking::Whole,
            events: Vec::new(),
            sent: Vec::new(),
        }
    }

    fn pump(&mut self) {
        while let Some(buf) = self.s.poll_transmit() {
            self.vp.handle_input(&buf, self.now);
            self.sent.push((self.now, buf));
        }
        while let Some(ev) = self.s.poll_event() {
            self.events.push((self.now, ev));
        }
    }

    fn deliver(&mut self, bytes: &[u8]) {
        match self.chunking {
            Chunking::Whole => self.s.handle_input(bytes, self.now),
            Chunking::Split7 => {
                for frame in bytes.chunks(32) {
                    let (a, b) = frame.split_at(frame.len().min(7));
                    self.s.handle_input(a, self.now);
                    self.s.handle_input(b, self.now);
                }
            }
            Chunking::Bytes => {
                for b in bytes {
                    self.s.handle_input(std::slice::from_ref(b), self.now);
                }
            }
        }
    }

    /// Advances to the next scheduled thing. `false` when nothing is pending.
    fn step(&mut self) -> bool {
        self.pump();
        let next = [self.vp.next_output_at(), self.s.poll_timeout()]
            .into_iter()
            .flatten()
            .min();
        let Some(next) = next else {
            return false;
        };
        self.now = self.now.max(next);
        let mut rx = Vec::new();
        while let Some(f) = self.vp.poll_output(self.now) {
            rx.extend_from_slice(&f);
        }
        if !rx.is_empty() {
            self.deliver(&rx);
        }
        if self.s.poll_timeout().is_some_and(|d| d <= self.now) {
            self.s.handle_timeout(self.now);
        }
        self.pump();
        true
    }

    /// Steps until an event matches (returns its time) or `limit_ms` of simulated time pass.
    fn run_until(&mut self, limit_ms: u64, pred: impl Fn(&Event) -> bool) -> Option<u64> {
        let end = self.now + limit_ms;
        let mut seen = self.events.len();
        loop {
            if let Some((t, _)) = self.events[seen..].iter().find(|(_, e)| pred(e)) {
                return Some(*t);
            }
            seen = self.events.len();
            if self.now > end || !self.step() {
                return None;
            }
        }
    }

    /// Runs until nothing is pending any more (or `limit_ms` passes).
    fn settle(&mut self, limit_ms: u64) {
        let end = self.now + limit_ms;
        while self.now <= end && self.step() {}
    }

    fn connect(&mut self) -> ptouch::Status {
        self.s.connect(self.now);
        self.run_until(30_000, |e| matches!(e, Event::Ready(_)))
            .expect("handshake completes");
        self.s.last_status().expect("status").clone()
    }

    fn events_only(&self) -> Vec<Event> {
        self.events.iter().map(|(_, e)| e.clone()).collect()
    }

    fn progress(&self) -> Vec<Event> {
        self.events_only()
            .into_iter()
            .filter(|e| !matches!(e, Event::Status(_) | Event::Notification(_)))
            .collect()
    }

    fn time_of(&self, pred: impl Fn(&Event) -> bool) -> Option<u64> {
        self.events.iter().find(|(_, e)| pred(e)).map(|(t, _)| *t)
    }

    fn status_requests_after(&self, t: u64) -> usize {
        self.sent
            .iter()
            .filter(|(at, b)| *at > t && b.as_slice() == ptouch::STATUS_REQUEST)
            .count()
    }
}

fn p710_printer(behaviour: Behaviour) -> VirtualPrinter {
    let p = model(Model::PtP710bt);
    VirtualPrinter::new(p, tape(p, 24), behaviour)
}

/// `true` for a write that carries a page (it contains `ESC i z`).
fn is_page_write(b: &[u8]) -> bool {
    b.windows(3).any(|w| w == [0x1B, 0x69, 0x7A])
}

/// Runs a job to completion and checks the pacing invariants.
fn print_and_check(h: &mut Harness, pages: &[Bitmap], opts: &JobOptions) {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let job = job(p, t, pages, opts);
    let n = job.page_count();
    let first_event = h.events.len();
    let first_sent = h.sent.len();
    let printed_before = h.vp.printed().len();
    h.s.submit(job, h.now).expect("preflight passes");
    h.run_until(600_000, |e| {
        matches!(e, Event::JobCompleted | Event::Failed { .. })
    })
    .expect("job ends");
    let events: Vec<(u64, Event)> = h.events[first_event..]
        .iter()
        .filter(|(_, e)| !matches!(e, Event::Status(_) | Event::Notification(_)))
        .cloned()
        .collect();

    // PageStarted / PageCompleted per page, in order, then JobCompleted.
    let mut expected = Vec::new();
    for page in 1..=n {
        expected.push(Event::PageStarted { page });
        expected.push(Event::PageCompleted { page });
    }
    expected.push(Event::JobCompleted);
    let progress: Vec<Event> = events.iter().map(|(_, e)| e.clone()).collect();
    assert_eq!(progress, expected);

    // Page n+1 is transmitted only after page n completed, and nothing at all is transmitted
    // between a page's write and its completion (except poll-fallback status requests).
    let writes: Vec<(u64, Vec<u8>)> = h.sent[first_sent..].to_vec();
    let page_writes: Vec<u64> = writes
        .iter()
        .filter(|(_, b)| is_page_write(b))
        .map(|(at, _)| *at)
        .collect();
    assert_eq!(page_writes.len(), usize::from(n));
    for page in 1..=n {
        let completed = events
            .iter()
            .find(|(_, e)| *e == Event::PageCompleted { page })
            .map(|(at, _)| *at)
            .expect("completed");
        let sent_at = page_writes[usize::from(page - 1)];
        if let Some(next) = page_writes.get(usize::from(page)) {
            assert!(
                *next >= completed,
                "page {} sent before page {page} completed",
                page + 1
            );
        }
        let between = writes
            .iter()
            .filter(|(at, b)| {
                *at > sent_at && *at < completed && b.as_slice() != ptouch::STATUS_REQUEST
            })
            .count();
        assert_eq!(between, 0, "transmission while page {page} printed");
    }
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());
    assert_eq!(&h.vp.printed()[printed_before..], pages);

    // Draining → Ready, swallowing anything extra.
    h.settle(5_000);
    assert_eq!(h.s.state(), SessionState::Ready);
}

#[test]
fn connect_reports_fixture_status() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    assert_eq!(h.vp.idle_status(), FIXTURE);
    assert_eq!(h.s.state(), SessionState::Idle);
    let status = h.connect();
    assert_eq!(status.raw, FIXTURE);
    assert_eq!(h.s.state(), SessionState::Ready);
    assert_eq!(h.s.profile().map(|p| p.model), Some(Model::PtP710bt));
    let ready: Vec<_> = h
        .events_only()
        .into_iter()
        .filter_map(|e| match e {
            Event::Ready(s) => Some(s),
            _ => None,
        })
        .collect();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].raw, FIXTURE);

    // Handshake bytes: generic reset (model unknown), then ESC i S after the drain.
    assert_eq!(h.sent.len(), 2);
    let (t0, reset) = &h.sent[0];
    assert!(reset[..200].iter().all(|&b| b == 0));
    assert_eq!(&reset[200..], &[0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]);
    let (t1, req) = &h.sent[1];
    assert_eq!(req.as_slice(), ptouch::STATUS_REQUEST);
    assert_eq!(t1 - t0, SessionConfig::default().mode_switch_drain_ms);
    assert!(h.vp.violations().is_empty());
}

#[test]
fn connect_with_known_profile_uses_model_reset() {
    let p = model(Model::PtP710bt);
    let mut h = Harness::new(Some(p), p710_printer(Behaviour::Normal));
    h.connect();
    let reset = &h.sent[0].1;
    assert_eq!(reset.len(), 100 + 2 + 4);
    assert_eq!(&reset[100..], &[0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]);
}

#[test]
fn single_page_job() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    print_and_check(&mut h, &[page(t, 80, 1)], &JobOptions::default());
    // No ESC i S at all during the job on a push model.
    let submit = h
        .sent
        .iter()
        .find(|(_, b)| is_page_write(b))
        .map(|(t, _)| *t);
    assert_eq!(h.status_requests_after(submit.expect("job sent")), 0);
}

#[test]
fn three_page_job_is_paced() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    let pages = [page(t, 40, 1), page(t, 120, 2), page(t, 31, 3)];
    print_and_check(&mut h, &pages, &JobOptions::default());
    // Pages 2 and 3 went out exactly when the previous page completed (after the trailing
    // phase change), each as its own write.
    let job_writes: Vec<_> = h.sent.iter().filter(|(_, b)| is_page_write(b)).collect();
    assert_eq!(job_writes.len(), 3);
    for (i, (at, _)) in job_writes.iter().enumerate().skip(1) {
        let page = i as u16;
        let completed = h
            .time_of(|e| *e == Event::PageCompleted { page })
            .expect("completed");
        assert!(
            *at >= completed,
            "page {} sent before page {page} completed",
            i + 1
        );
    }
}

#[test]
fn fragmented_and_coalesced_input() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    for chunking in [Chunking::Split7, Chunking::Bytes] {
        let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
        h.chunking = chunking;
        assert_eq!(h.connect().raw, FIXTURE);
        print_and_check(
            &mut h,
            &[page(t, 50, 1), page(t, 60, 2)],
            &JobOptions::default(),
        );
    }
    // Coalesced: "printing completed" and the phase change arrive in one 64-byte read.
    let timing = VirtualTiming {
        phase_delay_ms: 0,
        ..VirtualTiming::default()
    };
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal).with_timing(timing));
    h.connect();
    print_and_check(
        &mut h,
        &[page(t, 50, 1), page(t, 60, 2)],
        &JobOptions::default(),
    );
}

#[test]
fn silent_printer_fails_handshake_after_three_attempts() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Silent));
    h.s.connect(h.now);
    let start = h.now;
    let t = h
        .run_until(60_000, |e| matches!(e, Event::Failed { .. }))
        .expect("fails");
    assert_eq!(
        h.progress(),
        vec![Event::Failed {
            error: Error::Timeout(TimeoutKind::Handshake),
            resume_from_page: None
        }]
    );
    assert_eq!(h.s.state(), SessionState::Failed);
    let cfg = SessionConfig::default();
    assert_eq!(
        t - start,
        3 * (cfg.mode_switch_drain_ms + cfg.status_timeout_ms)
    );
    let resets = h.sent.iter().filter(|(_, b)| b.len() == 206).count();
    let requests = h
        .sent
        .iter()
        .filter(|(_, b)| b.as_slice() == ptouch::STATUS_REQUEST)
        .count();
    assert_eq!((resets, requests), (3, 3));
    assert_eq!(h.s.poll_timeout(), None);
}

#[test]
fn handshake_states_report_attempts() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Silent));
    h.s.connect(h.now);
    assert_eq!(h.s.state(), SessionState::Handshaking { attempt: 1 });
    // Drain, then the first ESC i S, then its timeout → attempt 2.
    h.step();
    h.step();
    assert_eq!(h.s.state(), SessionState::Handshaking { attempt: 2 });
}

#[test]
fn wrong_tape_width_is_refused_by_preflight() {
    let p = model(Model::PtP710bt);
    let vp = VirtualPrinter::new(p, tape(p, 12), Behaviour::Normal);
    let mut h = Harness::new(None, vp);
    h.connect();
    let t24 = tape(p, 24);
    let err = h.s.submit(
        job(p, t24, &[page(t24, 40, 1)], &JobOptions::default()),
        h.now,
    );
    assert_eq!(
        err,
        Err(Error::MediaMismatch {
            loaded_mm: 12,
            job_mm: 24
        })
    );
    assert_eq!(h.s.state(), SessionState::Ready);
    assert!(h.s.poll_transmit().is_none());
}

#[test]
fn no_media_is_refused_by_preflight() {
    let mut h = Harness::new(None, p710_printer(Behaviour::NoMedia));
    let status = h.connect();
    assert!(!status.has_media());
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let err =
        h.s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), h.now);
    assert_eq!(err, Err(Error::NoMedia));
}

#[test]
fn model_mismatch() {
    // The session expects an E560BT but a P710BT answers.
    let mut h = Harness::new(
        Some(model(Model::PtE560bt)),
        p710_printer(Behaviour::Normal),
    );
    h.s.connect(h.now);
    h.run_until(30_000, |e| matches!(e, Event::Failed { .. }))
        .expect("fails");
    assert!(h.progress().contains(&Event::Failed {
        error: Error::UnknownModel {
            series: 0x30,
            model: 0x76
        },
        resume_from_page: None
    }));
    assert_eq!(h.s.state(), SessionState::Failed);

    // A job encoded for another model is refused.
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    let e560 = model(Model::PtE560bt);
    let t = tape(e560, 24);
    let err = h.s.submit(
        job(e560, t, &[page(t, 40, 1)], &JobOptions::default()),
        h.now,
    );
    assert_eq!(
        err,
        Err(Error::UnknownModel {
            series: 0x30,
            model: 0x76
        })
    );
}

#[test]
fn submit_rules() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    let j = job(p, t, &[page(t, 40, 1)], &JobOptions::default());
    assert_eq!(h.s.submit(j.clone(), h.now), Err(Error::Busy));
    h.connect();
    let mut empty = j.clone();
    empty.pages.clear();
    assert_eq!(h.s.submit(empty, h.now), Err(Error::Empty));
    h.s.submit(j.clone(), h.now).expect("submits");
    assert_eq!(h.s.state(), SessionState::Printing { page: 1, of: 1 });
    assert_eq!(h.s.submit(j, h.now), Err(Error::Busy));
}

#[test]
fn cover_open_on_page_two() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::CoverOpenOnPage(2)));
    h.connect();
    let pages = [page(t, 40, 1), page(t, 40, 2), page(t, 40, 3)];
    h.s.submit(job(p, t, &pages, &JobOptions::default()), h.now)
        .expect("submits");
    let failed_at = h
        .run_until(120_000, |e| matches!(e, Event::Failed { .. }))
        .expect("fails");
    let failure = h
        .events_only()
        .into_iter()
        .find(|e| matches!(e, Event::Failed { .. }))
        .expect("failure");
    let Event::Failed {
        error: Error::Printer(errors),
        resume_from_page,
    } = failure
    else {
        panic!("unexpected {failure:?}");
    };
    assert_eq!(errors.info2 & 0x10, 0x10, "cover open bit");
    assert_eq!(resume_from_page, Some(2));
    assert_eq!(h.s.state(), SessionState::Recovering);

    // The cancel sequence goes out right away: 00×100 1B 40.
    let cancel = h
        .sent
        .iter()
        .find(|(at, _)| *at == failed_at)
        .map(|(_, b)| b.clone())
        .expect("cancel sent");
    assert_eq!(cancel.len(), 102);
    assert!(cancel[..100].iter().all(|&b| b == 0));
    assert_eq!(&cancel[100..], &[0x1B, 0x40]);

    // Back to Ready after a ready status.
    h.run_until(60_000, |e| matches!(e, Event::Ready(_)))
        .expect("recovers");
    assert_eq!(h.s.state(), SessionState::Ready);
    assert!(h.s.last_status().expect("status").is_ready());
    // Page 3 was never sent.
    assert_eq!(h.vp.printed().len(), 2);
    assert!(!h.progress().contains(&Event::PageStarted { page: 3 }));
    assert!(!h.progress().contains(&Event::JobCompleted));
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());
}

#[test]
fn request_status_rules() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    let before = h.events.len();
    h.s.request_status(h.now).expect("idle request");
    h.run_until(10_000, |e| matches!(e, Event::Status(_)))
        .expect("reply");
    assert!(
        h.events[before..]
            .iter()
            .any(|(_, e)| matches!(e, Event::Status(s) if s.raw == FIXTURE))
    );
    h.settle(10_000);
    assert!(
        !h.progress()
            .iter()
            .any(|e| matches!(e, Event::Failed { .. }))
    );

    h.s.submit(job(p, t, &[page(t, 200, 1)], &JobOptions::default()), h.now)
        .expect("submits");
    h.run_until(10_000, |e| matches!(e, Event::PageStarted { .. }))
        .expect("starts");
    assert_eq!(h.s.request_status(h.now), Err(Error::Busy));
    h.run_until(60_000, |e| matches!(e, Event::JobCompleted))
        .expect("completes");
    // Allowed again while draining (ends the drain).
    h.s.request_status(h.now).expect("draining request");
    assert_eq!(h.s.state(), SessionState::Ready);
}

#[test]
fn status_request_timeout_is_reported() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    // Swap in a printer that stopped answering.
    h.vp = p710_printer(Behaviour::Silent);
    h.s.request_status(h.now).expect("request");
    h.run_until(10_000, |e| matches!(e, Event::Failed { .. }))
        .expect("times out");
    assert!(h.progress().contains(&Event::Failed {
        error: Error::Timeout(TimeoutKind::Status),
        resume_from_page: None
    }));
    assert_eq!(h.s.state(), SessionState::Ready);
}

#[test]
fn cancel_mid_job() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    let pages = [page(t, 300, 1), page(t, 300, 2), page(t, 300, 3)];
    h.s.submit(job(p, t, &pages, &JobOptions::default()), h.now)
        .expect("submits");
    h.run_until(10_000, |e| matches!(e, Event::PageStarted { page: 1 }))
        .expect("starts");
    h.s.cancel(h.now);
    assert_eq!(h.s.state(), SessionState::Recovering);
    h.pump();
    assert!(h.progress().contains(&Event::Failed {
        error: Error::Cancelled,
        resume_from_page: Some(1)
    }));
    h.run_until(60_000, |e| matches!(e, Event::Ready(_)))
        .expect("recovers");
    assert_eq!(h.s.state(), SessionState::Ready);
    h.settle(60_000);
    assert_eq!(h.vp.printed().len(), 1);
    assert!(!h.progress().contains(&Event::PageCompleted { page: 1 }));
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());

    // The printer is usable again.
    print_and_check(&mut h, &[page(t, 40, 9)], &JobOptions::default());
}

#[test]
fn cancel_in_other_states() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    // Idle: just a reset.
    h.s.cancel(h.now);
    assert_eq!(h.s.state(), SessionState::Idle);
    let reset = h.s.poll_transmit().expect("reset");
    assert_eq!(&reset[reset.len() - 2..], &[0x1B, 0x40]);
    // Handshaking: back to Idle with a Cancelled failure.
    h.s.connect(h.now);
    h.s.cancel(h.now);
    assert_eq!(h.s.state(), SessionState::Idle);
    assert!(h.s.poll_transmit().is_none());
    // Ready: reset the printer and come back.
    h.connect();
    h.s.cancel(h.now);
    assert_eq!(h.s.state(), SessionState::Recovering);
    h.run_until(30_000, |e| matches!(e, Event::Ready(_)))
        .expect("ready");
    assert_eq!(h.s.state(), SessionState::Ready);
}

#[test]
fn no_push_on_push_model_times_out_after_t_est_plus_margin() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::NoPush));
    h.connect();
    let lines = 200;
    let j = job(p, t, &[page(t, lines, 1)], &JobOptions::default());
    let sent_lines = j.page_lines[0];
    let submitted = h.now;
    h.s.submit(j, h.now).expect("submits");
    let failed_at = h
        .run_until(600_000, |e| matches!(e, Event::Failed { .. }))
        .expect("times out");
    let cfg = SessionConfig::default();
    assert_eq!(
        failed_at - submitted,
        cfg.page_time_ms(sent_lines) + cfg.page_margin_ms
    );
    assert!(h.progress().contains(&Event::Failed {
        error: Error::Timeout(TimeoutKind::Page { page: 1 }),
        resume_from_page: Some(1)
    }));
    // Never polled while the page could still be printing.
    let polls_during = h
        .sent
        .iter()
        .filter(|(at, b)| {
            *at > submitted && *at < failed_at && b.as_slice() == ptouch::STATUS_REQUEST
        })
        .count();
    assert_eq!(polls_during, 0);
    h.run_until(60_000, |e| matches!(e, Event::Ready(_)))
        .expect("recovers");
}

#[test]
fn slow_push_printer_is_not_polled() {
    // Printing takes longer than T_est but the printer keeps pushing: no timeout, no poll.
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let timing = VirtualTiming {
        base_print_ms: 20_000,
        per_line_ms: 50,
        ..VirtualTiming::default()
    };
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal).with_timing(timing));
    h.connect();
    let submitted = h.now;
    print_and_check(
        &mut h,
        &[page(t, 100, 1), page(t, 100, 2)],
        &JobOptions::default(),
    );
    assert_eq!(h.status_requests_after(submitted), 0);
}

#[test]
fn poll_fallback_without_status_notification() {
    // P710BT without ESC i ! 00 stays silent while printing: the session waits T_est, then
    // polls until the reply shows the ready predicate.
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    let opts = JobOptions {
        auto_status: false,
        ..JobOptions::default()
    };
    let submitted = h.now;
    let pages = [page(t, 60, 1), page(t, 70, 2)];
    let j = job(p, t, &pages, &opts);
    let first_lines = j.page_lines[0];
    print_and_check(&mut h, &pages, &opts);
    let polls: Vec<u64> = h
        .sent
        .iter()
        .filter(|(at, b)| *at > submitted && b.as_slice() == ptouch::STATUS_REQUEST)
        .map(|(at, _)| *at)
        .collect();
    assert_eq!(polls.len(), 2, "one poll per page");
    assert_eq!(
        polls[0] - submitted,
        SessionConfig::default().page_time_ms(first_lines)
    );
}

#[test]
fn poll_fallback_on_model_without_confirmed_push() {
    // PT-E560BT: push not confirmed (PROTOCOL.md §6.8) → poll fallback even with ESC i ! 00.
    let p = model(Model::PtE560bt);
    let t = tape(p, 24);
    let vp = VirtualPrinter::new(p, t, Behaviour::NoPush);
    let mut h = Harness::new(None, vp);
    h.connect();
    assert_eq!(h.s.profile().map(|p| p.model), Some(Model::PtE560bt));
    let pages = [page(t, 60, 1), page(t, 70, 2)];
    let j = job(p, t, &pages, &JobOptions::default());
    let epilogue = j.epilogue.clone();
    h.s.submit(j, h.now).expect("submits");
    h.run_until(600_000, |e| {
        matches!(e, Event::JobCompleted | Event::Failed { .. })
    })
    .expect("ends");
    assert!(
        h.progress().contains(&Event::JobCompleted),
        "{:?}",
        h.progress()
    );
    assert_eq!(h.vp.printed(), &pages);
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());
    // The E560BT gets ESC i a FF after the last page completed.
    assert_eq!(epilogue, vec![0x1B, 0x69, 0x61, 0xFF]);
    let completed = h.time_of(|e| *e == Event::JobCompleted).expect("completed");
    assert!(
        h.sent
            .iter()
            .any(|(at, b)| *at == completed && *b == epilogue)
    );
}

#[test]
fn slow_printer_is_polled_until_ready() {
    // Poll mode: the first poll comes while the page is still printing ("printing" reply);
    // the session keeps polling every tick until ready.
    let p = model(Model::PtE560bt);
    let t = tape(p, 24);
    let timing = VirtualTiming {
        base_print_ms: 25_000,
        ..VirtualTiming::default()
    };
    let vp = VirtualPrinter::new(p, t, Behaviour::NoPush).with_timing(timing);
    let mut h = Harness::new(None, vp);
    h.connect();
    let submitted = h.now;
    h.s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), h.now)
        .expect("submits");
    h.run_until(600_000, |e| matches!(e, Event::JobCompleted))
        .expect("completes");
    // T_est ≈ 2.9 s, then one poll per 10 s tick until the 25 s print is done.
    assert_eq!(h.status_requests_after(submitted), 4);
    assert!(h.vp.violations().is_empty());
}

#[test]
fn poll_fallback_gives_up_after_max_ticks() {
    let p = model(Model::PtE560bt);
    let t = tape(p, 24);
    let cfg = SessionConfig {
        max_ticks: 4,
        ..SessionConfig::default()
    };
    let mut h = Harness::with_config(None, VirtualPrinter::new(p, t, Behaviour::NoPush), cfg);
    h.connect();
    // The printer goes silent after the handshake.
    h.vp = VirtualPrinter::new(p, t, Behaviour::Silent);
    let submitted = h.now;
    h.s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), h.now)
        .expect("submits");
    let failed_at = h
        .run_until(600_000, |e| matches!(e, Event::Failed { .. }))
        .expect("gives up");
    assert!(h.progress().contains(&Event::Failed {
        error: Error::Timeout(TimeoutKind::Page { page: 1 }),
        resume_from_page: Some(1)
    }));
    assert_eq!(h.status_requests_after(submitted), 4);
    let t_est = cfg.page_time_ms(40);
    assert_eq!(failed_at - submitted, t_est + 4 * cfg.poll_interval_ms);
    // Recovery polls a silent printer `status_attempts` times, then gives up for good.
    h.run_until(600_000, |e| {
        matches!(
            e,
            Event::Failed {
                error: Error::Timeout(TimeoutKind::Status),
                ..
            }
        )
    })
    .expect("recovery gives up");
    assert_eq!(h.s.state(), SessionState::Failed);
}

proptest::proptest! {
    #[test]
    fn session_never_panics_on_arbitrary_input(
        chunks in proptest::collection::vec(proptest::collection::vec(proptest::prelude::any::<u8>(), 0..80), 0..20),
        submit_after in 0usize..20,
    ) {
        let p = model(Model::PtP710bt);
        let t = tape(p, 24);
        let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
        h.connect();
        let header = [0x80, 0x20, 0x42];
        for (i, mut chunk) in chunks.into_iter().enumerate() {
            if i == submit_after {
                let _ = h.s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), h.now);
            }
            if i % 3 == 0 {
                // Plant headers so frames with arbitrary content get parsed.
                chunk.splice(0..0, header);
            }
            h.now += 997;
            h.s.handle_input(&chunk, h.now);
            h.s.handle_timeout(h.now);
            h.pump();
        }
        h.settle(3_600_000);
    }
}

#[test]
fn cooling_extends_the_deadline() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let timing = VirtualTiming {
        cooling_ms: 120_000,
        ..VirtualTiming::default()
    };
    let mut h = Harness::new(
        None,
        p710_printer(Behaviour::CoolingOnPage(1)).with_timing(timing),
    );
    h.connect();
    let submitted = h.now;
    print_and_check(
        &mut h,
        &[page(t, 50, 1), page(t, 50, 2)],
        &JobOptions::default(),
    );
    let notes: Vec<Notification> = h
        .events_only()
        .into_iter()
        .filter_map(|e| match e {
            Event::Notification(n) => Some(n),
            _ => None,
        })
        .collect();
    assert_eq!(
        notes,
        vec![Notification::CoolingStarted, Notification::CoolingFinished]
    );
    let completed = h
        .time_of(|e| *e == Event::PageCompleted { page: 1 })
        .expect("done");
    assert!(completed - submitted > 120_000);
    assert_eq!(h.status_requests_after(submitted), 0);
}

#[test]
fn extra_frames_after_the_job_are_swallowed() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::ExtraFrames(3)));
    h.connect();
    print_and_check(
        &mut h,
        &[page(t, 50, 1), page(t, 50, 2)],
        &JobOptions::default(),
    );
    let completed = h.time_of(|e| *e == Event::JobCompleted).expect("completed");
    let after = h
        .events
        .iter()
        .filter(|(at, e)| *at >= completed && matches!(e, Event::Status(_)))
        .count();
    assert!(after >= 3, "extra frames arrived after the job ({after})");
    assert_eq!(h.s.state(), SessionState::Ready);
    // And the session can print again.
    print_and_check(&mut h, &[page(t, 50, 3)], &JobOptions::default());
}

#[test]
fn wrong_media_error_during_job() {
    // The printer rejects ESC i z although the status matched (cassette swapped).
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::WrongMedia));
    h.connect();
    h.s.submit(job(p, t, &[page(t, 50, 1)], &JobOptions::default()), h.now)
        .expect("preflight passes");
    h.run_until(60_000, |e| matches!(e, Event::Failed { .. }))
        .expect("fails");
    let failure = h
        .progress()
        .into_iter()
        .find(|e| matches!(e, Event::Failed { .. }))
        .expect("failure");
    match failure {
        Event::Failed {
            error: Error::Printer(e),
            resume_from_page: Some(1),
        } => assert_eq!(e.info2, 0x01),
        other => panic!("unexpected {other:?}"),
    }
    assert!(h.vp.printed().is_empty());
    h.run_until(60_000, |e| matches!(e, Event::Ready(_)))
        .expect("recovers");
}

#[test]
fn reconnect_during_job_abandons_it() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    h.s.submit(job(p, t, &[page(t, 300, 1)], &JobOptions::default()), h.now)
        .expect("submits");
    h.pump();
    h.s.connect(h.now);
    h.pump();
    assert!(h.progress().contains(&Event::Failed {
        error: Error::Cancelled,
        resume_from_page: Some(1)
    }));
    h.run_until(30_000, |e| matches!(e, Event::Ready(_)))
        .expect("ready");
}

#[test]
fn handle_timeout_before_deadline_is_noop() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.s.connect(h.now);
    let deadline = h.s.poll_timeout().expect("deadline");
    h.s.poll_transmit();
    h.s.handle_timeout(deadline - 1);
    assert_eq!(h.s.poll_timeout(), Some(deadline));
    assert!(h.s.poll_transmit().is_none());
}

#[test]
fn garbage_input_never_breaks_the_session() {
    let mut h = Harness::new(None, p710_printer(Behaviour::Normal));
    h.connect();
    h.s.handle_input(&[0x80, 0x20, 0x43, 0xFF, 0x00, 0x80, 0x20], h.now);
    h.s.handle_input(&[0x42; 3], h.now);
    assert_eq!(h.s.state(), SessionState::Ready);
}

/// Integration guard: every model × multi-page job, driven by the real session against the
/// virtual printer, completes with the input pages printed and no protocol violation (in
/// particular nothing sent while a page prints, PROTOCOL.md §6.8 step 2). This catches
/// disagreements between the session's push/poll rules and the printer double.
#[test]
fn every_model_prints_multi_page_jobs_without_violations() {
    for p in ptouch::profiles() {
        let Some(t) = p
            .media
            .iter()
            .copied()
            .find(|t| t.kind == ptouch::TapeKind::Tze)
        else {
            continue;
        };
        let pages: Vec<Bitmap> = (0..3).map(|seed| page(t, 200, seed)).collect();
        let mut h = Harness::new(Some(p), VirtualPrinter::new(p, t, Behaviour::Normal));
        h.connect();
        h.s.submit(job(p, t, &pages, &JobOptions::default()), h.now)
            .expect("preflight passes");
        h.run_until(3_600_000, |e| {
            matches!(e, Event::JobCompleted | Event::Failed { .. })
        })
        .unwrap_or_else(|| panic!("{}: job ends", p.name));
        assert!(
            h.events_only().contains(&Event::JobCompleted),
            "{}: {:?}",
            p.name,
            h.progress()
        );
        assert_eq!(h.vp.violations(), &[], "{}", p.name);
        assert_eq!(h.vp.printed().len(), pages.len(), "{}", p.name);
        for (got, want) in h.vp.printed().iter().zip(&pages) {
            assert_eq!(got.height(), want.height(), "{}", p.name);
            for x in 0..want.length() {
                assert_eq!(got.line(x), want.line(x), "{} line {x}", p.name);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Review regressions, driven frame by frame (no virtual printer)
// ---------------------------------------------------------------------------------------------

/// The fixture with `st[18]`, `st[19]`, `st[22]` replaced.
fn frame(status_type: u8, phase: u8, notification: u8) -> [u8; 32] {
    let mut f = FIXTURE;
    f[18] = status_type;
    f[19] = phase;
    f[22] = notification;
    f
}

const PRINTING: [u8; 3] = [0x06, 0x01, 0x00];
const RECEIVING: [u8; 3] = [0x06, 0x00, 0x00];
const COMPLETED: [u8; 3] = [0x01, 0x00, 0x00];
const COOLING_STARTED: [u8; 3] = [0x05, 0x00, 0x03];
const COOLING_FINISHED: [u8; 3] = [0x05, 0x00, 0x04];

/// A session that completed the handshake on `status`, at t = 200 ms.
fn ready_session(p: &'static ModelProfile, status: &[u8; 32]) -> Session {
    let mut s = Session::new(Some(p), SessionConfig::default());
    s.connect(0);
    while s.poll_transmit().is_some() {}
    s.handle_timeout(100); // drain done → ESC i S
    while s.poll_transmit().is_some() {}
    s.handle_input(status, 200);
    while s.poll_event().is_some() {}
    s
}

fn feed(s: &mut Session, f: [u8; 3], now: u64) {
    s.handle_input(&frame(f[0], f[1], f[2]), now);
}

fn drain_events(s: &mut Session) -> Vec<Event> {
    std::iter::from_fn(|| s.poll_event()).collect()
}

fn failures(events: &[Event]) -> Vec<Error> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Failed { error, .. } => Some(error.clone()),
            _ => None,
        })
        .collect()
}

/// Runs every timeout up to `until`, collecting events and transmitted buffers.
fn run_until(s: &mut Session, until: u64) -> (Vec<Event>, Vec<Vec<u8>>) {
    let mut events = Vec::new();
    let mut sent = Vec::new();
    while let Some(d) = s.poll_timeout().filter(|&d| d <= until) {
        s.handle_timeout(d);
        sent.extend(std::iter::from_fn(|| s.poll_transmit()));
        events.extend(drain_events(s));
    }
    (events, sent)
}

fn two_page_job(p: &'static ModelProfile) -> EncodedJob {
    let t = tape(p, 24);
    job(
        p,
        t,
        &[page(t, 40, 1), page(t, 40, 2)],
        &JobOptions::default(),
    )
}

#[test]
fn cooling_carries_over_to_the_next_page() {
    let p = model(Model::PtP710bt);
    let mut s = ready_session(p, &FIXTURE);
    s.submit(two_page_job(p), 1_000).unwrap();
    assert!(s.poll_transmit().is_some());
    feed(&mut s, PRINTING, 1_600);
    feed(&mut s, COMPLETED, 2_100);
    feed(&mut s, COOLING_STARTED, 2_200);
    feed(&mut s, RECEIVING, 2_300);
    // Page 2 is released on the trailing phase change.
    assert!(s.poll_transmit().is_some(), "page 2 sent");
    assert_eq!(s.state(), SessionState::Printing { page: 2, of: 2 });
    drain_events(&mut s);
    // Three minutes of silence while the printer cools: no timeout, no cancel, no poll.
    let (events, sent) = run_until(&mut s, 182_300);
    assert!(failures(&events).is_empty(), "{events:?}");
    assert!(sent.is_empty(), "nothing written while cooling: {sent:?}");
    assert_eq!(s.state(), SessionState::Printing { page: 2, of: 2 });
    // Cooling ends; page 2 prints and completes.
    feed(&mut s, COOLING_FINISHED, 182_400);
    feed(&mut s, PRINTING, 182_500);
    feed(&mut s, COMPLETED, 183_000);
    feed(&mut s, RECEIVING, 183_100);
    let events = drain_events(&mut s);
    assert!(events.contains(&Event::JobCompleted), "{events:?}");
    assert!(failures(&events).is_empty());
}

#[test]
fn cooling_holds_the_next_page_after_printing_completed() {
    let p = model(Model::PtP710bt);
    let mut s = ready_session(p, &FIXTURE);
    s.submit(two_page_job(p), 1_000).unwrap();
    assert!(s.poll_transmit().is_some());
    feed(&mut s, PRINTING, 1_600);
    feed(&mut s, COMPLETED, 2_100);
    feed(&mut s, COOLING_STARTED, 2_200);
    // The 2 s phase-frame wait must not release page 2 while the printer cools.
    let (events, sent) = run_until(&mut s, 62_200);
    assert!(sent.is_empty(), "page 2 held while cooling");
    assert!(failures(&events).is_empty(), "{events:?}");
    assert_eq!(s.state(), SessionState::Printing { page: 1, of: 2 });
    // Cooling finished: the phase-frame wait restarts, then page 2 goes out.
    feed(&mut s, COOLING_FINISHED, 62_300);
    let (_, sent) = run_until(&mut s, 64_300);
    assert_eq!(sent.len(), 1, "page 2 sent after the wait");
    assert_eq!(s.state(), SessionState::Printing { page: 2, of: 2 });
}

#[test]
fn error_after_job_completed_fails_the_job() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    let mut s = ready_session(p, &FIXTURE);
    s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), 1_000)
        .unwrap();
    while s.poll_transmit().is_some() {}
    feed(&mut s, PRINTING, 1_600);
    feed(&mut s, COMPLETED, 2_100);
    feed(&mut s, RECEIVING, 2_200);
    assert!(drain_events(&mut s).contains(&Event::JobCompleted));
    assert_eq!(s.state(), SessionState::Draining);
    // A cutter jam while the label is fed out / cut.
    let mut err = frame(0x02, 0x00, 0x00);
    err[8] = 0x04;
    s.handle_input(&err, 2_300);
    let events = drain_events(&mut s);
    assert!(
        events.iter().any(|e| matches!(
            e,
            Event::Failed {
                error: Error::Printer(_),
                resume_from_page: Some(1)
            }
        )),
        "{events:?}"
    );
    assert_eq!(s.state(), SessionState::Recovering);
    let cancel = s.poll_transmit().unwrap();
    assert_eq!(cancel.len(), 102, "00×100 1B 40");
}

#[test]
fn error_status_without_error_bits_is_not_an_empty_printer_error() {
    let p = model(Model::PtP710bt);
    let t = tape(p, 24);
    for status_type in [0x02, 0x18] {
        // During a job.
        let mut s = ready_session(p, &FIXTURE);
        s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), 1_000)
            .unwrap();
        s.handle_input(&frame(status_type, 0x00, 0x00), 1_500);
        let f = failures(&drain_events(&mut s));
        assert!(
            matches!(f.as_slice(), [Error::Protocol(_)]),
            "0x{status_type:02X}: {f:?}"
        );
        // In the preflight.
        let s2 = ready_session(p, &frame(status_type, 0x00, 0x00));
        let mut s2 = s2;
        let err = s2
            .submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), 1_000)
            .unwrap_err();
        assert!(matches!(err, Error::Protocol(_)), "{err:?}");
        assert!(!err.to_string().contains("0x00, info2 0x00"), "{err}");
    }
}

#[test]
fn turned_off_is_fatal_while_recovering_and_draining() {
    let p = model(Model::PtP710bt);
    let mut s = ready_session(p, &FIXTURE);
    s.cancel(1_000);
    assert_eq!(s.state(), SessionState::Recovering);
    s.handle_input(&frame(0x04, 0x00, 0x00), 1_050);
    assert_eq!(s.state(), SessionState::Failed);
    assert_eq!(failures(&drain_events(&mut s)), [Error::PrinterOff]);

    let t = tape(p, 24);
    let mut s = ready_session(p, &FIXTURE);
    s.submit(job(p, t, &[page(t, 40, 1)], &JobOptions::default()), 1_000)
        .unwrap();
    feed(&mut s, PRINTING, 1_600);
    feed(&mut s, COMPLETED, 2_100);
    feed(&mut s, RECEIVING, 2_200);
    assert_eq!(s.state(), SessionState::Draining);
    drain_events(&mut s);
    s.handle_input(&frame(0x04, 0x00, 0x00), 2_300);
    assert_eq!(s.state(), SessionState::Failed);
    let events = drain_events(&mut s);
    assert!(events.contains(&Event::Failed {
        error: Error::PrinterOff,
        resume_from_page: Some(1)
    }));
}

#[test]
fn high_resolution_needs_laminated_tape() {
    let p = model(Model::PtP710bt);
    let hr = JobOptions {
        high_resolution: true,
        ..JobOptions::default()
    };
    // st[11]: 03 non-laminated, 04 fabric, 14 flexible ID, 15 satin, 16 self-laminating.
    for media_type in [0x03, 0x04, 0x14, 0x15, 0x16] {
        let mut status = FIXTURE;
        status[11] = media_type;
        let t = ptouch::tape_for_status(p, 0x18, media_type).unwrap();
        let mut s = ready_session(p, &status);
        let err = s
            .submit(job(p, t, &[page(t, 80, 1)], &hr), 1_000)
            .unwrap_err();
        assert!(
            matches!(err, Error::Unsupported(_)),
            "st[11] 0x{media_type:02X}: {err:?}"
        );
        // A normal-resolution job on the same tape is fine.
        assert!(
            s.submit(job(p, t, &[page(t, 80, 1)], &JobOptions::default()), 1_000)
                .is_ok()
        );
    }
    let t = tape(p, 24);
    let mut s = ready_session(p, &FIXTURE);
    assert!(s.submit(job(p, t, &[page(t, 80, 1)], &hr), 1_000).is_ok());
}

#[test]
fn submit_rejects_jobs_it_cannot_number() {
    let p = model(Model::PtP710bt);
    let mut s = ready_session(p, &FIXTURE);
    let pages = ptouch::encode::MAX_PAGES + 1;
    let job = EncodedJob {
        model: Model::PtP710bt,
        media_width_byte: 24,
        media_type_byte: 1,
        high_resolution: false,
        preamble: Vec::new(),
        pages: vec![vec![0x1A]; pages],
        page_lines: vec![1; pages],
        epilogue: Vec::new(),
    };
    assert!(matches!(s.submit(job, 1_000), Err(Error::InvalidInput(_))));
    assert_eq!(s.state(), SessionState::Ready);
}
