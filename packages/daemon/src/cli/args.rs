//! The `ghost` command line's argument parser. Its rules and every error
//! sentence (strict, positionals allowed) are kept as they have always been:
//! scripts and a ghost's own prompt have seen these messages.
use super::CliError;
use std::collections::VecDeque;

/// The flags one parse accepts on top of `--help`, `--json` and `--quiet`.
#[derive(Debug, Default, Clone)]
pub struct ArgsSpec {
    pub boolean: Vec<&'static str>,
    pub value: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Flag {
    On,
    Text(String),
}

/// What a command line held: the bare words in order, and each flag once
/// (the last value given wins), in the order first seen.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedArgs {
    pub positionals: Vec<String>,
    pub flags: Vec<(String, Flag)>,
}

impl ParsedArgs {
    /// True when the boolean flag `name` was given.
    pub fn boolean(&self, name: &str) -> bool {
        self.flags.iter().any(|(key, value)| key == name && *value == Flag::On)
    }

    /// The value flag `name`, when given.
    pub fn text(&self, name: &str) -> Option<&str> {
        self.flags.iter().find_map(|(key, value)| match value {
            Flag::Text(text) if key == name => Some(text.as_str()),
            _ => None,
        })
    }

    fn set(&mut self, name: &str, value: Flag) {
        match self.flags.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value,
            None => self.flags.push((name.to_string(), value)),
        }
    }
}

struct Option_ {
    name: &'static str,
    takes_value: bool,
    short: Option<char>,
}

fn short_of(name: &str) -> Option<char> {
    match name {
        "help" => Some('h'),
        "quiet" => Some('q'),
        "session" => Some('s'),
        "version" => Some('v'),
        _ => None,
    }
}

/// One option as it appeared: `raw` is how the error messages quote it.
struct Token {
    name: String,
    raw: String,
    value: Option<String>,
    /// The value came in the same word (`--limit=5`, `-sabc`), so it cannot be a forgotten argument.
    inline: bool,
}

struct Parser {
    options: Vec<Option_>,
    parsed: ParsedArgs,
}

impl Parser {
    fn option(&self, name: &str) -> Option<&Option_> {
        // A name listed twice keeps its last definition.
        self.options.iter().rev().find(|option| option.name == name)
    }

    /// The long name a short letter stands for; the letter itself when none does.
    fn long_for(&self, short: char) -> String {
        self.options.iter().find(|option| option.short == Some(short)).map_or_else(|| short.to_string(), |option| option.name.to_string())
    }

    fn takes_value(&self, name: &str) -> bool {
        self.option(name).is_some_and(|option| option.takes_value)
    }

    fn accept(&mut self, token: Token) -> Result<(), CliError> {
        if let Some(value) = &token.value
            && !token.inline
            && value.chars().count() > 1
            && value.starts_with('-')
        {
            let raw = &token.raw;
            let example = if raw.starts_with("--") { format!("'{raw}=-XYZ'") } else { format!("'--{}=-XYZ' or '{raw}-XYZ'", token.name) };
            return Err(CliError::usage(format!(
                "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}."
            )));
        }
        let Some(option) = self.option(&token.name) else {
            let quoted = serde_json::Value::String(token.raw.clone()).to_string();
            return Err(CliError::usage(format!(
                "Unknown option '{}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {quoted}",
                token.raw
            )));
        };
        let shown = match option.short {
            Some(short) => format!("-{short}, --{}", option.name),
            None => format!("--{}", option.name),
        };
        let name = option.name;
        match (option.takes_value, token.value) {
            (true, None) => Err(CliError::usage(format!("Option '{shown} <value>' argument missing"))),
            (false, Some(_)) => Err(CliError::usage(format!("Option '{shown}' does not take an argument"))),
            (true, Some(value)) => {
                self.parsed.set(name, Flag::Text(value));
                Ok(())
            }
            (false, None) => {
                self.parsed.set(name, Flag::On);
                Ok(())
            }
        }
    }
}

/// `--help`, `--json`, and `--quiet` plus the spec's flags; anything else is a usage error.
pub fn parse_args(argv: &[String], spec: &ArgsSpec) -> Result<ParsedArgs, CliError> {
    let define = |takes_value: bool| move |name: &&'static str| Option_ { name, takes_value, short: short_of(name) };
    let options = ["help", "json", "quiet"].iter().chain(spec.boolean.iter()).map(define(false)).chain(spec.value.iter().map(define(true))).collect();
    let mut parser = Parser { options, parsed: ParsedArgs::default() };
    let mut rest: VecDeque<&String> = argv.iter().collect();
    while let Some(arg) = rest.pop_front() {
        if arg == "--" {
            parser.parsed.positionals.extend(rest.drain(..).cloned());
            break;
        }
        let letters: Vec<char> = arg.chars().collect();
        if letters.len() >= 2 && letters[0] == '-' && letters[1] != '-' {
            let first = parser.long_for(letters[1]);
            if letters.len() == 2 {
                // `-s abc`, `-q`.
                let value = if parser.takes_value(&first) { rest.pop_front().cloned() } else { None };
                parser.accept(Token { name: first, raw: arg.clone(), value, inline: false })?;
            } else if parser.takes_value(&first) {
                // `-sabc`.
                let value = letters[2..].iter().collect();
                parser.accept(Token { name: first, raw: format!("-{}", letters[1]), value: Some(value), inline: true })?;
            } else {
                // `-qh`, `-qsabc`: letters until one takes the rest (or the next word) as its value.
                for (index, letter) in letters.iter().enumerate().skip(1) {
                    let name = parser.long_for(*letter);
                    let takes_value = parser.takes_value(&name);
                    let (value, inline) = match (takes_value, index + 1 < letters.len()) {
                        (false, _) => (None, false),
                        (true, true) => (Some(letters[index + 1..].iter().collect()), true),
                        (true, false) => (rest.pop_front().cloned(), false),
                    };
                    // A letter inside a group is quoted bare.
                    parser.accept(Token { name, raw: letter.to_string(), value, inline })?;
                    if takes_value {
                        break;
                    }
                }
            }
        } else if letters.len() > 2 && arg.starts_with("--") {
            match letters.iter().skip(3).position(|letter| *letter == '=') {
                Some(offset) => {
                    let name: String = letters[2..offset + 3].iter().collect();
                    let value = letters[offset + 4..].iter().collect();
                    parser.accept(Token { raw: format!("--{name}"), name, value: Some(value), inline: true })?;
                }
                None => {
                    let name: String = letters[2..].iter().collect();
                    let value = if parser.takes_value(&name) { rest.pop_front().cloned() } else { None };
                    parser.accept(Token { name, raw: arg.clone(), value, inline: false })?;
                }
            }
        } else {
            parser.parsed.positionals.push(arg.clone());
        }
    }
    if let Some((name, _)) = parser.parsed.flags.iter().find(|(_, value)| *value == Flag::Text(String::new())) {
        return Err(CliError::usage(format!("--{name} requires a value.")));
    }
    Ok(parser.parsed)
}
