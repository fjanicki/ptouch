//! `ptouch test-label`. Prints the orientation or ruler test label (ARCHITECTURE.md §5.1,
//! PROTOCOL.md §9.1, `docs/HARDWARE-TESTS.md`).

use super::{check_label_length, print_pages};
use crate::cli::{Cli, TestLabelArgs, TestLabelKind};
use crate::error::CliError;
use crate::render::test_labels;

/// Runs the subcommand.
///
/// # Errors
/// Connection, preflight and print errors.
pub fn run(cli: &Cli, args: &TestLabelArgs) -> Result<(), CliError> {
    print_pages(cli, &args.job, &|profile, tape| {
        Ok(vec![match args.kind {
            TestLabelKind::Orientation => test_labels::orientation(tape, profile.dpi),
            TestLabelKind::Ruler => {
                // Checked before the ruler bitmap is allocated (PROTOCOL.md §5.6).
                let dots = u64::from(args.length) * u64::from(profile.dpi) * 10 / 254;
                check_label_length(profile, tape, dots, "--length")?;
                test_labels::ruler(tape, profile.dpi, args.length)
            }
        }])
    })
}
