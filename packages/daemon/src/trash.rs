//! Recoverable deletion: `gio trash` moves a path into the freedesktop Trash
//! (the home trash, or its filesystem's `.Trash-$UID`) by rename, never by
//! copy-then-delete. Where it cannot, it refuses and nothing is removed.
use crate::abort::Abort;
use crate::env::Env;
use crate::error::{GhostError, Result};
use crate::process::{CommandFailure, run_command};
use std::path::Path;
use std::time::Duration;

/// A rename is quick; this only bounds a `gio` that hangs.
const TRASH_TIMEOUT: Duration = Duration::from_secs(60);

pub fn trash_path(path: &Path, env: &Env) -> Result<()> {
    let shown = path.to_string_lossy();
    let reason = match run_command("gio", &["trash", "--", &shown], env, None, TRASH_TIMEOUT, &Abort::new()) {
        Ok(result) if result.code == 0 => return Ok(()),
        Ok(result) => match crate::js_text::trim(&result.stderr).rsplit('\n').next() {
            Some(line) if !line.is_empty() => line.to_string(),
            _ => format!("Command failed: gio trash -- {shown}"),
        },
        Err(CommandFailure::Missing) => "spawn gio ENOENT".to_string(),
        Err(CommandFailure::Other(message)) => message,
    };
    Err(GhostError::new("trash_failed", format!("Could not move {shown} to Trash; nothing was deleted. {reason}"), 500))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A scratch root, and an environment whose home trash is inside it.
    fn scratch() -> (PathBuf, Env) {
        let root = std::env::temp_dir().join(format!("ghostd-trash-{}", crate::random::uuid()));
        std::fs::create_dir_all(&root).unwrap();
        let env = Env::from([
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
            ("HOME".to_string(), root.display().to_string()),
            ("XDG_DATA_HOME".to_string(), root.join("data").display().to_string()),
        ]);
        (root, env)
    }

    #[test]
    fn moves_a_directory_into_the_freedesktop_trash_with_a_restorable_trashinfo_suffixing_a_second_copy() {
        let (root, env) = scratch();
        if crate::env::which("gio", &env).is_none() {
            eprintln!("skipped: gio is not installed");
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        for _ in 0..2 {
            std::fs::create_dir(root.join("casper")).unwrap();
            std::fs::write(root.join("casper/keepsake.md"), "remember this\n").unwrap();
            trash_path(&root.join("casper"), &env).unwrap();
            assert!(!root.join("casper").exists());
        }
        let trash = root.join("data/Trash");
        assert_eq!(std::fs::read_to_string(trash.join("files/casper/keepsake.md")).unwrap(), "remember this\n");
        assert!(trash.join("files/casper.2").exists());
        let info = std::fs::read_to_string(trash.join("info/casper.trashinfo")).unwrap();
        assert!(info.contains(&format!("Path={}\n", root.join("casper").display())), "{info}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn says_nothing_was_deleted_when_gio_cannot_trash_the_path() {
        let (root, env) = scratch();
        let refusal = trash_path(&root.join("missing"), &env).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("trash_failed", 500));
        assert!(refusal.message.starts_with(&format!("Could not move {} to Trash; nothing was deleted. ", root.join("missing").display())));
        // Without gio at all, the refusal is the same and says why.
        let bare = Env::from([("PATH".to_string(), root.display().to_string())]);
        let refusal = trash_path(&root.join("missing"), &bare).unwrap_err();
        assert_eq!(refusal.code, "trash_failed");
        assert!(refusal.message.ends_with("nothing was deleted. spawn gio ENOENT"), "{}", refusal.message);
        std::fs::remove_dir_all(root).unwrap();
    }
}
