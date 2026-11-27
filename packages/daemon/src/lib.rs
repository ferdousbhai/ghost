//! Ghost's daemon and command line. CONTRACTS.md defines what crosses a
//! package boundary; each module says what it owns.
pub mod abort;
pub mod attachments;
pub mod cli;
pub mod clock;
pub mod coding_agent;
pub mod config;
pub mod conversation_log;
pub mod env;
pub mod error;
pub mod ghosts;
pub mod help_guides;
pub mod help_topics;
pub mod home;
pub mod hooks;
pub mod http;
pub mod local_model;
pub mod local_turn;
pub mod log;
pub mod persona;
pub mod private_file;
pub mod process;
pub mod prompt_policy;
pub mod push;
pub mod random;
pub mod remote;
pub mod running_source;
pub mod sidecars;
pub mod text;
pub mod token;
pub mod topics;
pub mod trash;
pub mod turn_buffer;
pub mod xdg;

/// The release version, the one in this crate's manifest.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub mod conversation_host;
pub mod daemon;
pub mod server;
