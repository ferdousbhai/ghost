//! The machine's one ghost and where its home keeps things.
use crate::error::{GhostError, Result};
use crate::persona::{CHARACTER_FILENAME, seeded_character};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ghost {
    pub name: String,
    pub dir: PathBuf,
}

pub const GHOST_SESSIONS_DIRNAME: &str = "sessions";
/// The home a first start makes.
const FIRST_GHOST_NAME: &str = "ghost";

/// A ghost home's directory name: no separators, no leading dot, no whitespace; at most 64.
fn is_ghost_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len()) && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
}

/// `path` made absolute against the working directory, without touching the disk.
fn absolute(path: &Path) -> PathBuf {
    crate::xdg::resolve(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")), path)
}

/// A directory is a ghost home when it holds a `character.md` (which also
/// proves it is a directory). The persona file is the one thing a ghost cannot
/// be without; everything else in a home is optional.
pub fn is_ghost_home(dir: &Path) -> bool {
    std::fs::metadata(dir.join(CHARACTER_FILENAME)).is_ok_and(|info| info.is_file())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhostPaths {
    pub session_dir: PathBuf,
    pub character_file: PathBuf,
}

pub fn ghost_paths(dir: &Path) -> GhostPaths {
    let home = absolute(dir);
    GhostPaths { session_dir: home.join(GHOST_SESSIONS_DIRNAME), character_file: home.join(CHARACTER_FILENAME) }
}

/// The machine's one ghost: the ghost home under `root`, made as `ghost` when
/// there is none. Non-directories, dot-directories, and directories without a
/// `character.md` are not homes: the root is a user directory and may hold
/// anything. More than one home is refused rather than one being picked.
pub fn the_ghost(root: &Path) -> Result<Ghost> {
    let base = absolute(root);
    std::fs::create_dir_all(&base)?;
    let mut homes = Vec::new();
    for entry in std::fs::read_dir(&base)? {
        if let Ok(name) = entry?.file_name().into_string()
            && is_ghost_name(&name)
            && is_ghost_home(&base.join(&name))
        {
            homes.push(name);
        }
    }
    homes.sort();
    if homes.len() > 1 {
        return Err(GhostError::internal(format!(
            "A machine has one ghost, and {} holds {} ({}): move all but one away.",
            base.display(),
            homes.len(),
            homes.join(", ")
        )));
    }
    let Some(name) = homes.pop() else {
        let dir = base.join(FIRST_GHOST_NAME);
        std::fs::create_dir_all(&dir)?;
        // Fail rather than clobber a character.md that appeared since the listing.
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(CHARACTER_FILENAME))?;
        file.write_all(seeded_character(FIRST_GHOST_NAME).as_bytes())?;
        return Ok(Ghost { name: FIRST_GHOST_NAME.to_string(), dir });
    };
    let dir = base.join(&name);
    Ok(Ghost { name, dir })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ghostd-test-{}", crate::random::uuid()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A ghost home with a persona.
    fn seed_ghost(root: &Path, name: &str) {
        std::fs::create_dir_all(root.join(name)).unwrap();
        std::fs::write(root.join(name).join("character.md"), format!("# {name}\n\nYou are {name}, a letterpress printer.\n")).unwrap();
    }

    #[test]
    fn is_the_one_ghost_home_under_the_root_whatever_else_is_there() {
        let root = scratch();
        seed_ghost(&root, "casper");
        // Not homes: a directory with no character.md, a dot-directory, a plain file.
        std::fs::create_dir_all(root.join("scratch")).unwrap();
        std::fs::create_dir_all(root.join(".daemon")).unwrap();
        std::fs::write(root.join(".daemon/character.md"), "# nope\n").unwrap();
        std::fs::write(root.join("README.md"), "hi\n").unwrap();
        assert_eq!(the_ghost(&root).unwrap(), Ghost { name: "casper".into(), dir: root.join("casper") });
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn is_made_as_ghost_with_a_seeded_character_where_there_is_none() {
        let root = scratch();
        let ghost = the_ghost(&root.join("fresh")).unwrap();
        assert_eq!(ghost.name, "ghost");
        assert!(is_ghost_home(&ghost.dir));
        let character = std::fs::read_to_string(ghost_paths(&ghost.dir).character_file).unwrap();
        assert!(character.starts_with("# ghost\n"));
        assert!(crate::persona::is_seeded_character("ghost", Some(&character)));
        assert!(!ghost.dir.join("conversations").exists());
        assert_eq!(the_ghost(&root.join("fresh")).unwrap(), ghost);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_root_that_holds_more_than_one() {
        let root = scratch();
        seed_ghost(&root, "mina");
        seed_ghost(&root, "casper");
        let refusal = the_ghost(&root).unwrap_err();
        assert_eq!(refusal.message, format!("A machine has one ghost, and {} holds 2 (casper, mina): move all but one away.", root.display()));
        assert!(refusal.is_internal());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ghost_paths_puts_the_character_and_conversations_inside_the_ghost_home() {
        let paths = ghost_paths(Path::new("/tmp/ghosts/casper"));
        assert_eq!(paths.session_dir, Path::new("/tmp/ghosts/casper/sessions"));
        assert_eq!(paths.character_file, Path::new("/tmp/ghosts/casper/character.md"));
        assert_eq!(ghost_paths(Path::new("/tmp/ghosts/x/../casper/")).session_dir, Path::new("/tmp/ghosts/casper/sessions"));
    }

    #[test]
    fn a_home_name_has_no_separator_leading_dot_or_whitespace() {
        for name in ["casper", "Mina-2", "a.b_c", &"x".repeat(64)] {
            assert!(is_ghost_name(name), "{name}");
        }
        for name in ["", ".daemon", "-x", "a b", "a/b", "é", &"x".repeat(65)] {
            assert!(!is_ghost_name(name), "{name}");
        }
    }
}
