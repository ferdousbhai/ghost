//! The ghost home: the one directory that is the machine's ghost. Where it
//! keeps things, its name, and its character file, read whole and replaced by
//! one rename.
use crate::error::{GhostError, Result};
use crate::private_file::write_text_atomic;
use crate::text;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) const CHARACTER_FILENAME: &str = "character.md";
pub(crate) const MAX_CHARACTER_BODY_LENGTH: usize = 20_000;
/// The name of a ghost whose character has no title.
const UNTITLED: &str = "ghost";
const MAX_NAME_CHARS: usize = 64;

/// The character a new ghost home starts with.
const SEEDED_CHARACTER: &str = "# ghost

You are ghost.

## How you write

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Everything worth keeping — the owner's facts, decisions, and tasks, and your own
reflections — is a note in the owner's documents, where the ghost and the
owner can read it. This file is only who you are.
";

/// No character yet: nothing written, or the seed untouched.
pub(crate) fn is_seeded_character(character: Option<&str>) -> bool {
    character.is_none_or(|text| text.trim().is_empty() || text == SEEDED_CHARACTER)
}

fn too_long(rest: &str) -> GhostError {
    GhostError::new("limit_exceeded", format!("{CHARACTER_FILENAME} may be at most {MAX_CHARACTER_BODY_LENGTH} characters; {rest}"), 400)
}

/// The ghost home, `$XDG_DATA_HOME/ghost` by default: an absolute directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home {
    pub(crate) dir: PathBuf,
}

impl Home {
    /// The home at the absolute `dir`, made with the seeded character when it holds none.
    pub(crate) fn open(dir: PathBuf) -> Result<Self> {
        let home = Self { dir };
        if !std::fs::metadata(home.character_file()).is_ok_and(|info| info.is_file()) {
            std::fs::create_dir_all(&home.dir)?;
            // Fail rather than clobber a character.md that appeared since the check.
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(home.character_file())?;
            file.write_all(SEEDED_CHARACTER.as_bytes())?;
        }
        Ok(home)
    }

    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The ghost's one conversation: the directory its commands run in, holding its log.
    pub(crate) fn conversation_dir(&self) -> PathBuf {
        self.dir.join("conversation")
    }

    /// The ghost's topic documents (`topics.rs`), which outlive the conversation.
    pub(crate) fn topics_dir(&self) -> PathBuf {
        self.dir.join("topics")
    }

    pub(crate) fn character_file(&self) -> PathBuf {
        self.dir.join(CHARACTER_FILENAME)
    }

    /// The ghost's name: its character's title, the leading `# ` heading of
    /// `character.md`, read now, so a rewritten character renames it; else `ghost`.
    pub(crate) fn name(&self) -> String {
        let character = std::fs::read_to_string(self.character_file()).unwrap_or_default();
        let title = character.lines().find(|line| !line.trim().is_empty()).and_then(|line| line.strip_prefix("# ")).map(str::trim).unwrap_or("");
        if title.is_empty() { UNTITLED.to_string() } else { title.chars().take(MAX_NAME_CHARS).collect() }
    }

    /// The character, or None when the home has none. `enforce_limit: false`
    /// is for the owner's editor: an oversize hand-edited file must still load
    /// so it can be shortened, while every prompt-bound reader passes `true`
    /// and gets the refusal.
    pub(crate) fn read_character(&self, enforce_limit: bool) -> Result<Option<String>> {
        let body = match std::fs::read(self.character_file()) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let length = text::len(&body);
        if enforce_limit && length > MAX_CHARACTER_BODY_LENGTH {
            return Err(too_long(&format!("it contains {length}. Shorten the file before the next turn.")));
        }
        Ok(Some(body))
    }

    /// The owner's edits land here so an oversize body is refused at write
    /// time, not discovered when the next turn fails to start.
    pub(crate) fn write_character(&self, body: &str) -> Result<()> {
        let length = text::len(body);
        if length > MAX_CHARACTER_BODY_LENGTH {
            return Err(too_long(&format!("that body is {length}. Nothing was written.")));
        }
        Ok(write_text_atomic(&self.character_file(), body)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory and the home `casper` in it, its character written
    /// as raw bytes rather than through this module's writer, so it witnesses
    /// the reader independently.
    struct Fixture {
        root: PathBuf,
        home: Home,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ghost-home-test-{}", crate::random::uuid()));
            let home = Home { dir: root.join("casper") };
            std::fs::create_dir_all(home.dir()).unwrap();
            std::fs::write(home.character_file(), "# Casper\n\nYou are Casper, a letterpress printer.\n").unwrap();
            Self { root, home }
        }

        fn write(&self, character: &str) {
            std::fs::write(self.home.character_file(), character).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn is_named_by_its_characters_title() {
        let fixture = Fixture::new();
        let home = Home::open(fixture.home.dir.clone()).unwrap();
        assert_eq!((home.dir(), home.name().as_str()), (fixture.root.join("casper").as_path(), "Casper"));
        assert_eq!((home.conversation_dir(), home.topics_dir()), (home.dir.join("conversation"), home.dir.join("topics")));
        // A rewritten character renames it; one without a title is `ghost`.
        fixture.write("\n# Wraith \n\nYou are Wraith.\n");
        assert_eq!(home.name(), "Wraith");
        fixture.write("You are nobody in particular.\n");
        assert_eq!(home.name(), "ghost");
        fixture.write(&format!("# {}\n", "n".repeat(100)));
        assert_eq!(home.name().len(), 64);
    }

    #[test]
    fn is_made_with_the_seeded_character_where_there_is_none() {
        let fixture = Fixture::new();
        let home = Home::open(fixture.root.join("fresh")).unwrap();
        assert_eq!(home.name(), "ghost");
        assert_eq!(home.read_character(true).unwrap().as_deref(), Some(SEEDED_CHARACTER));
        // Opening it again leaves what is there.
        std::fs::write(home.character_file(), "# Mina\n").unwrap();
        assert_eq!(Home::open(home.dir.clone()).unwrap().name(), "Mina");
    }

    #[test]
    fn knows_its_own_seed_and_nothing_else() {
        assert!(SEEDED_CHARACTER.starts_with("# ghost\n\nYou are ghost.\n\n## How you write\n"));
        assert!(!is_seeded_character(Some(&SEEDED_CHARACTER.replace("You are ghost.", "You are Mina, a printer."))));
        assert!(is_seeded_character(None));
        assert!(is_seeded_character(Some(" \n")));
        assert!(is_seeded_character(Some(SEEDED_CHARACTER)));
    }

    #[test]
    fn reads_the_character_whole_and_none_where_there_is_no_file() {
        let fixture = Fixture::new();
        assert!(fixture.home.read_character(true).unwrap().unwrap().starts_with("# Casper"));
        // A body with no leading heading is served unchanged.
        fixture.write("I keep the old ledgers.\n");
        assert_eq!(fixture.home.read_character(true).unwrap().as_deref(), Some("I keep the old ledgers.\n"));
        assert_eq!(Home { dir: fixture.root.clone() }.read_character(true).unwrap(), None);
    }

    #[test]
    fn refuses_to_read_an_oversized_character_file_unless_the_owner_is_editing_it() {
        let fixture = Fixture::new();
        let oversized = "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1);
        fixture.write(&oversized);
        let refusal = fixture.home.read_character(true).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("limit_exceeded", 400));
        assert_eq!(refusal.message, "character.md may be at most 20000 characters; it contains 20001. Shorten the file before the next turn.");
        assert_eq!(fixture.home.read_character(false).unwrap().unwrap(), oversized);
    }

    #[test]
    fn refuses_an_oversized_owner_edit_before_writing_counting_characters() {
        let fixture = Fixture::new();
        let allowed = "🙂".repeat(MAX_CHARACTER_BODY_LENGTH);
        fixture.home.write_character(&allowed).unwrap();
        assert_eq!(fixture.home.read_character(true).unwrap().unwrap(), allowed);
        let refusal = fixture.home.write_character(&format!("{allowed}x")).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("limit_exceeded", 400));
        assert_eq!(refusal.message, "character.md may be at most 20000 characters; that body is 20001. Nothing was written.");
        assert_eq!(fixture.home.read_character(true).unwrap().unwrap(), allowed);
    }
}
