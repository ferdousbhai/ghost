//! A turn's stream frames, kept so a client that reconnects can be replayed
//! any of them by position.
use crate::env::Env;
use crate::xdg::{Base, base_dir};
use std::fs::File;
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

/// The frames a turn may hold in memory before they move to files.
pub const DEFAULT_MEMORY_LIMIT: usize = 1_048_576;

/// Where replay files are made: `ghost` under the owner's cache directory.
pub fn spill_dir(env: &Env) -> PathBuf {
    base_dir(env, Base::Cache, &crate::env::home(env)).join("ghost")
}

fn temporary_file(root: &Path) -> io::Result<File> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(root)?;
    // An exclusive create under a random name; unlinked at once, so only the descriptor holds it.
    let path = root.join(format!("ghost-turn-{}", crate::random::uuid()));
    let file = std::fs::OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path)?;
    std::fs::remove_file(&path)?;
    Ok(file)
}

/// The data file and, beside it, each frame's start as eight little-endian bytes.
struct Spill {
    data: File,
    index: File,
}

/// Small turns stay in memory; large replay histories use anonymous, seekable files.
pub struct TurnBuffer {
    frames: Vec<String>,
    spill: Option<Spill>,
    bytes: u64,
    count: usize,
    closed: bool,
    memory_limit: usize,
    spill_dir: PathBuf,
}

impl TurnBuffer {
    /// `spill_dir` is made (0700) only when a turn outgrows `memory_limit` bytes.
    pub fn new(memory_limit: usize, spill_dir: PathBuf) -> Self {
        Self { frames: Vec::new(), spill: None, bytes: 0, count: 0, closed: false, memory_limit, spill_dir }
    }

    /// How many frames were pushed.
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    fn append(&mut self, frame: &str) -> io::Result<()> {
        let spill = self.spill.as_ref().ok_or_else(|| io::Error::other("Replay files are not open."))?;
        spill.data.write_all_at(frame.as_bytes(), self.bytes)?;
        spill.index.write_all_at(&self.bytes.to_le_bytes(), self.count as u64 * 8)?;
        self.bytes += frame.len() as u64;
        self.count += 1;
        Ok(())
    }

    fn open_spill(&mut self) -> io::Result<()> {
        self.spill = Some(Spill { data: temporary_file(&self.spill_dir)?, index: temporary_file(&self.spill_dir)? });
        self.bytes = 0;
        self.count = 0;
        for saved in std::mem::take(&mut self.frames) {
            self.append(&saved)?;
        }
        Ok(())
    }

    /// Add a frame at the end. A failure to move to files closes the buffer.
    pub fn push(&mut self, frame: &str) -> io::Result<()> {
        if self.closed {
            return Err(io::Error::other("Replay buffer is closed."));
        }
        if self.spill.is_none() && self.bytes + frame.len() as u64 <= self.memory_limit as u64 {
            self.frames.push(frame.to_string());
            self.bytes += frame.len() as u64;
            self.count += 1;
            return Ok(());
        }
        if self.spill.is_none()
            && let Err(error) = self.open_spill()
        {
            self.dispose();
            return Err(error);
        }
        self.append(frame)
    }

    /// The frame pushed `position`th, from zero.
    pub fn at(&self, position: usize) -> io::Result<String> {
        if self.closed || position >= self.count {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid replay position."));
        }
        let Some(spill) = &self.spill else { return Ok(self.frames[position].clone()) };
        let incomplete = |error: io::Error| match error.kind() {
            io::ErrorKind::UnexpectedEof => io::Error::other("Incomplete replay file."),
            _ => error,
        };
        let offset = |slot: usize| -> io::Result<u64> {
            let mut bytes = [0u8; 8];
            spill.index.read_exact_at(&mut bytes, slot as u64 * 8).map_err(incomplete)?;
            Ok(u64::from_le_bytes(bytes))
        };
        let start = offset(position)?;
        let end = if position + 1 < self.count { offset(position + 1)? } else { self.bytes };
        let mut frame = vec![0u8; (end - start) as usize];
        spill.data.read_exact_at(&mut frame, start).map_err(incomplete)?;
        Ok(String::from_utf8_lossy(&frame).into_owned())
    }

    /// Close the buffer and release its files; pushing or reading afterwards fails.
    pub fn dispose(&mut self) {
        self.closed = true;
        self.frames = Vec::new();
        self.spill = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("ghost-turn-buffer-{}", crate::random::uuid()))
    }

    #[test]
    fn spills_to_unlinked_files_and_releases_their_descriptors_on_disposal() {
        let dir = scratch();
        // Other tests spill too: only this one's directory is looked at.
        let replay_files = || -> Vec<String> {
            std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .filter_map(|fd| std::fs::read_link(fd.ok()?.path()).ok())
                .map(|path| path.to_string_lossy().into_owned())
                .filter(|path| path.starts_with(&*dir.to_string_lossy()) && path.contains("/ghost-turn-"))
                .collect()
        };
        assert_eq!(replay_files(), Vec::<String>::new());
        let mut buffer = TurnBuffer::new(10, dir.clone());
        for _ in 0..100 {
            buffer.push(&"x".repeat(8192)).unwrap();
        }
        let added = replay_files();
        assert_eq!(added.len(), 2);
        assert!(added.iter().all(|path| path.ends_with(" (deleted)")), "{added:?}");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(buffer.at(99).unwrap(), "x".repeat(8192));
        buffer.dispose();
        assert_eq!(replay_files(), Vec::<String>::new());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replays_arbitrary_event_positions_across_memory_limits() {
        for limit in [0, 20, DEFAULT_MEMORY_LIMIT] {
            let dir = scratch();
            let mut buffer = TurnBuffer::new(limit, dir.clone());
            let frames = ["data: hello\n\n".to_string(), "data: 🐈 café\n\n".to_string(), "x".repeat(100), "data: done\n\n".to_string()];
            assert!(buffer.is_empty());
            for frame in &frames {
                buffer.push(frame).unwrap();
            }
            assert_eq!(buffer.len(), frames.len());
            for index in [3, 0, 2, 1, 3] {
                assert_eq!(buffer.at(index).unwrap(), frames[index], "limit {limit}");
            }
            buffer.push("late").unwrap();
            assert_eq!(buffer.at(4).unwrap(), "late");
            let refusal = buffer.at(5).unwrap_err();
            assert_eq!((refusal.kind(), refusal.to_string().as_str()), (io::ErrorKind::InvalidInput, "Invalid replay position."));
            // Only a turn past the limit touches the disk.
            assert_eq!(dir.exists(), limit < DEFAULT_MEMORY_LIMIT);
            buffer.dispose();
            buffer.dispose();
            assert_eq!(buffer.push("closed").unwrap_err().to_string(), "Replay buffer is closed.");
            assert!(buffer.at(0).is_err());
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn the_spill_directory_is_the_owners_cache() {
        let env = Env::from([("HOME".to_string(), "/home/o".to_string())]);
        assert_eq!(spill_dir(&env), Path::new("/home/o/.cache/ghost"));
        let env = Env::from([("HOME".to_string(), "/home/o".to_string()), ("XDG_CACHE_HOME".to_string(), "/c".to_string())]);
        assert_eq!(spill_dir(&env), Path::new("/c/ghost"));
    }

    #[test]
    fn is_shareable_across_threads() {
        fn shareable<T: Send + Sync>() {}
        shareable::<TurnBuffer>();
    }
}
