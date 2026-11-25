//! A ghost home's persona file, read whole and replaced by one rename.
use crate::error::{GhostError, Result};
use crate::js_text::utf16_len;
use crate::persona::{CHARACTER_FILENAME, CharacterFile, MAX_CHARACTER_BODY_LENGTH, character_body_too_long};
use crate::private_file::write_text_atomic;
use std::path::Path;

/// The persona in the ghost home `dir`, or None when it has none.
/// `enforce_limit: false` is for the owner's editor: an oversize hand-edited
/// file must still load so it can be shortened, while every prompt-bound
/// reader passes `true` and gets the refusal.
pub fn read_character(dir: &Path, enforce_limit: bool) -> Result<Option<CharacterFile>> {
    let body = match std::fs::read(dir.join(CHARACTER_FILENAME)) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if enforce_limit && character_body_too_long(&body) {
        return Err(GhostError::new(
            "limit_exceeded",
            format!(
                "{CHARACTER_FILENAME} may be at most {MAX_CHARACTER_BODY_LENGTH} characters; it contains {}. Shorten the file before starting a session.",
                utf16_len(&body)
            ),
            400,
        ));
    }
    Ok(Some(CharacterFile { body }))
}

/// The owner's persona edits land here so an oversize body is refused at
/// write time, not discovered when the next cold session fails to start.
pub fn write_character(dir: &Path, body: &str) -> Result<()> {
    if character_body_too_long(body) {
        return Err(GhostError::new(
            "limit_exceeded",
            format!(
                "{CHARACTER_FILENAME} may be at most {MAX_CHARACTER_BODY_LENGTH} characters; that body is {}. Nothing was written.",
                utf16_len(body)
            ),
            400,
        ));
    }
    Ok(write_text_atomic(&dir.join(CHARACTER_FILENAME), body)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A ghost home on disk, written as raw bytes rather than through this
    /// module's writer, so it witnesses the reader independently.
    const CHARACTER_MD: &str = "# Casper

You are Casper, the ghost of a working typographer and letterpress printer.

## Voice
- Dry, unhurried, specific. You notice materials before ideas.
";

    struct Fixture {
        root: PathBuf,
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ghost-home-test-{}", crate::random::uuid()));
            let dir = root.join("casper");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("character.md"), CHARACTER_MD).unwrap();
            Self { root, dir }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn reads_the_persona_body() {
        let fixture = Fixture::new();
        assert!(read_character(&fixture.dir, true).unwrap().unwrap().body.starts_with("# Casper"));
    }

    #[test]
    fn serves_a_body_with_no_leading_heading_unchanged() {
        let fixture = Fixture::new();
        std::fs::write(fixture.dir.join(CHARACTER_FILENAME), "I keep the old ledgers.\n").unwrap();
        assert_eq!(read_character(&fixture.dir, true).unwrap(), Some(CharacterFile { body: "I keep the old ledgers.\n".into() }));
    }

    #[test]
    fn returns_none_when_there_is_no_character_file() {
        let fixture = Fixture::new();
        assert_eq!(read_character(&fixture.root, true).unwrap(), None);
    }

    #[test]
    fn refuses_to_read_an_oversized_character_file_unless_the_owner_is_editing_it() {
        let fixture = Fixture::new();
        let oversized = "x".repeat(MAX_CHARACTER_BODY_LENGTH + 1);
        std::fs::write(fixture.dir.join(CHARACTER_FILENAME), &oversized).unwrap();
        let refusal = read_character(&fixture.dir, true).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("limit_exceeded", 400));
        assert_eq!(refusal.message, "character.md may be at most 20000 characters; it contains 20001. Shorten the file before starting a session.");
        assert_eq!(read_character(&fixture.dir, false).unwrap().unwrap().body, oversized);
    }

    #[test]
    fn refuses_an_oversized_owner_edit_before_writing_counting_utf16_code_units() {
        let fixture = Fixture::new();
        let original = read_character(&fixture.dir, true).unwrap().unwrap().body;
        let allowed = "🙂".repeat(MAX_CHARACTER_BODY_LENGTH / 2);
        write_character(&fixture.dir, &allowed).unwrap();
        assert_eq!(read_character(&fixture.dir, true).unwrap().unwrap().body, allowed);
        let refusal = write_character(&fixture.dir, &format!("{allowed}x")).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("limit_exceeded", 400));
        assert_eq!(refusal.message, "character.md may be at most 20000 characters; that body is 20001. Nothing was written.");
        assert_eq!(read_character(&fixture.dir, true).unwrap().unwrap().body, allowed);
        assert_ne!(original, allowed);
    }
}
