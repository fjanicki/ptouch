//! `ptouch list` / `ptouch discover`. Lists candidate printers via
//! `ptouch_transport::discover` with endpoint strings and model hints.

use std::io::Write as _;
use std::time::Duration;

use ptouch_transport::DiscoverOptions;
use ptouch_transport::discovery::DiscoverySource;

use crate::cli::{Cli, ListArgs};
use crate::error::CliError;

/// Runs the subcommand.
///
/// # Errors
/// Only if every discovery source failed.
pub fn run(_cli: &Cli, args: &ListArgs) -> Result<(), CliError> {
    let opts = DiscoverOptions {
        inquiry: args.inquiry.map(Duration::from_secs),
        ..DiscoverOptions::default()
    };
    let devices = ptouch_transport::discover(&opts)?;
    if devices.is_empty() {
        eprintln!("No printers found.");
        eprintln!(
            "hint: pair the printer in the system Bluetooth settings or connect it by USB; \
             network printers are not discovered, use --tcp HOST"
        );
        return Ok(());
    }
    let _ = writeln!(
        std::io::stdout().lock(),
        "{:<44} {:<12} {:<10} NAME",
        "ENDPOINT",
        "MODEL",
        "SOURCE"
    );
    for d in &devices {
        let source = match d.source {
            DiscoverySource::Serial => "serial",
            DiscoverySource::BluetoothPaired => "bt-paired",
            DiscoverySource::BluetoothInquiry => "bt-inquiry",
            DiscoverySource::Usb => "usb",
            _ => "other",
        };
        let _ = writeln!(
            std::io::stdout().lock(),
            "{:<44} {:<12} {:<10} {}",
            d.endpoint.to_string(),
            d.model.map_or("?", |p| p.name),
            source,
            d.label
        );
    }
    eprintln!("\nUse one with --device <ENDPOINT> (or set $PTOUCH_DEVICE).");
    Ok(())
}
