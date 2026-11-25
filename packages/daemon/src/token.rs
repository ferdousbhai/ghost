//! The HTTP API's bearer token: 32 random bytes as hex in a mode-0600 file
//! under XDG state, minted by the daemon when missing and read by the CLI and
//! window. The daemon holds the token it started with, so replacing it is
//! delete-and-restart.
use crate::env::{Env, var};
use crate::xdg::{Base, base_dir};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Constant-time comparison. A failed presentation is answered immediately, so
/// a naive `==` would leak the token a byte at a time to anything that can
/// time a loopback socket.
pub fn token_matches(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// `$GHOSTD_API_TOKEN_FILE`, else `$XDG_STATE_HOME/ghost/api-token`, else under `~/.local/state`.
pub fn api_token_path(env: &Env, home: &Path) -> PathBuf {
    match var(env, "GHOSTD_API_TOKEN_FILE") {
        Some(explicit) => PathBuf::from(explicit),
        None => base_dir(env, Base::State, home).join("ghost").join("api-token"),
    }
}

/// The token, or None when the file does not exist; anything else wrong with it is an error.
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
    let read = file.read_to_string(&mut text).is_ok();
    let token = text.strip_suffix('\n').filter(|token| token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    match token {
        Some(token) if read => Ok(Some(token.to_string())),
        _ => Err(format!("Token file {} is malformed; delete it and restart ghostd.", path.display())),
    }
}

/// The token, minted when missing. A complete file is published with `link`,
/// which fails when another process published first; that one's token wins.
pub fn ensure_api_token(path: &Path) -> Result<(String, bool), String> {
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

    #[test]
    fn mints_once_and_reads_back() {
        let dir = scratch();
        let path = dir.join("state/ghost/api-token");
        assert_eq!(read_api_token(&path), Ok(None));
        let (token, created) = ensure_api_token(&path).unwrap();
        assert!(created && token.len() == 64);
        assert_eq!(ensure_api_token(&path).unwrap(), (token.clone(), false));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(token_matches(&token, &token) && !token_matches(&token, "x") && !token_matches("", ""));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_readable_or_malformed_file() {
        let dir = scratch();
        let path = dir.join("api-token");
        std::fs::write(&path, format!("{}\n", "a".repeat(64))).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_api_token(&path).unwrap_err().contains("mode 0600"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_api_token(&path).unwrap().unwrap().len(), 64);
        std::fs::write(&path, "nope\n").unwrap();
        assert!(read_api_token(&path).unwrap_err().contains("malformed"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn command_prints_the_token_and_refuses_unknown_options() {
        let dir = scratch();
        let path = dir.join("api-token");
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(api_token_command(&["-q".into()], &path, &mut out, &mut err), 0);
        assert_eq!(out.len(), 65);
        assert_eq!(api_token_command(&["--loud".into()], &path, &mut out, &mut err), 2);
        assert!(String::from_utf8(err).unwrap().contains("unknown option --loud"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
