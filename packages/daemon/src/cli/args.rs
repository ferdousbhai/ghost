//! The `ghost` command line's argument parser: strict, with bare words
//! allowed anywhere. `--name`, `--name=value` or `--name value`, the short
//! `-h`, `-q` and `-v`, and `--` before words that start with a dash.
use super::CliError;

/// The flags every verb takes.
pub(crate) const COMMON: [&str; 4] = ["help", "json", "quiet", "version"];
const SHORT: [(&str, &str); 3] = [("-h", "help"), ("-q", "quiet"), ("-v", "version")];

/// What a command line held: the bare words in order, and each flag given
/// with its value when it takes one (the last one given wins).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedArgs {
    pub positionals: Vec<String>,
    pub flags: Vec<(&'static str, Option<String>)>,
}

impl ParsedArgs {
    /// True when the flag `name` was given.
    pub fn boolean(&self, name: &str) -> bool {
        self.flags.iter().any(|(key, _)| *key == name)
    }

    /// The whole number the value flag `name` was given, when it was given.
    pub fn number(&self, name: &str) -> Result<Option<u64>, CliError> {
        let given = self.flags.iter().rev().find(|(key, _)| *key == name).and_then(|(_, value)| value.as_deref());
        given.map(|value| value.parse().map_err(|_| CliError::usage(format!("--{name} must be a whole number.")))).transpose()
    }
}

/// `argv` over the common flags, the `boolean` ones and the `value` ones; anything else is a usage error.
pub(crate) fn parse_args(argv: &[String], boolean: &[&'static str], value: &[&'static str]) -> Result<ParsedArgs, CliError> {
    let mut parsed = ParsedArgs::default();
    let mut words = argv.iter();
    while let Some(word) = words.next() {
        if word == "--" {
            parsed.positionals.extend(words.cloned());
            break;
        }
        let (name, inline) = match (word.strip_prefix("--"), SHORT.iter().find(|(short, _)| short == word)) {
            (Some(long), _) => long.split_once('=').map_or((long, None), |(name, value)| (name, Some(value))),
            (None, Some((_, long))) => (*long, None),
            // A lone dash is a word: `say -` reads stdin.
            (None, None) if word.starts_with('-') && word.len() > 1 => return Err(CliError::usage(format!("Unknown option '{word}'."))),
            (None, None) => {
                parsed.positionals.push(word.clone());
                continue;
            }
        };
        let known = |names: &[&'static str]| names.iter().copied().find(|known| *known == name);
        if let Some(name) = known(&COMMON).or_else(|| known(boolean)) {
            if inline.is_some() {
                return Err(CliError::usage(format!("--{name} takes no value.")));
            }
            parsed.flags.push((name, None));
        } else if let Some(name) = known(value) {
            match inline.map(str::to_string).or_else(|| words.next().cloned()).filter(|value| !value.is_empty()) {
                Some(value) => parsed.flags.push((name, Some(value))),
                None => return Err(CliError::usage(format!("--{name} needs a value."))),
            }
        } else {
            return Err(CliError::usage(format!("Unknown option '--{name}'.")));
        }
    }
    Ok(parsed)
}
