//! `ptouch decode`. Decodes a job file with `ptouch::virtual_printer::decode_job` and writes
//! each page as PBM (no image crate); prints violations.

use std::io::Write as _;

use super::{numbered_path, offline_profile};
use crate::cli::{Cli, DecodeArgs};
use crate::error::CliError;
use crate::render::preview;

/// Runs the subcommand.
///
/// # Errors
/// [`CliError::File`] for I/O, [`CliError::Protocol`] for streams that cannot be decoded.
pub fn run(cli: &Cli, args: &DecodeArgs) -> Result<(), CliError> {
    let profile = offline_profile(cli)?;
    let bytes = std::fs::read(&args.input).map_err(|e| CliError::file(&args.input, e))?;
    let job = ptouch::virtual_printer::decode_job(profile, &bytes)?;
    eprintln!(
        "{}: {} bytes, {} command(s), {} page(s) (decoded as {})",
        args.input.display(),
        bytes.len(),
        job.commands.len(),
        job.pages.len(),
        profile.name
    );
    for (i, page) in job.pages.iter().enumerate() {
        eprintln!(
            "  page {}: {} lines × {} dots",
            i + 1,
            page.length(),
            page.height()
        );
        if args.preview {
            let _ = write!(
                std::io::stdout().lock(),
                "{}",
                preview::ascii(page, preview::MAX_ASCII_COLUMNS)
            );
        }
        if let Some(out) = &args.out {
            let path = numbered_path(out, i, job.pages.len());
            std::fs::write(&path, page.to_pbm()).map_err(|e| CliError::file(&path, e))?;
            eprintln!("  wrote {}", path.display());
        }
    }
    if job.violations.is_empty() {
        eprintln!("no protocol violations");
    } else {
        for v in &job.violations {
            eprintln!("violation: {v:?}");
        }
    }
    Ok(())
}
