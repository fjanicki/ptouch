# ptouch

An open-source library and tools for printing to Brother P-touch label printers over Bluetooth, written in Rust.

The goal is a browser-based label print studio, hosted on GitHub Pages, that talks directly to a printer paired with your computer. No vendor app is needed.

**Status:** early development. Primary target: **PT-P710BT** (Cube Plus). Other Bluetooth P-touch models (PT-P300BT, PT-P910BT, PT-D460BT, PT-D610BT, PT-E310BT, PT-E560BT, …) are planned.

## Layout (planned)

- `crates/ptouch` is the protocol core. It is sans-IO and compiles to WebAssembly. It covers commands, status parsing, model and media tables, rasterization and compression.
- Native transports and a CLI, used for development and hardware testing.
- `web/` is the browser studio (Web Serial).

The library is kept strictly separate from any UI.

## Disclaimer

This project is independent and is not affiliated with, endorsed by, or supported by Brother Industries, Ltd. "Brother" and "P-touch" are trademarks of Brother Industries, Ltd. The protocol is documented from Brother's public developer documentation and interoperability research.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your option.
