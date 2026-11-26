//! Time as the API and the log write it: UTC ISO 8601 with milliseconds, as
//! JavaScript's `toISOString` does, so logs written by earlier versions and
//! by this one sort together as text.
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn now_iso() -> String {
    iso(now_ms())
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-11-25T08:21:20.123Z`.
pub fn iso(ms: i64) -> String {
    let (year, month, day) = civil(ms.div_euclid(86_400_000));
    let rest = ms.rem_euclid(86_400_000);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1_000 % 60, rest % 1_000)
}

/// Milliseconds of an ISO 8601 time: a date alone (UTC midnight), or a date
/// and time with optional fraction and `Z` or `±hh:mm` (UTC without either,
/// as every time Ghost wrote carries `Z`).
pub fn parse_iso(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let number = |from: usize, to: usize| -> Option<i64> {
        let part = text.get(from..to)?;
        (part.len() == to - from && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse().ok())?
    };
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let (year, month, day) = (number(0, 4)?, number(5, 7)? as u32, number(8, 10)? as u32);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * 86_400_000;
    if bytes.len() == 10 {
        return Some(ms);
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes.len() < 16 || bytes[13] != b':' {
        return None;
    }
    let (hour, minute) = (number(11, 13)?, number(14, 16)?);
    if hour > 24 || minute > 59 {
        return None;
    }
    ms += hour * 3_600_000 + minute * 60_000;
    let mut at = 16;
    if bytes.get(at) == Some(&b':') {
        let second = number(at + 1, at + 3)?;
        if second > 60 {
            return None;
        }
        ms += second * 1_000;
        at += 3;
        if bytes.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return None;
            }
            let digits = &text[start..end.min(start + 3)];
            ms += digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32);
            at = end;
        }
    }
    match &text[at..] {
        "" | "Z" | "z" => Some(ms),
        zone => {
            let zone = zone.as_bytes();
            let sign = match zone.first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = zone[1..].iter().filter(|b| **b != b':').map(|b| *b as char).collect();
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let offset = digits[..2].parse::<i64>().ok()? * 60 + digits[2..].parse::<i64>().ok()?;
            Some(ms - sign * offset * 60_000)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_795_594_880_123), "2026-11-25T08:21:20.123Z");
        for ms in [0, 1_795_594_880_123, 951_782_400_000, -86_400_001] {
            assert_eq!(parse_iso(&iso(ms)), Some(ms));
        }
    }

    #[test]
    fn parses_what_clients_send() {
        assert_eq!(parse_iso("2026-11-25"), Some(1_795_564_800_000));
        assert_eq!(parse_iso("2026-11-25T08:21:20Z"), Some(1_795_594_880_000));
        assert_eq!(parse_iso("2026-11-25T16:21:20.5+08:00"), Some(1_795_594_880_500));
        assert_eq!(parse_iso("2026-11-25T08:21"), Some(1_795_594_860_000));
        for bad in ["", "soon", "2026-13-01", "2026-11-25T", "2026-11-25T08:21:20.Z", "2026-11-25T08:21:20+8"] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }
}
