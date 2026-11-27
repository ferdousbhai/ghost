use super::*;

/// A scratch conversation directory.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ghost-log-{}", crate::random::uuid()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const AT: &str = "2026-10-15T00:00:00Z";

fn user_at(at: &str, text: &str) -> LogEntry {
    LogEntry::User { at: at.to_string(), text: text.to_string(), origin: None }
}

fn user(text: &str) -> LogEntry {
    user_at(AT, text)
}

fn answer(at: &str, text: &str) -> LogEntry {
    LogEntry::Assistant { at: at.to_string(), content: vec![AssistantPart::text(text)], error: None }
}

fn command(at: &str, command: &str, output: &str, exit_code: Option<i32>, excluded: bool) -> LogEntry {
    LogEntry::Command { at: at.to_string(), command: command.to_string(), output: output.to_string(), exit_code, excluded }
}

fn whole(entries: &[LogEntry]) -> TranscriptPage {
    transcript_page(entries, 0, usize::MAX)
}

fn texts(page: &TranscriptPage) -> Vec<Value> {
    page.messages.iter().map(TranscriptMessage::to_json).collect()
}

// ── The file format ─────────────────────────────────────────────────────

#[test]
fn writes_each_entry_with_these_keys_in_this_order_and_reads_it_back() {
    let at = "2026-11-25T08:21:20.123Z";
    let written = [
        (new_conversation_entry(1_795_594_880_123, None), r#"{"type":"conversation","createdAt":"2026-11-25T08:21:20.123Z"}"#),
        // A conversation that started with topic documents records what it was told of them.
        (
            new_conversation_entry(1_795_594_880_123, Some("In \"/g/topics\":\n- boat.md: Heron".into())),
            r#"{"type":"conversation","createdAt":"2026-11-25T08:21:20.123Z","topics":"In \"/g/topics\":\n- boat.md: Heron"}"#,
        ),
        // A handoff: what it did to the topic documents, then its note, what the note covers, and the documents as they then stood.
        (
            LogEntry::Assistant {
                at: at.into(),
                content: vec![
                    AssistantPart::Handoff { text: "Waiting on the pier.".into(), covers: 4, topics: Some("- boat.md: Heron".into()) },
                    AssistantPart::Handoff { text: "Nothing open.".into(), covers: 9, topics: None },
                ],
                error: None,
            },
            r#"{"type":"assistant","at":"2026-11-25T08:21:20.123Z","content":[{"type":"handoff","text":"Waiting on the pier.","covers":4,"topics":"- boat.md: Heron"},{"type":"handoff","text":"Nothing open.","covers":9}]}"#,
        ),
        (user_at(at, "hé \"you\"\n🐈"), r#"{"type":"user","at":"2026-11-25T08:21:20.123Z","text":"hé \"you\"\n🐈"}"#),
        (
            LogEntry::User { at: at.into(), text: "next".into(), origin: Some(Origin::FollowUp) },
            r#"{"type":"user","at":"2026-11-25T08:21:20.123Z","text":"next","origin":"follow_up"}"#,
        ),
        (
            LogEntry::User { at: at.into(), text: "go on".into(), origin: Some(Origin::Hook) },
            r#"{"type":"user","at":"2026-11-25T08:21:20.123Z","text":"go on","origin":"hook"}"#,
        ),
        (
            LogEntry::Assistant {
                at: at.into(),
                content: vec![
                    AssistantPart::Thinking { text: "List it first.".into() },
                    AssistantPart::text("hi"),
                    AssistantPart::ToolCall {
                        id: "c1".into(),
                        name: "bash".into(),
                        arguments: json!({ "command": "ls", "timeout": 5 }),
                        failed: false,
                        output: Some("a.txt\nb.txt\n".into()),
                    },
                    AssistantPart::ToolCall { id: "c2".into(), name: "read".into(), arguments: json!({}), failed: true, output: None },
                ],
                error: None,
            },
            r#"{"type":"assistant","at":"2026-11-25T08:21:20.123Z","content":[{"type":"thinking","text":"List it first."},{"type":"text","text":"hi"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls","timeout":5},"output":"a.txt\nb.txt\n"},{"type":"toolCall","id":"c2","name":"read","arguments":{},"failed":true}]}"#,
        ),
        (
            LogEntry::Assistant { at: at.into(), content: Vec::new(), error: Some("The model stopped.".into()) },
            r#"{"type":"assistant","at":"2026-11-25T08:21:20.123Z","content":[],"error":"The model stopped."}"#,
        ),
        (
            command(at, "pwd", "/tmp\n", Some(0), false),
            r#"{"type":"command","at":"2026-11-25T08:21:20.123Z","command":"pwd","output":"/tmp\n","exitCode":0,"excluded":false}"#,
        ),
        (
            command(at, "sleep 9", "", None, true),
            r#"{"type":"command","at":"2026-11-25T08:21:20.123Z","command":"sleep 9","output":"","exitCode":null,"excluded":true}"#,
        ),
    ];
    let root = Scratch::new();
    for (entry, line) in &written {
        assert_eq!(entry.to_json().to_string(), *line);
        // Each line reads back as the same entry.
        assert_eq!(parse_entry(line.as_bytes()).as_ref(), Some(entry), "{line}");
    }
    let entries: Vec<LogEntry> = written.iter().map(|(entry, _)| entry.clone()).collect();
    // The directory is made with the first entry.
    let dir = root.0.join("conversation");
    append_log(&dir, &entries).unwrap();
    append_log(&dir, &[]).unwrap();
    let expected: String = written.iter().map(|(_, line)| format!("{line}\n")).collect();
    assert_eq!(std::fs::read_to_string(log_path(&dir)).unwrap(), expected);
    assert_eq!(read_log(&dir).unwrap(), Some(entries));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(log_path(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(log_path(&dir), root.0.join("conversation/.conversation.jsonl"));
}

#[test]
fn drops_a_part_it_does_not_write() {
    let line = r#"{"type":"assistant","at":"now","content":[{"type":"image","url":"x"},{"type":"toolCall","id":"1","name":"read"},{"type":"text","text":"ok"}]}"#;
    let LogEntry::Assistant { content, .. } = parse_entry(line.as_bytes()).unwrap() else { panic!("an assistant entry") };
    assert_eq!(content, vec![AssistantPart::text("ok")]);
}

#[test]
fn stores_a_long_text_cut_to_the_limit_and_marks_it_truncated() {
    let root = Scratch::new();
    let exact = "x".repeat(MAX_LOG_TEXT - 1);
    let long = "x".repeat(MAX_LOG_TEXT + 5);
    // The cut is in characters: the cat is the last one kept.
    let split = format!("{}🐈tail", "x".repeat(MAX_LOG_TEXT - 1));
    append_log(
        &root.0,
        &[
            user(&exact),
            user(&long),
            user(&split),
            command(AT, "yes", &long, Some(0), false),
            answer(AT, &long),
            LogEntry::Assistant {
                at: AT.into(),
                content: vec![AssistantPart::ToolCall {
                    id: "1".into(),
                    name: "bash".into(),
                    arguments: json!({ "command": long }),
                    failed: false,
                    output: None,
                }],
                error: None,
            },
        ],
    )
    .unwrap();
    let entries = read_log(&root.0).unwrap().unwrap();
    let text = |index: usize| match &entries[index] {
        LogEntry::User { text, .. } | LogEntry::Command { output: text, .. } => text.clone(),
        LogEntry::Assistant { content, .. } => match &content[0] {
            AssistantPart::Text { text } => text.clone(),
            other => other.to_json()["arguments"]["command"].as_str().unwrap().to_string(),
        },
        other => panic!("{other:?}"),
    };
    assert_eq!(text(0), exact);
    assert_eq!(text(1), "x".repeat(MAX_LOG_TEXT));
    assert_eq!(text(2), format!("{}🐈", "x".repeat(MAX_LOG_TEXT - 1)));
    assert_eq!(text::len(&text(2)), MAX_LOG_TEXT);
    assert_eq!(text(3), "x".repeat(MAX_LOG_TEXT));
    assert_eq!(text(4), "x".repeat(MAX_LOG_TEXT));
    // A tool's arguments are the model's own and are stored whole.
    assert_eq!(text(5), long);
    let truncated: Vec<bool> = entries.iter().take(3).map(|entry| entry_messages(entry, "e", 0, 1)[0].content_truncated).collect();
    assert_eq!(truncated, [false, true, true]);
    assert_eq!(entry_messages(&entries[1], "e1", 0, 1)[0].to_json()["contentTruncated"], json!(true));
    assert_eq!(
        entry_messages(&entries[0], "e0", 0, 1)[0].to_json().to_string(),
        format!(r#"{{"role":"user","content":[{{"type":"text","text":"{exact}"}}],"entryId":"e0"}}"#)
    );
}

#[test]
fn an_assistant_error_and_a_hook_message_reach_the_transcript() {
    let failed = LogEntry::Assistant { at: AT.into(), content: vec![AssistantPart::text("partial")], error: Some("The model stopped.".into()) };
    assert_eq!(
        entry_messages(&failed, "e3", 0, 1)[0].to_json().to_string(),
        r#"{"role":"assistant","content":[{"type":"text","text":"partial"}],"entryId":"e3","errorMessage":"The model stopped."}"#
    );
    let hook = LogEntry::User { at: AT.into(), text: "keep going".into(), origin: Some(Origin::Hook) };
    assert_eq!(entry_messages(&hook, "e4", 0, 1)[0].role, Role::Hook);
    let follow_up = LogEntry::User { at: AT.into(), text: "later".into(), origin: Some(Origin::FollowUp) };
    assert_eq!(entry_messages(&follow_up, "e5", 0, 1)[0].role, Role::User);
}

// ── The preview ─────────────────────────────────────────────────────────

#[test]
fn the_preview_skips_attachment_lines_and_names_a_message_of_photos_alone() {
    let at = "2026-10-05T00:00:00.000Z";
    assert_eq!(log_state(&[user_at(at, "![image](attachments/a-0123abcd.png)\nlook at this")]).preview.as_deref(), Some("look at this"));
    assert_eq!(log_state(&[user_at(at, "![a photo](attachments/a.png)\r\n\r\n  then this  \r\n")]).preview.as_deref(), Some("then this"));
    // Only a whole line of exactly that shape is an attachment.
    for said in ["see ![image](attachments/a.png)", "![image](elsewhere/a.png)", "![image](attachments/a b.png)", "![image](attachments/)"] {
        assert_eq!(log_state(&[user_at(at, said)]).preview.as_deref(), Some(said));
    }
    let photo = log_state(&[user_at(at, "![image](attachments/a-0123abcd.png)")]);
    assert_eq!(photo.preview.as_deref(), Some("Photo"));
    // A long first line is cut to 120, without trailing white space.
    let long = format!("{} tail that is cut", "word ".repeat(24));
    assert_eq!(log_state(&[user_at(at, &long)]).preview, Some("word ".repeat(24).trim_end().to_string()));
    // A `!command` that opens the conversation previews it; an excluded one does not.
    let ran = [command(at, "secret", "", Some(0), true), command(at, "ls -la", "", Some(0), false), user_at(at, "now list the big files")];
    assert_eq!(log_state(&ran[..1]).preview, None);
    let state = log_state(&ran);
    assert_eq!((state.preview.as_deref(), state.message_count), (Some("!ls -la"), 3));
}

#[test]
fn the_preview_ignores_messages_the_owner_did_not_type() {
    let at = "2026-10-05T00:00:00.000Z";
    let state = log_state(&[LogEntry::User { at: at.into(), text: "Scheduled check now".into(), origin: Some(Origin::FollowUp) }]);
    assert_eq!((state.preview, state.message_count, state.active_at.as_deref()), (None, 1, Some(at)));
}

// ── Transcript pages ────────────────────────────────────────────────────

#[test]
fn pages_preserve_message_ids_split_command_pairs_totals_and_out_of_range_pages() {
    let ran = command("now", "pwd", "```\n/tmp", Some(1), false);
    let entries = [
        new_conversation_entry(0, None),
        user_at("now", "hello"),
        ran.clone(),
        command("now", "pwd", "```\n/tmp", Some(1), true),
        answer("now", "answer"),
    ];
    let all = whole(&entries);
    assert_eq!(all.total, 4);
    assert_eq!(all.messages.iter().map(|message| message.entry_id.as_str()).collect::<Vec<_>>(), ["e1", "e2", "e2o", "e4"]);
    assert_eq!(
        texts(&all),
        [
            json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }], "entryId": "e1" }),
            json!({ "role": "user", "content": [{ "type": "text", "text": "!pwd" }], "entryId": "e2" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "````\n```\n/tmp\n````\n\n(exit 1)" }], "entryId": "e2o" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "answer" }], "entryId": "e4" }),
        ]
    );
    for offset in 0..8 {
        for limit in 1..8 {
            let expected: Vec<TranscriptMessage> = all.messages.iter().skip(offset).take(limit).cloned().collect();
            assert_eq!(transcript_page(&entries, offset, limit), TranscriptPage { messages: expected, total: 4 });
        }
    }
    // Only the half of a command pair that is on the page is rendered.
    assert_eq!(transcript_page(std::slice::from_ref(&ran), 0, 1).messages.iter().map(|m| m.entry_id.as_str()).collect::<Vec<_>>(), ["e0"]);
    assert_eq!(transcript_page(std::slice::from_ref(&ran), 1, 1).messages.iter().map(|m| m.entry_id.as_str()).collect::<Vec<_>>(), ["e0o"]);
    assert_eq!(transcript_page(&[ran], 2, 1), TranscriptPage { messages: Vec::new(), total: 2 });
}

#[test]
fn a_commands_output_is_fenced_past_its_own_backticks_and_says_how_it_ended() {
    assert_eq!(command_text("ok\n\n", Some(0)), "```\nok\n```");
    assert_eq!(command_text("a ```` b ` c", Some(2)), "`````\na ```` b ` c\n`````\n\n(exit 2)");
    assert_eq!(command_text("", None), "```\n\n```\n\n(exit signal)");
}

// ── Reads from the file ─────────────────────────────────────────────────

#[test]
fn skips_malformed_blank_and_torn_lines_and_reads_a_last_line_once_it_is_whole() {
    let root = Scratch::new();
    let path = log_path(&root.0);
    let append = |text: &str| std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(text.as_bytes()).unwrap();
    let entry = user_at("now", &"🐈".repeat(40_000));
    std::fs::write(&path, format!("\n{}\nmalformed\nnull\n{{}}\n{{\"type\":", entry.to_json())).unwrap();
    assert_eq!(read_log(&root.0).unwrap(), Some(vec![entry.clone()]));
    // The torn line is an entry once the rest of it lands, with or without its newline.
    append(r#""user","at":"now","text":"recovered"}"#);
    let recovered = user_at("now", "recovered");
    assert_eq!(read_log(&root.0).unwrap(), Some(vec![entry.clone(), recovered.clone()]));
    append("\n");
    append_log(&root.0, &[user("last")]).unwrap();
    assert_eq!(read_log(&root.0).unwrap(), Some(vec![entry, recovered, user("last")]));
    assert_eq!(read_log(&root.0.join("missing")).unwrap(), None);
}

/// A line ends at a line feed and nowhere else: U+2028 and U+2029 are written
/// unescaped inside a text, and the entry holding one reads back whole.
#[test]
fn a_text_holding_a_unicode_line_separator_is_one_entry() {
    let root = Scratch::new();
    let entries = [user("first\u{2028}second"), answer(AT, "one\u{2029}two\r"), user("third")];
    append_log(&root.0, &entries).unwrap();
    assert!(std::fs::read_to_string(log_path(&root.0)).unwrap().contains("first\u{2028}second"));
    assert_eq!(read_log(&root.0).unwrap().as_deref(), Some(&entries[..]));
}

#[test]
fn skips_records_it_does_not_write() {
    let root = Scratch::new();
    let owner = user_at("2026-10-15T00:00:00Z", "hello");
    // A kind of record this version does not write, and a message from an origin it does not know.
    let others = [
        json!({ "type": "future", "at": "2026-10-30T00:00:00Z", "text": "later" }),
        json!({ "type": "user", "at": "2026-10-30T00:00:00Z", "text": "someone else's", "origin": "elsewhere" }),
    ];
    let body: String = std::iter::once(owner.to_json()).chain(others).map(|line| format!("{line}\n")).collect();
    std::fs::write(log_path(&root.0), body).unwrap();
    let read = read_log(&root.0).unwrap().unwrap();
    assert_eq!(read, [owner]);
    let state = log_state(&read);
    assert_eq!((state.active_at.as_deref(), state.message_count), (Some("2026-10-15T00:00:00Z"), 1));
}
