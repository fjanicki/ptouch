//! Simulated print for `--dry-run`: runs the real [`ptouch::Session`] (handshake, preflight,
//! page pacing, completion) against an in-process [`ptouch::VirtualPrinter`] on a simulated
//! clock, so a dry run exercises the same state machine as a real print without sleeping.
//!
//! Nothing here touches a transport or the wall clock; time jumps straight to the next thing
//! either side has scheduled.

use ptouch::virtual_printer::parser::Violation;
use ptouch::{
    Behaviour, Bitmap, EncodedJob, Event, ModelProfile, Session, SessionConfig, TapeSpec,
    VirtualPrinter,
};

use crate::error::CliError;

/// Upper bound on simulation steps (each step handles at least one scheduled event), so a
/// session bug can never hang the CLI.
const MAX_STEPS: u32 = 100_000;

/// Outcome of a simulated print.
#[derive(Debug)]
pub(crate) struct SimReport {
    /// Pages the virtual printer printed, in order (print-area height).
    pub printed: Vec<Bitmap>,
    /// Protocol violations the virtual printer observed.
    pub violations: Vec<Violation>,
    /// Simulated time from connect to the end of the job.
    pub elapsed_ms: u64,
}

/// What the simulation is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Handshake,
    Printing,
}

/// Connects a [`Session`] for `profile` to a healthy virtual printer with `tape` loaded,
/// submits `job` and runs both sides until the job completes.
///
/// # Errors
/// The session's handshake, preflight or job error (as a real print would report it), or
/// [`CliError::Stalled`] if the simulation stops making progress.
pub(crate) fn simulate_print(
    profile: &'static ModelProfile,
    tape: &'static TapeSpec,
    job: EncodedJob,
) -> Result<SimReport, CliError> {
    let mut printer = VirtualPrinter::new(profile, tape, Behaviour::Normal);
    let mut session = Session::new(Some(profile), SessionConfig::default());
    let mut now: u64 = 0;
    let mut stage = Stage::Handshake;
    let mut job = Some(job);
    session.connect(now);

    for _ in 0..MAX_STEPS {
        // Host → printer, then events.
        while let Some(bytes) = session.poll_transmit() {
            printer.handle_input(&bytes, now);
        }
        let mut submitted = false;
        while let Some(event) = session.poll_event() {
            match (stage, event) {
                (Stage::Handshake, Event::Ready(_)) => {
                    if let Some(job) = job.take() {
                        session.submit(job, now)?;
                        submitted = true;
                    }
                    stage = Stage::Printing;
                }
                (Stage::Printing, Event::JobCompleted) => {
                    return Ok(SimReport {
                        printed: printer.printed().to_vec(),
                        violations: printer.violations().to_vec(),
                        elapsed_ms: now,
                    });
                }
                (_, Event::Failed { error, .. }) => return Err(error.into()),
                _ => {}
            }
        }
        if submitted {
            // Send the job before time moves on.
            continue;
        }
        // Jump to whatever is scheduled next on either side.
        let next = [printer.next_output_at(), session.poll_timeout()]
            .into_iter()
            .flatten()
            .min();
        let Some(next) = next else {
            break;
        };
        now = now.max(next);
        while let Some(frame) = printer.poll_output(now) {
            session.handle_input(&frame, now);
        }
        if session.poll_timeout().is_some_and(|due| due <= now) {
            session.handle_timeout(now);
        }
    }
    Err(CliError::Stalled("the simulated print"))
}
