//! A refusal the API answers with its own status: `code` is machine-readable
//! and `message` says what to do next.
use std::fmt;

#[derive(Debug, Clone)]
pub struct GhostError {
    pub code: String,
    pub message: String,
    pub status: u16,
}

pub type Result<T> = std::result::Result<T, GhostError>;

impl GhostError {
    pub fn new(code: &str, message: impl Into<String>, status: u16) -> Self {
        Self { code: code.to_string(), message: message.into(), status }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message, 400)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message, 404)
    }
    /// A failure that is the daemon's own. The API answers 500 with a fixed
    /// sentence; this message goes to the log.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal_error", message, 500)
    }
    pub fn is_internal(&self) -> bool {
        self.status == 500 && self.code == "internal_error"
    }
}

impl fmt::Display for GhostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GhostError {}

impl From<std::io::Error> for GhostError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<serde_json::Error> for GhostError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(error.to_string())
    }
}
