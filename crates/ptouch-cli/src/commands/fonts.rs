//! `ptouch fonts`. Lists installed fonts that `print --font <name>` can use.

use std::io::Write as _;

use crate::cli::{Cli, FontsArgs};
use crate::error::CliError;
use crate::render::fonts;

/// Runs the subcommand.
///
/// # Errors
/// None in practice (unreadable font files are skipped).
pub fn run(_cli: &Cli, args: &FontsArgs) -> Result<(), CliError> {
    let query = args.query.as_deref().map(str::to_lowercase);
    let faces: Vec<_> = fonts::scan()
        .into_iter()
        .filter(|f| {
            query.as_deref().is_none_or(|q| {
                f.full_name.to_lowercase().contains(q) || f.family.to_lowercase().contains(q)
            })
        })
        .collect();
    if faces.is_empty() {
        eprintln!(
            "No matching fonts found (searched: {:?}).",
            fonts::font_dirs()
        );
        eprintln!("The built-in 5×7 font is always available (--font builtin).");
        return Ok(());
    }
    for f in &faces {
        let index = if f.index > 0 {
            format!(" #{}", f.index)
        } else {
            String::new()
        };
        let _ = writeln!(
            std::io::stdout().lock(),
            "{:<40} {}{index}",
            f.full_name,
            f.path.display()
        );
    }
    eprintln!(
        "{} font(s). Use: ptouch print --font \"<name>\" …",
        faces.len()
    );
    Ok(())
}
