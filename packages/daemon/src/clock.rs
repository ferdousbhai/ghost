//! Time as the API and the log write it: UTC ISO 8601 with milliseconds, which
//! sorts as text.
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

/// Milliseconds of a time as `iso` writes one, `YYYY-MM-DDTHH:MM:SS[.fff]Z`:
/// the only form the daemon sends, stores or is sent back.
pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let marks: &[(usize, u8)] = match bytes.len() {
        20 => &[(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':'), (19, b'Z')],
        24 => &[(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':'), (19, b'.'), (23, b'Z')],
        _ => return None,
    };
    if !marks.iter().all(|(at, mark)| bytes[*at] == *mark) {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let part = text.get(from..to)?;
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let millis = if bytes.len() == 24 { number(20, 23)? } else { 0 };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month as u32, day as u32) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
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
    fn parses_only_the_form_it_writes() {
        assert_eq!(parse_iso("2026-11-25T08:21:20Z"), Some(1_795_594_880_000));
        assert_eq!(parse_iso("2026-11-25T08:21:20.123Z"), Some(1_795_594_880_123));
        let others = [
            "2026-11-25",
            "2026-11-25T08:21",
            "2026-11-25T16:21:20.5+08:00",
            "2026-11-25t08:21:20z",
            "2026-11-25 08:21:20Z",
            " 2026-11-25T08:21:20Z",
        ];
        let invalid =
            ["", "soon", "2026-13-01T08:21:20Z", "2026-11-25T24:00:00Z", "2026-11-25T08:21:60Z", "2026-11-25T08:21:20.Z", "2026-11-25T08:21:2éZ"];
        for bad in others.iter().chain(&invalid) {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }
}
