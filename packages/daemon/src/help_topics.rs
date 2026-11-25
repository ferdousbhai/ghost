//! PLACEHOLDER for the recipes `ghost help <topic>` prints. The real module
//! (ported from `help-topics.ts`) replaces this file; only the interface is
//! final, and each topic here renders a one-line stub.

/// Every topic, in the order the prompt's Ghost section indexes them.
pub const HELP_TOPICS: &[&str] = &["self", "background", "memory", "dictation", "notifications", "browser", "products"];

/// The recipe for `topic`, or None when it is not a topic.
pub fn render_help_topic(topic: &str) -> Option<String> {
    HELP_TOPICS.contains(&topic).then(|| format!("# {topic}\n"))
}
