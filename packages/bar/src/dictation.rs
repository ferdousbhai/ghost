//! Omarchy's dictation, as far as the bar has to do with it: whether this machine has it, the key the owner starts
//! it with, and starting it for a click. The bar has no speech of its own; dictation types what it hears into the
//! prompt as it types into any focused field.

use std::process::{Command, Stdio};

use gtk::{gio, glib};
use serde_json::Value;

/// What Omarchy calls the binding that starts and ends dictation (`default/hypr/bindings/dictation.lua`). Hyprland
/// keeps a binding's description and not its command, so this is the one way to tell which key it is.
const TOGGLE: &str = "Toggle dictation";

/// Hyprland's modifier bits, in the order a shortcut is read aloud.
const MODIFIERS: [(u64, &str); 4] = [(64, "Super"), (4, "Ctrl"), (8, "Alt"), (1, "Shift")];

pub fn installed() -> bool {
    glib::find_program_in_path("omarchy-dictation").is_some()
}

/// Start dictation, or end it and have what was heard typed.
pub fn toggle() {
    let _ = Command::new("omarchy-dictation").arg("toggle").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// A key as its cap reads: `SPACE` is Space, `x` is X, `Alt_R` is Right Alt.
fn cap(key: &str) -> String {
    let (name, right) = match key.strip_suffix("_R") {
        Some(name) => (name, true),
        None => (key.strip_suffix("_L").unwrap_or(key), false),
    };
    let name = match name.to_ascii_lowercase().as_str() {
        "control" => "Ctrl".to_string(),
        "return" => "Enter".to_string(),
        lower if lower.chars().count() == 1 || (lower.starts_with('f') && lower[1..].parse::<u8>().is_ok()) => lower.to_uppercase(),
        lower => lower[..1].to_uppercase() + &lower[1..],
    };
    if right { format!("Right {name}") } else { name }
}

/// The keys that toggle dictation, a cap each, from Hyprland's list of bindings (`hyprctl binds -j`): the first one
/// Omarchy described as that, which is its own default where the owner has added others.
fn keys_of(binds: &Value) -> Option<Vec<String>> {
    let bind = binds
        .as_array()?
        .iter()
        .find(|bind| bind["description"] == TOGGLE && bind["submap"].as_str().unwrap_or_default().is_empty() && bind["release"] != true)?;
    let key = bind["key"].as_str().filter(|key| !key.is_empty())?;
    let mask = bind["modmask"].as_u64().unwrap_or(0);
    let mut caps: Vec<String> = MODIFIERS.iter().filter(|(bit, _)| mask & bit != 0).map(|(_, name)| (*name).to_string()).collect();
    caps.push(cap(key));
    Some(caps)
}

/// The keys that toggle dictation on this machine, or none where Hyprland cannot say (another compositor, a
/// binding Omarchy did not describe): the hint is then left out, never guessed.
pub async fn keys() -> Option<Vec<String>> {
    let read = gio::spawn_blocking(|| Command::new("hyprctl").args(["binds", "-j"]).stderr(Stdio::null()).output()).await;
    let output = read.ok()?.ok().filter(|output| output.status.success())?;
    keys_of(&serde_json::from_slice(&output.stdout).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bind(modmask: u64, key: &str, description: &str) -> Value {
        json!({ "modmask": modmask, "key": key, "description": description, "submap": "", "release": false, "dispatcher": "__lua" })
    }

    #[test]
    fn the_hint_is_the_first_key_omarchy_describes_as_toggling_dictation() {
        let binds =
            json!([bind(64, "A", "Ghost"), bind(8, "Alt_R", "Start dictation (push-to-talk)"), bind(8, "SPACE", TOGGLE), bind(68, "X", TOGGLE),]);
        assert_eq!(keys_of(&binds), Some(vec!["Alt".to_string(), "Space".to_string()]));
        assert_eq!(keys_of(&json!([bind(69, "x", TOGGLE)])), Some(vec!["Super".into(), "Ctrl".into(), "Shift".into(), "X".into()]));
        assert_eq!(keys_of(&json!([bind(0, "F9", TOGGLE)])), Some(vec!["F9".to_string()]));
        assert_eq!(keys_of(&json!([bind(0, "Alt_R", TOGGLE)])), Some(vec!["Right Alt".to_string()]));
    }

    #[test]
    fn there_is_no_hint_where_no_binding_is_described_so() {
        assert_eq!(keys_of(&json!([bind(64, "A", "Ghost")])), None);
        assert_eq!(keys_of(&json!({ "error": "no compositor" })), None);
        // A binding in a submap, or one that fires on release, is not the key to press from the prompt.
        let mut inside = bind(8, "SPACE", TOGGLE);
        inside["submap"] = json!("resize");
        let mut released = bind(8, "SPACE", TOGGLE);
        released["release"] = json!(true);
        assert_eq!(keys_of(&json!([inside, released])), None);
    }
}
