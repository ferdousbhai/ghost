//! The stable policy sections the ghost's system prompt carries, beside the
//! character's own. Each holds only what a ghost must follow before it would
//! think to look anything up; the `ghost` CLI documents itself: `ghost help
//! <topic>` prints each recipe the Ghost section indexes.
use crate::persona::{FIRST_MEETING_SECTION, quoted_path};
use std::path::Path;

/// Asking the owner (the model's `ask` tool; its description says how), that a
/// command dies with the turn, and the index of `ghost help` recipes.
pub const GHOST_POLICY: &str = "## Ghost\nAsk, with the ask tool, when a choice is the owner's or you would otherwise guess. A command you start ends with the turn. Read the recipe first, `ghost help <topic>`: background (work outliving this turn, or for later), memory (notes), browser (a website), products (getting or fixing one of the owner's apps), self (changing or restarting yourself).";

/// The owner's own directory: deliverables and the ghost's notes.
pub fn render_owner_context_policy(documents_dir: &Path) -> String {
    format!(
        "## Owner context\n{} is the owner's documents directory: a file made for them goes where they asked, else here. Its `Notes` folder (Markdown, shared with the owner) is your state across conversations, kept current unasked: read the note that covers a task before starting, and update it in the same turn a fact arrives or the task advances, rather than add a second. `Reminders/<List>.md` (`- [ ] text 📅 YYYY-MM-DD`) is the owner's to-do list: add what now waits on them, tick what they say is done; your own later work is a timer (background). Nothing is preloaded. Store no secrets there.",
        quoted_path(documents_dir)
    )
}

/// The policy sections the ghost carries after its character, in prompt
/// order; the budget test below measures exactly this list.
pub fn stable_policy_sections(documents: &Path, first_meeting: bool) -> Vec<String> {
    let mut sections = vec![GHOST_POLICY.to_string(), render_owner_context_policy(documents)];
    if first_meeting {
        sections.push(FIRST_MEETING_SECTION.to_string());
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help_topics::HELP_TOPICS;
    use crate::js_text::utf16_len;
    use crate::persona::{GhostSystemPromptInput, build_ghost_system_prompt};
    use regex::Regex;

    #[test]
    fn owner_context_names_the_documents_directory_and_keeps_skill_paths_out() {
        let policy = render_owner_context_policy(Path::new("/home/owner/Documents"));
        assert!(policy.contains("\"/home/owner/Documents\""));
        assert!(!policy.contains("SKILL.md"));
        assert!(!policy.contains(".agents/skills"));
    }

    #[test]
    fn the_ghost_section_keeps_asking_the_owner_in_the_prompt() {
        assert!(GHOST_POLICY.contains("Ask, with the ask tool, when a choice is the owner's or you would otherwise guess."));
    }

    #[test]
    fn the_ghost_section_indexes_every_help_topic_by_name() {
        assert!(GHOST_POLICY.contains("`ghost help <topic>`"));
        let missing: Vec<&str> =
            HELP_TOPICS.iter().copied().filter(|topic| !Regex::new(&format!(r"\b{topic}\b")).unwrap().is_match(GHOST_POLICY)).collect();
        assert_eq!(missing, Vec::<&str>::new());
    }

    // A size ratchet over the stable system-prompt policy text.
    //
    // Every section below is rendered into every session. The system prompt is
    // a budget, not a place to put things: growth has to be a deliberate
    // decision rather than the accumulated residue of unrelated commits.
    //
    // Each ceiling is the exact rendered size (in UTF-16 code units, as it was
    // first measured) at the time it was set, so any added character fails
    // here. The way to raise one is to lower another or to justify it in the
    // commit message that raises it. Only the stable text is budgeted: the
    // character body is the ghost's own and is out of scope.

    /// Fixed inputs: every ceiling is only meaningful against the same rendering.
    const GHOST_NAME: &str = "casper";
    const HOME_DIR: &str = "/home/owner/ghosts/casper";
    const DOCUMENTS: &str = "/home/owner/Documents";

    /// The exact rendered size of each section when its ceiling was last set.
    const CEILINGS: [(&str, usize); 4] = [("Character file", 423), ("Ghost", 360), ("Owner context", 611), ("First meeting", 321)];
    const TOTAL_CEILING: usize = 1715;

    /// The character-file section is internal to the prompt builder, so it is
    /// measured where it is shipped: in a prompt built with an unwritten
    /// character, split back into its `## `-headed sections.
    fn prompt_section(heading: &str) -> String {
        let prompt = build_ghost_system_prompt(&GhostSystemPromptInput {
            ghost_name: GHOST_NAME,
            character: None,
            home_dir: Path::new(HOME_DIR),
            extra_sections: &[],
        });
        let mut sections = Vec::new();
        for part in prompt.trim_end().split("\n\n") {
            if part.starts_with("## ") || sections.is_empty() {
                sections.push(part.to_string());
            } else {
                let last: &mut String = sections.last_mut().unwrap();
                last.push_str("\n\n");
                last.push_str(part);
            }
        }
        sections.into_iter().find(|section| section.starts_with(heading)).unwrap_or_else(|| panic!("The system prompt no longer renders {heading}."))
    }

    /// Every stable section's size by its heading: the list the session host renders, at its largest (first meeting).
    fn measure_stable_policy() -> Vec<(String, usize)> {
        let mut sections = vec![prompt_section("## Character file")];
        sections.extend(stable_policy_sections(Path::new(DOCUMENTS), true));
        sections.iter().map(|section| (section["## ".len()..section.find('\n').expect("a heading line")].to_string(), utf16_len(section))).collect()
    }

    /// The whole budget, so a failure names the offender instead of one number.
    fn budget_table(sizes: &[(String, usize)]) -> String {
        let ceiling = |name: &str| CEILINGS.iter().find(|(known, _)| *known == name).map(|(_, size)| *size);
        let row = |name: &str, size: usize, ceiling: Option<usize>| match ceiling {
            Some(ceiling) => format!("  {name:<18}{size:>6} / {ceiling:>6}  {:+}", size as i64 - ceiling as i64),
            None => format!("  {name:<18}{size:>6} / {:>6}  no ceiling", "-"),
        };
        let mut rows: Vec<String> = sizes.iter().map(|(name, size)| row(name, *size, ceiling(name))).collect();
        rows.push(row("TOTAL", sizes.iter().map(|(_, size)| size).sum(), Some(TOTAL_CEILING)));
        format!("stable prompt policy, chars / ceiling:\n{}", rows.join("\n"))
    }

    #[test]
    fn every_section_is_exactly_its_ceiling() {
        let sizes = measure_stable_policy();
        // Every budgeted section needs a ceiling, or a new one could reach the
        // prompt without ever being counted.
        let mut measured: Vec<&str> = sizes.iter().map(|(name, _)| name.as_str()).collect();
        let mut budgeted: Vec<&str> = CEILINGS.iter().map(|(name, _)| *name).collect();
        measured.sort_unstable();
        budgeted.sort_unstable();
        assert_eq!(measured, budgeted);
        for (name, size) in &sizes {
            let ceiling = CEILINGS.iter().find(|(known, _)| known == name).map(|(_, size)| *size).unwrap_or(0);
            assert!(*size <= ceiling, "{name} is over its ceiling\n{}", budget_table(&sizes));
            // The text was carried over byte for byte, so it is not smaller either.
            assert_eq!(*size, ceiling, "{name} changed size\n{}", budget_table(&sizes));
        }
    }

    #[test]
    fn the_whole_stable_policy_is_at_or_below_the_total_ceiling() {
        let sizes = measure_stable_policy();
        assert!(sizes.iter().map(|(_, size)| size).sum::<usize>() <= TOTAL_CEILING, "{}", budget_table(&sizes));
    }

    #[test]
    fn the_first_meeting_is_carried_only_while_the_character_is_unwritten() {
        assert_eq!(stable_policy_sections(Path::new(DOCUMENTS), false).len(), 2);
        assert_eq!(stable_policy_sections(Path::new(DOCUMENTS), true).last().map(String::as_str), Some(FIRST_MEETING_SECTION));
    }
}
