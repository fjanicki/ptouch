//! Ctrl-C handling (PROTOCOL.md §2.2 step 9, HARDWARE-TESTS §7).
//!
//! Killing the process on SIGINT would skip the transport teardown: on macOS the RFCOMM
//! channel close, `closeConnection` and the run-loop drain must run before exit, or
//! `bluetoothd` may never release the link. [`install`] therefore replaces the default action
//! with a flag. The driver loop checks [`requested`] on every pump step (reads are capped at
//! 200 ms): a print in progress is cancelled through the session (cancel sequence, resume
//! page reported), any other wait ends with [`crate::error::CliError::Interrupted`]; either
//! way the transport is closed normally before the process exits. A second Ctrl-C exits
//! immediately (exit code 130), as an escape hatch if the teardown itself hangs.

use std::sync::atomic::{AtomicBool, Ordering};

/// Exit code of a process ended by SIGINT (128 + 2).
pub const EXIT_CODE: u8 = 130;

static REQUESTED: AtomicBool = AtomicBool::new(false);

/// Installs the handler (once, from `main`). Failure to install is not fatal: Ctrl-C then
/// keeps its default action.
pub fn install() {
    let _ = ctrlc::set_handler(|| {
        // The handler runs on ctrlc's own thread, not in signal context.
        if REQUESTED.swap(true, Ordering::SeqCst) {
            std::process::exit(i32::from(EXIT_CODE));
        }
        eprintln!("\ninterrupted: stopping cleanly (press Ctrl-C again to quit at once)…");
    });
}

/// `true` once the user pressed Ctrl-C.
pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}
