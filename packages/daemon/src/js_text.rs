//! Text measured and trimmed the way the earlier (JavaScript) daemon did, so
//! every limit a client or a stored file was checked against keeps its exact
//! value: lengths are UTF-16 code units, and whitespace is JavaScript's.
//! Unlike JavaScript, a cut never lands inside a character.

/// The length JavaScript's `.length` gives: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The longest prefix of at most `units` UTF-16 code units that ends on a character.
pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, character) in text.char_indices() {
        used += character.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

/// The longest suffix of at most `units` UTF-16 code units that starts on a character.
pub fn utf16_suffix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, character) in text.char_indices().rev() {
        used += character.len_utf16();
        if used > units {
            return &text[at + character.len_utf8()..];
        }
    }
    text
}

/// What JavaScript's `trim` removes: its white space and line terminators.
pub fn is_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_and_cuts_in_utf16_units_without_splitting_a_character() {
        assert_eq!(utf16_len("a🙂é"), 4);
        assert_eq!(utf16_prefix("a🙂b", 3), "a🙂");
        assert_eq!(utf16_prefix("a🙂b", 2), "a");
        assert_eq!(utf16_prefix("ab", 9), "ab");
        assert_eq!(utf16_suffix("a🙂b", 3), "🙂b");
        assert_eq!(utf16_suffix("a🙂b", 2), "b");
        assert_eq!(utf16_suffix("ab", 9), "ab");
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(trim("\u{feff} \u{a0}x y\u{2028}\n"), "x y");
        assert_eq!(trim_end(" x \t"), " x");
        // U+0085 is white space to Rust and not to JavaScript.
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }
}
