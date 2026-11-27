//! The ghost's topic documents (CONTRACTS.md "Topic documents"): `topics/` in
//! the ghost home, one Markdown file per topic the conversation has dealt
//! with, which the ghost brings up to date at each handoff. They are plain
//! files, the ghost's to write and the owner's to read, edit and delete.
//!
//! Ghost keeps no index of them: this lists the directory, each file with its
//! first line, whenever one is needed.
use crate::persona::quoted_path;
use crate::text;
use std::io::Read;
use std::path::Path;

/// A summary line is cut here, so one long first line cannot fill the index.
const SUMMARY_MAX: usize = 120;
/// As much of a file as is read to find its first line.
const SUMMARY_READ: u64 = 2048;

/// A document's summary: its first line with any text, without a heading's `#`.
fn summary(path: &Path) -> String {
    let mut start = Vec::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(SUMMARY_READ).read_to_end(&mut start);
    }
    let start = String::from_utf8_lossy(&start);
    let line = start.lines().map(|line| line.trim_start_matches('#').trim()).find(|line| !line.is_empty()).unwrap_or_default();
    text::prefix(line, SUMMARY_MAX).trim_end().to_string()
}

/// How many topic documents `dir` holds.
pub fn count(dir: &Path) -> usize {
    names(dir).len()
}

/// The `.md` files of `dir`, by name; none when there is no such directory.
fn names(dir: &Path) -> Vec<String> {
    let Ok(listing) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = listing
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".md") && !name.starts_with('.') && !name.contains('\n'))
        .collect();
    names.sort_unstable();
    names
}

/// One line per document, `- <file>: <summary>`, by name; None when there are none.
pub fn index(dir: &Path) -> Option<String> {
    let lines: Vec<String> = names(dir)
        .into_iter()
        .map(|name| match summary(&dir.join(&name)) {
            summary if summary.is_empty() => format!("- {name}"),
            summary => format!("- {name}: {summary}"),
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// What a conversation is told of the documents where it opens: where they
/// are, when to read one, and the index. None when there are none.
pub fn opening(dir: &Path) -> Option<String> {
    index(dir)
        .map(|index| format!("Your topic documents are in {}; `cat` one when the conversation returns to its topic:\n{index}", quoted_path(dir)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_is_each_markdown_file_by_name_with_its_first_line() {
        let root = std::env::temp_dir().join(format!("ghostd-topics-{}", crate::random::uuid()));
        let dir = root.join("topics");
        // No directory yet: no documents, and nothing to say.
        assert_eq!((count(&dir), index(&dir), opening(&dir)), (0, None, None));
        std::fs::create_dir_all(dir.join("folder.md")).unwrap();
        assert_eq!(index(&dir), None);

        std::fs::write(dir.join("taxes-2026.md"), "\n# Filing the 2026 return  \n\nThe accountant is Noor.\n").unwrap();
        std::fs::write(dir.join("boat-trip.md"), "The Heron leaves the north pier at nine on 2026-12-04.\nBooked.\n").unwrap();
        std::fs::write(dir.join("empty.md"), "").unwrap();
        std::fs::write(dir.join("long.md"), format!("{}\n", "é".repeat(300))).unwrap();
        // Not documents: another kind of file, and a hidden one.
        std::fs::write(dir.join("scratch.txt"), "not a topic").unwrap();
        std::fs::write(dir.join(".draft.md"), "half written").unwrap();

        assert_eq!(count(&dir), 4);
        assert_eq!(
            index(&dir).unwrap(),
            format!(
                "- boat-trip.md: The Heron leaves the north pier at nine on 2026-12-04.\n- empty.md\n- long.md: {}\n- taxes-2026.md: Filing the 2026 return",
                "é".repeat(SUMMARY_MAX)
            )
        );
        let opening = opening(&dir).unwrap();
        assert!(opening.starts_with(&format!(
            "Your topic documents are in \"{}\"; `cat` one when the conversation returns to its topic:\n- boat-trip.md: ",
            dir.display()
        )));

        // Derived each time: the owner's edit and their deletion show at once.
        std::fs::write(dir.join("boat-trip.md"), "Cancelled.\n").unwrap();
        std::fs::remove_file(dir.join("long.md")).unwrap();
        std::fs::remove_file(dir.join("empty.md")).unwrap();
        assert_eq!(index(&dir).unwrap(), "- boat-trip.md: Cancelled.\n- taxes-2026.md: Filing the 2026 return");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
