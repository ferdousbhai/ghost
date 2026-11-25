//! Ghost's daemon and command line. CONTRACTS.md defines what crosses a
//! package boundary; each module says what it owns.
pub mod abort;
pub mod clock;
pub mod config;
pub mod env;
pub mod error;
pub mod http;
pub mod log;
pub mod private_file;
pub mod process;
pub mod random;
pub mod token;
pub mod xdg;

/// The release version, the one in this crate's manifest.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
