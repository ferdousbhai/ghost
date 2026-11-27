//! The machine's one ghost and where its home keeps things.
use crate::error::Result;
use crate::persona::{CHARACTER_FILENAME, seeded_character};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The machine's one ghost: its home directory, `$XDG_DATA_HOME/ghost` by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ghost {
    pub dir: PathBuf,
}

/// The ghost's one conversation: the directory its commands run in, holding its log.
pub const CONVERSATION_DIRNAME: &str = "conversation";
/// The name of a ghost whose persona has no title yet, and of the persona a first start seeds.
const FIRST_GHOST_NAME: &str = "ghost";
const MAX_NAME_CHARS: usize = 64;

impl Ghost {
    /// The ghost's name: its persona's title, the leading `# ` heading of
    /// `character.md`, read now, so a rewritten persona renames it; else `ghost`.
    pub fn name(&self) -> String {
        let character = std::fs::read_to_string(self.dir.join(CHARACTER_FILENAME)).unwrap_or_default();
        let title = character.lines().find(|line| !line.trim().is_empty()).and_then(|line| line.strip_prefix("# ")).map(str::trim).unwrap_or("");
        if title.is_empty() { FIRST_GHOST_NAME.to_string() } else { title.chars().take(MAX_NAME_CHARS).collect() }
    }
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
    pub conversation_dir: PathBuf,
    pub character_file: PathBuf,
}

pub fn ghost_paths(dir: &Path) -> GhostPaths {
    let home = absolute(dir);
    GhostPaths { conversation_dir: home.join(CONVERSATION_DIRNAME), character_file: home.join(CHARACTER_FILENAME) }
}

/// The machine's one ghost, whose home is `dir`: made with a seeded persona
/// when it holds none.
pub fn the_ghost(dir: &Path) -> Result<Ghost> {
    let dir = absolute(dir);
    if !is_ghost_home(&dir) {
        std::fs::create_dir_all(&dir)?;
        // Fail rather than clobber a character.md that appeared since the check.
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(CHARACTER_FILENAME))?;
        file.write_all(seeded_character(FIRST_GHOST_NAME).as_bytes())?;
    }
    Ok(Ghost { dir })
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
    fn seed(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join("conversation")).unwrap();
        std::fs::write(dir.join("character.md"), format!("# {name}\n\nYou are {name}, a letterpress printer.\n")).unwrap();
    }

    #[test]
    fn is_the_home_there_named_by_its_personas_title() {
        let root = scratch();
        seed(&root.join("home"), "Casper");
        let ghost = the_ghost(&root.join("home")).unwrap();
        assert_eq!((ghost.dir.clone(), ghost.name()), (root.join("home"), "Casper".to_string()));
        // A rewritten persona renames it; one without a title is `ghost`.
        std::fs::write(root.join("home/character.md"), "\n# Wraith \n\nYou are Wraith.\n").unwrap();
        assert_eq!(ghost.name(), "Wraith");
        std::fs::write(root.join("home/character.md"), "You are nobody in particular.\n").unwrap();
        assert_eq!(ghost.name(), "ghost");
        std::fs::write(root.join("home/character.md"), format!("# {}\n", "n".repeat(100))).unwrap();
        assert_eq!(ghost.name().len(), 64);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn is_made_with_a_seeded_persona_where_there_is_none() {
        let root = scratch();
        let ghost = the_ghost(&root.join("fresh")).unwrap();
        assert_eq!(ghost.name(), "ghost");
        assert!(is_ghost_home(&ghost.dir));
        let character = std::fs::read_to_string(ghost_paths(&ghost.dir).character_file).unwrap();
        assert!(crate::persona::is_seeded_character("ghost", Some(&character)));
        std::fs::remove_dir_all(root).unwrap();
    }
}
