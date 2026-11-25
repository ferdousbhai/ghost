//! Images the owner attaches to a conversation. They live in the conversation
//! directory, the model's working directory, so a message names one by its
//! relative path and the model opens it from its shell.
use crate::error::{GhostError, Result};
use std::io::Write;
use std::path::Path;

pub const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const DIRNAME: &str = "attachments";

/// The image format from its leading bytes, so neither a header nor a file name is trusted.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.first() == Some(&0x89) && bytes.get(1..4) == Some(b"PNG") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

/// The extension of a name `save_attachment` could have given: `<base 36>-<8 hex>.<png|jpg|gif|webp>`.
fn extension(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    let (time, random) = stem.rsplit_once('-')?;
    let lower = |text: &str, digits: &[u8]| text.bytes().all(|b| b.is_ascii_digit() || digits.contains(&b));
    let known = ["png", "jpg", "gif", "webp"].contains(&extension);
    (known && !time.is_empty() && lower(time, b"abcdefghijklmnopqrstuvwxyz") && random.len() == 8 && lower(random, b"abcdef")).then_some(extension)
}

/// Store an image in the conversation directory; returns the path a message names it by.
pub fn save_attachment(conversation_dir: &Path, bytes: &[u8]) -> Result<String> {
    let Some(extension) = sniff(bytes) else {
        return Err(GhostError::new("unsupported_media_type", "An attachment must be a PNG, JPEG, GIF, or WebP image.", 415));
    };
    let name =
        format!("{}-{}.{extension}", crate::random::base36(crate::clock::now_ms().max(0) as u64), crate::random::hex(&crate::random::bytes::<4>()));
    std::fs::create_dir_all(conversation_dir.join(DIRNAME))?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(conversation_dir.join(DIRNAME).join(&name))?;
    file.write_all(bytes)?;
    Ok(format!("{DIRNAME}/{name}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub bytes: Vec<u8>,
    /// The media type to serve it as, `image/…`.
    pub content_type: String,
}

/// Read back an attachment by the file name `save_attachment` gave it.
pub fn read_attachment(conversation_dir: &Path, name: &str) -> Result<Attachment> {
    let missing = || GhostError::new("not_found", "No such attachment.", 404);
    let extension = extension(name).ok_or_else(missing)?;
    match std::fs::read(conversation_dir.join(DIRNAME).join(name)) {
        Ok(bytes) => Ok(Attachment { bytes, content_type: format!("image/{}", if extension == "jpg" { "jpeg" } else { extension }) }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(missing()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_an_image_under_a_name_it_serves_back_with_its_type() {
        let dir = std::env::temp_dir().join(format!("ghost-attachments-{}", crate::random::uuid()));
        let images: [(&[u8], &str, &str); 4] = [
            (b"\x89PNG\r\n\x1a\nrest", "png", "image/png"),
            (b"\xff\xd8\xff\xe0rest", "jpg", "image/jpeg"),
            (b"GIF89a rest", "gif", "image/gif"),
            (b"RIFF\x10\x00\x00\x00WEBPVP8 ", "webp", "image/webp"),
        ];
        for (bytes, extension, content_type) in images {
            let path = save_attachment(&dir, bytes).unwrap();
            let name = path.strip_prefix("attachments/").expect("a path under attachments/");
            assert_eq!(self::extension(name), Some(extension), "{name}");
            assert_eq!(std::fs::read(dir.join(&path)).unwrap(), bytes);
            assert_eq!(read_attachment(&dir, name).unwrap(), Attachment { bytes: bytes.to_vec(), content_type: content_type.to_string() });
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_what_is_not_an_image_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("ghost-attachments-{}", crate::random::uuid()));
        let not_images: [&[u8]; 6] = [b"", b"\x89PN", b"hello", b"RIFF\x10\x00\x00\x00WAVE", b"RIFF", b"<svg/>"];
        for bytes in not_images {
            let refusal = save_attachment(&dir, bytes).unwrap_err();
            assert_eq!(
                (refusal.code.as_str(), refusal.status, refusal.message.as_str()),
                ("unsupported_media_type", 415, "An attachment must be a PNG, JPEG, GIF, or WebP image.")
            );
        }
        assert!(!dir.exists());
    }

    #[test]
    fn serves_only_names_it_could_have_given() {
        let dir = std::env::temp_dir().join(format!("ghost-attachments-{}", crate::random::uuid()));
        std::fs::create_dir_all(dir.join("attachments")).unwrap();
        std::fs::write(dir.join("secret.png"), b"x").unwrap();
        std::fs::write(dir.join("attachments/notes.txt"), b"x").unwrap();
        for name in [
            "../secret.png",
            "notes.txt",
            "k1-0123abcd.svg",
            "K1-0123abcd.png",
            "k1-0123ABCD.png",
            "k1-0123abc.png",
            "-0123abcd.png",
            "k1-0123abcd.png",
        ] {
            let refusal = read_attachment(&dir, name).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.status, refusal.message.as_str()), ("not_found", 404, "No such attachment."), "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
