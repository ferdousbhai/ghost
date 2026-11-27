//! Random bytes from the kernel, and the two shapes Ghost writes them in.
use std::fs::File;
use std::io::Read;

pub(crate) fn bytes<const N: usize>() -> [u8; N] {
    let mut buffer = [0u8; N];
    File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut buffer)).expect("/dev/urandom");
    buffer
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A random (version 4) UUID.
pub fn uuid() -> String {
    let mut b = bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// A number in base 36, lower case.
pub(crate) fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii")
}
