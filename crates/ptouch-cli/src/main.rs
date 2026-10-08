//! `ptouch` — command-line tool for Brother P-touch label printers.
//!
//! A thin UI over the `ptouch` core and `ptouch-transport`: argument parsing ([`cli`]),
//! rendering helpers for text/images/test labels/previews ([`render`]), and a blocking driver
//! loop ([`driver`]) that runs the sans-IO [`ptouch::Session`] over a
//! [`ptouch_transport::Transport`]. No protocol logic lives here.
//!
//! Exit codes: 0 success, 1 runtime error (printer/transport), 2 usage error (clap), 130
//! interrupted with Ctrl-C (after a clean cancel and link teardown).

mod cli;
mod commands;
mod driver;
mod error;
mod interrupt;
mod render;

use std::process::ExitCode;

use clap::{CommandFactory, Parser};

fn main() -> ExitCode {
    let args = cli::Cli::parse();
    if args.connection_flags() > 1 {
        cli::Cli::command()
            .error(
                clap::error::ErrorKind::ArgumentConflict,
                "use only one of --device, --port, --bt, --tcp and --usb",
            )
            .exit();
    }
    let result = if args.needs_connection() {
        // Ctrl-C must cancel the job and close the link instead of killing the process
        // (PROTOCOL.md §2.2 step 9).
        interrupt::install();
        // IOBluetooth needs the main thread's run loop (PROTOCOL.md §2.2 step 6), so all
        // transport work runs inside the event-loop helper.
        ptouch_transport::run_with_event_loop(move || commands::run(args))
    } else {
        // Offline commands (info, decode, fonts, --dry-run, --preview) never touch a
        // transport and run directly.
        commands::run(args)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e @ error::CliError::Interrupted) => {
            eprintln!("error: {e}");
            ExitCode::from(interrupt::EXIT_CODE)
        }
        Err(e) => {
            eprintln!("error: {e}");
            if let Some(hint) = e.hint() {
                eprintln!("hint: {hint}");
            }
            ExitCode::FAILURE
        }
    }
}
