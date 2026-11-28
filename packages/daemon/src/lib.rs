//! Ghost's daemon and command line. CONTRACTS.md defines what crosses a
//! package boundary; each module says what it owns. What is public is what the
//! two binaries, the bar and the tests beside this crate use.
pub mod abort;
mod attachments;
pub mod cli;
pub mod client;
mod clock;
mod coding_agent;
mod config;
mod conversation_host;
mod conversation_log;
pub mod daemon;
pub mod env;
mod error;
pub mod ghosts;
mod help_guides;
mod help_topics;
mod home;
mod hooks;
pub mod http;
mod local_model;
mod local_turn;
mod log;
mod persona;
mod private_file;
mod process;
mod prompt_policy;
mod push;
pub mod random;
mod remote;
mod running_source;
mod server;
mod sidecars;
mod text;
pub mod token;
mod topics;
mod trash;
mod xdg;

/// The release version, the one in this crate's manifest.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
