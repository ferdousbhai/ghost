//! The machine's one ghost and where its home keeps things.
use crate::error::{GhostError, Result};
use crate::persona::{CHARACTER_FILENAME, seeded_character};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The machine's one ghost: its home directory, `$XDG_DATA_HOME/ghost` by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ghost {
    pub dir: PathBuf,
}

pub const GHOST_SESSIONS_DIRNAME: &str = "sessions";
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
    pub session_dir: PathBuf,
    pub character_file: PathBuf,
}

pub fn ghost_paths(dir: &Path) -> GhostPaths {
    let home = absolute(dir);
    GhostPaths { session_dir: home.join(GHOST_SESSIONS_DIRNAME), character_file: home.join(CHARACTER_FILENAME) }
}

/// The machine's one ghost, whose home is `dir`. A home earlier versions kept
/// as the one directory with a `character.md` under `earlier_root` (they
/// allowed several, under `~/ghosts`) is moved here once, when `dir` is not
/// yet a home. With neither, the home is made with a seeded persona.
pub fn the_ghost(dir: &Path, earlier_root: &Path) -> Result<Ghost> {
    let dir = absolute(dir);
    if is_ghost_home(&dir) {
        return Ok(Ghost { dir });
    }
    let earlier: Vec<PathBuf> = std::fs::read_dir(earlier_root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.')) && is_ghost_home(path))
                .collect()
        })
        .unwrap_or_default();
    if let [earlier] = earlier.as_slice() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // An empty directory in the way is not a home; anything in it is kept by refusing.
        let _ = std::fs::remove_dir(&dir);
        std::fs::rename(earlier, &dir).map_err(|error| {
            GhostError::internal(format!("Could not move the ghost home {} to {}: {error}. Move it there by hand.", earlier.display(), dir.display()))
        })?;
        let _ = std::fs::remove_dir(earlier_root);
        return Ok(Ghost { dir });
    }
    if earlier.len() > 1 {
        let names: Vec<String> = earlier.iter().map(|path| path.display().to_string()).collect();
        return Err(GhostError::internal(format!(
            "A machine has one ghost, and earlier homes are {}: move the one to keep to {} and the rest away.",
            names.join(", "),
            dir.display()
        )));
    }
    std::fs::create_dir_all(&dir)?;
    // Fail rather than clobber a character.md that appeared since the check.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(CHARACTER_FILENAME))?;
    file.write_all(seeded_character(FIRST_GHOST_NAME).as_bytes())?;
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
        std::fs::create_dir_all(dir.join("sessions/c1")).unwrap();
        std::fs::write(dir.join("character.md"), format!("# {name}\n\nYou are {name}, a letterpress printer.\n")).unwrap();
    }

    #[test]
    fn is_the_home_there_named_by_its_personas_title() {
        let root = scratch();
        seed(&root.join("home"), "Casper");
        let ghost = the_ghost(&root.join("home"), &root.join("ghosts")).unwrap();
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
        let ghost = the_ghost(&root.join("fresh"), &root.join("ghosts")).unwrap();
        assert_eq!(ghost.name(), "ghost");
        assert!(is_ghost_home(&ghost.dir));
        let character = std::fs::read_to_string(ghost_paths(&ghost.dir).character_file).unwrap();
        assert!(crate::persona::is_seeded_character("ghost", Some(&character)));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moves_the_one_home_an_earlier_version_kept_and_refuses_to_choose_between_several() {
        let root = scratch();
        let earlier = root.join("ghosts");
        seed(&earlier.join("casper"), "Casper");
        // Not homes: a directory with no character.md, a dot-directory, a plain file.
        std::fs::create_dir_all(earlier.join("scratch")).unwrap();
        seed(&earlier.join(".hidden"), "Nope");
        std::fs::write(earlier.join("README.md"), "hi\n").unwrap();
        let home = root.join(".local/share/ghost");
        std::fs::create_dir_all(&home).unwrap();
        let ghost = the_ghost(&home, &earlier).unwrap();
        assert_eq!((ghost.dir.clone(), ghost.name()), (home.clone(), "Casper".to_string()));
        assert!(home.join("sessions/c1").is_dir() && !earlier.join("casper").exists());
        // Once moved it is found where it is, and nothing is moved again.
        seed(&earlier.join("later"), "Later");
        assert_eq!(the_ghost(&home, &earlier).unwrap().name(), "Casper");

        let several = scratch();
        seed(&several.join("ghosts/a"), "A");
        seed(&several.join("ghosts/b"), "B");
        let refused = the_ghost(&several.join("home"), &several.join("ghosts")).unwrap_err().message;
        assert!(refused.contains("A machine has one ghost"), "{refused}");
        assert!(!several.join("home").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(several).unwrap();
    }
}
