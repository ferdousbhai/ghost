//! Lengths and cuts of text, counted in characters. A cut never splits one.

pub fn len(text: &str) -> usize {
    text.chars().count()
}

/// The first `count` characters, or all of `text`.
pub fn prefix(text: &str, count: usize) -> &str {
    text.char_indices().nth(count).map_or(text, |(at, _)| &text[..at])
}

/// The last `count` characters, or all of `text`.
pub fn suffix(text: &str, count: usize) -> &str {
    let total = len(text);
    if total <= count { text } else { text.char_indices().nth(total - count).map_or("", |(at, _)| &text[at..]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_and_cuts_in_characters() {
        assert_eq!(len("a🙂é"), 3);
        assert_eq!((prefix("a🙂b", 2), prefix("a🙂b", 0), prefix("ab", 9)), ("a🙂", "", "ab"));
        assert_eq!((suffix("a🙂b", 2), suffix("a🙂b", 0), suffix("ab", 9)), ("🙂b", "", "ab"));
    }
}
