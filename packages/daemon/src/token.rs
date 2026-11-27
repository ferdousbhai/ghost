//! The HTTP API's bearer token: 32 random bytes as hex in a mode-0600 file
//! under XDG state, minted by the daemon when missing and read by the CLI and
//! the bar. The daemon holds the token it started with, so replacing it is
//! delete-and-restart.
use crate::env::{Env, var};
use crate::xdg::{Base, base_dir};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Constant-time comparison. A failed presentation is answered immediately, so
/// a naive `==` would leak the token a byte at a time to anything that can
/// time a loopback socket.
pub(crate) fn token_matches(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The file's whole size: 64 hex digits and a newline.
const TOKEN_FILE_BYTES: u64 = 65;

/// `$GHOSTD_API_TOKEN_FILE`, else `$XDG_STATE_HOME/ghost/api-token`, else under `~/.local/state`.
pub fn api_token_path(env: &Env, home: &Path) -> PathBuf {
    match var(env, "GHOSTD_API_TOKEN_FILE") {
        Some(explicit) => PathBuf::from(explicit),
        None => base_dir(env, Base::State, home).join("ghost").join("api-token"),
    }
}

/// The token, or None when the file does not exist; anything else wrong with
/// it is an error. A symlink is refused, not followed, and no more is read
/// than a token and one byte, so a file of any size is only ever malformed.
pub fn read_api_token(path: &Path) -> Result<Option<String>, String> {
    let opened = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path);
    let mut file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot open token file {}: {error}", path.display())),
    };
    let info = file.metadata().map_err(|error| error.to_string())?;
    if !info.is_file() {
        return Err(format!("Token file {} is not a regular file.", path.display()));
    }
    if info.permissions().mode() & 0o077 != 0 {
        return Err(format!("Token file {} must be readable only by its owner (mode 0600).", path.display()));
    }
    let mut text = String::new();
    let read = (&mut file).take(TOKEN_FILE_BYTES + 1).read_to_string(&mut text).is_ok();
    let token = text.strip_suffix('\n').filter(|token| token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    match token {
        Some(token) if read => Ok(Some(token.to_string())),
        _ => Err(format!("Token file {} is malformed; delete it and restart ghostd.", path.display())),
    }
}

/// The token, minted when missing. A complete file is published with `link`,
/// which fails when another process published first; that one's token wins.
pub(crate) fn ensure_api_token(path: &Path) -> Result<(String, bool), String> {
    if let Some(existing) = read_api_token(path)? {
        return Ok((existing, false));
    }
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(|error| error.to_string())?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.{}.tmp", std::process::id(), crate::random::hex(&crate::random::bytes::<4>())));
    let token = crate::random::hex(&crate::random::bytes::<32>());
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| file.write_all(format!("{token}\n").as_bytes()))
        .map_err(|error| error.to_string())?;
    let linked = std::fs::hard_link(&temporary, path);
    let _ = std::fs::remove_file(&temporary);
    match linked {
        Ok(()) => Ok((token, true)),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            read_api_token(path)?.map(|token| (token, false)).ok_or_else(|| format!("Token file {} vanished.", path.display()))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// `ghostd api-token [--quiet]`: print the token, minting it on first run.
pub fn api_token_command(args: &[String], path: &Path, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if let Some(unknown) = args.iter().find(|arg| *arg != "--quiet" && *arg != "-q") {
        let _ = writeln!(err, "api-token: unknown option {unknown}");
        return 2;
    }
    match ensure_api_token(path) {
        Ok((token, _)) => {
            let _ = if args.is_empty() {
                write!(
                    out,
                    "{token}\n\nLocal API clients read this file directly; this printout is for debugging and scripts.\nStored at {} (mode 0600). To replace it, delete the file and restart ghostd.\n",
                    path.display()
                )
            } else {
                writeln!(out, "{token}")
            };
            0
        }
        Err(message) => {
            let _ = writeln!(err, "api-token: {message}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ghost-token-{}", crate::random::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn lives_under_xdg_state_unless_named_explicitly() {
        let home = Path::new("/home/x");
        assert_eq!(api_token_path(&env(&[("XDG_STATE_HOME", "/xdg/state")]), home), Path::new("/xdg/state/ghost/api-token"));
        assert_eq!(api_token_path(&env(&[("XDG_STATE_HOME", "relative")]), home), Path::new("/home/x/.local/state/ghost/api-token"));
        assert_eq!(api_token_path(&env(&[("GHOSTD_API_TOKEN_FILE", "/tmp/t")]), home), Path::new("/tmp/t"));
        assert_eq!(api_token_path(&env(&[("GHOSTD_API_TOKEN_FILE", " ")]), home), Path::new("/home/x/.local/state/ghost/api-token"));
    }

    #[test]
    fn is_minted_once_owner_only_and_read_back_the_same_ever_after() {
        let dir = scratch();
        let path = dir.join("state").join("api-token");
        assert_eq!(read_api_token(&path), Ok(None));
        let (token, created) = ensure_api_token(&path).unwrap();
        assert!(created && token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')), "{token}");
        assert_eq!(ensure_api_token(&path), Ok((token.clone(), false)));
        assert_eq!(read_api_token(&path), Ok(Some(token.clone())));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{token}\n"));
        assert!(token_matches(&token, &token) && !token_matches(&token, "x") && !token_matches("", ""));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // Its directory is the owner's alone, and no temporary file is left in it.
        assert_eq!(std::fs::metadata(dir.join("state")).unwrap().permissions().mode() & 0o777, 0o700);
        let left: Vec<_> = std::fs::read_dir(dir.join("state")).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(left, ["api-token"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_link_a_readable_by_others_file_and_a_malformed_one_instead_of_replacing_it() {
        let dir = scratch();
        let path = dir.join("state").join("api-token");
        std::fs::create_dir(dir.join("state")).unwrap();
        let write = |target: &Path, text: &str, mode: u32| {
            std::fs::write(target, text).unwrap();
            std::fs::set_permissions(target, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        let valid = format!("{}\n", "a".repeat(64));
        write(&dir.join("real"), &valid, 0o600);
        std::os::unix::fs::symlink(dir.join("real"), &path).unwrap();
        assert!(ensure_api_token(&path).unwrap_err().starts_with("Cannot open token file "));
        assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        std::fs::remove_file(&path).unwrap();
        // Not a file at all.
        std::fs::create_dir(&path).unwrap();
        assert!(ensure_api_token(&path).unwrap_err().contains("is not a regular file"));
        std::fs::remove_dir(&path).unwrap();
        for mode in [0o644, 0o640, 0o604] {
            write(&path, &valid, mode);
            assert!(ensure_api_token(&path).unwrap_err().contains("mode 0600"), "{mode:o}");
        }
        // Wrong in its digits, its length or its end; the last is far past what is read of it.
        for malformed in [
            format!("{}\n", "A".repeat(64)),
            "a".repeat(64),
            format!("{}\n", "a".repeat(63)),
            format!("{}\n\n", "a".repeat(64)),
            String::new(),
            format!("{}\n{}", "a".repeat(64), "b".repeat(4 * 1024 * 1024)),
        ] {
            write(&path, &malformed, 0o600);
            assert!(ensure_api_token(&path).unwrap_err().contains("malformed"), "{} bytes", malformed.len());
            assert!(std::fs::read(&path).unwrap() == malformed.as_bytes());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn gives_everyone_who_mints_at_once_the_one_winning_token() {
        let dir = scratch();
        let path = dir.join("state").join("api-token");
        let start = std::sync::Barrier::new(12);
        let results: Vec<(String, bool)> = std::thread::scope(|scope| {
            let minting: Vec<_> = (0..12)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        ensure_api_token(&path).unwrap()
                    })
                })
                .collect();
            minting.into_iter().map(|thread| thread.join().unwrap()).collect()
        });
        let winner = read_api_token(&path).unwrap().unwrap();
        assert!(results.iter().all(|(token, _)| *token == winner));
        assert_eq!(results.iter().filter(|(_, created)| *created).count(), 1);
        assert_eq!(std::fs::read_dir(dir.join("state")).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_command_mints_prints_and_says_where_it_lives_and_how_to_replace_it() {
        let dir = scratch();
        let path = dir.join("state").join("api-token");
        let run = |args: &[&str]| {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
            let code = api_token_command(&args, &path, &mut out, &mut err);
            (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
        };
        let (code, out, err) = run(&[]);
        let token = read_api_token(&path).unwrap().unwrap();
        assert_eq!((code, err.as_str(), out.lines().next()), (0, "", Some(token.as_str())));
        assert!(out.contains(&path.display().to_string()) && out.contains("delete the file and restart ghostd"));
        // Only the token under --quiet, so it can be piped into curl.
        assert_eq!(run(&["--quiet"]), (0, format!("{token}\n"), String::new()));
        // An option it does not know is refused, --rotate included.
        assert_eq!(run(&["--rotate"]), (2, String::new(), "api-token: unknown option --rotate\n".to_string()));
        std::fs::write(&path, "nope\n").unwrap();
        let (code, out, err) = run(&["-q"]);
        assert_eq!((code, out.as_str()), (1, ""));
        assert!(err.starts_with("api-token: Token file ") && err.contains("malformed"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
