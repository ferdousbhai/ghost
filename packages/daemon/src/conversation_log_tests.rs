use super::*;
use std::sync::Mutex;

/// The indexes are one per process and small: tests that count what an index
/// re-read, or that fill it, take turns.
static INDEX_TESTS: Mutex<()> = Mutex::new(());

fn index_tests() -> std::sync::MutexGuard<'static, ()> {
    INDEX_TESTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Scratch(PathBuf);

impl Scratch {
    /// A scratch `sessions/` directory holding an empty conversation `s`.
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ghost-log-{}", crate::random::uuid()));
        std::fs::create_dir_all(root.join("s")).unwrap();
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

fn title(at: &str, title: Option<&str>) -> LogEntry {
    LogEntry::Title { at: at.to_string(), title: title.map(str::to_string) }
}

fn lines(entries: &[LogEntry]) -> String {
    entries.iter().map(|entry| format!("{}\n", entry.to_json())).collect()
}

fn parsed() -> usize {
    PARSED.with(|parsed| parsed.get())
}

/// The transcript page `read_transcript_page` should serve, computed straight
/// from the entries with no file or index: the oracle its indexed reads are
/// checked against. Conversation and title records are not messages.
fn transcript_page(entries: &[LogEntry], offset: usize, limit: usize) -> TranscriptPage {
    let end = offset.saturating_add(limit);
    let mut page = TranscriptPage::default();
    for (index, entry) in entries.iter().enumerate() {
        let count = message_count(entry);
        let first = page.total;
        page.total += count;
        if count == 0 || first >= end || page.total <= offset {
            continue;
        }
        page.messages.extend(entry_messages(entry, &format!("e{index}"), offset.saturating_sub(first), end - offset.max(first)));
    }
    page
}

fn whole(entries: &[LogEntry]) -> TranscriptPage {
    transcript_page(entries, 0, usize::MAX)
}

fn texts(page: &TranscriptPage) -> Vec<Value> {
    page.messages.iter().map(TranscriptMessage::to_json).collect()
}

// ── The file format ─────────────────────────────────────────────────────

#[test]
fn writes_each_entry_with_the_keys_and_key_order_every_version_has_written() {
    let at = "2026-11-25T08:21:20.123Z";
    let written = [
        (new_conversation_entry("s", 1_795_594_880_123), r#"{"type":"conversation","v":1,"id":"s","createdAt":"2026-11-25T08:21:20.123Z"}"#),
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
        (title(at, Some("Coffee")), r#"{"type":"title","at":"2026-11-25T08:21:20.123Z","title":"Coffee"}"#),
        (title(at, None), r#"{"type":"title","at":"2026-11-25T08:21:20.123Z","title":null}"#),
    ];
    let root = Scratch::new();
    for (entry, line) in &written {
        assert_eq!(entry.to_json().to_string(), *line);
        // A line an earlier version wrote reads back as the same entry.
        assert_eq!(parse_entry(line.as_bytes()).as_ref(), Some(entry), "{line}");
    }
    let entries: Vec<LogEntry> = written.iter().map(|(entry, _)| entry.clone()).collect();
    append_log(&root.0, "new", &entries).unwrap();
    append_log(&root.0, "new", &[]).unwrap();
    let expected: String = written.iter().map(|(_, line)| format!("{line}\n")).collect();
    assert_eq!(std::fs::read_to_string(log_path(&root.0, "new")).unwrap(), expected);
    assert_eq!(read_log(&root.0, "new").unwrap(), Some(entries));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(log_path(&root.0, "new")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(conversation_dir(&root.0, "new")).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(log_path(&root.0, "new"), root.0.join("new/.conversation.jsonl"));
}

#[test]
fn serves_a_part_it_does_not_write_as_it_was_read() {
    let line = r#"{"type":"assistant","at":"now","content":[{"type":"thinking","thinking":"hm"},{"type":"toolCall","id":"1","name":"read"},{"type":"text","text":"ok","extra":1}]}"#;
    let entry = parse_entry(line.as_bytes()).unwrap();
    assert_eq!(entry.to_json().to_string(), line);
    let LogEntry::Assistant { content, .. } = &entry else { panic!("an assistant entry") };
    assert!(content.iter().all(|part| matches!(part, AssistantPart::Other(_))));
    assert_eq!(handoff_context(&[entry]).as_deref(), Some("You: [ran undefined]\n[ran read]\nok"));
}

#[test]
fn stores_a_long_text_cut_to_the_limit_and_marks_it_truncated() {
    let root = Scratch::new();
    let exact = "x".repeat(MAX_LOG_TEXT - 1);
    let long = "x".repeat(MAX_LOG_TEXT + 5);
    // A cut that would split the cat keeps the length and ends in U+FFFD.
    let split = format!("{}🐈tail", "x".repeat(MAX_LOG_TEXT - 1));
    append_log(
        &root.0,
        "s",
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
    let entries = read_log(&root.0, "s").unwrap().unwrap();
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
    assert_eq!(text(2), format!("{}\u{fffd}", "x".repeat(MAX_LOG_TEXT - 1)));
    assert_eq!(utf16_len(&text(2)), MAX_LOG_TEXT);
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
fn reads_a_text_an_earlier_version_cut_inside_a_character() {
    // JavaScript cut at a UTF-16 unit and wrote the half it kept as an escape.
    let line = r#"{"type":"user","at":"now","text":"cut \\ud83d here 🐈 and \ud83d"}"#;
    assert_eq!(parse_entry(line.as_bytes()), Some(user_at("now", "cut \\ud83d here 🐈 and \u{fffd}")));
    assert_eq!(parse_entry(br#"{"type":"user","at":"now","text":"\udc08 low \ud83dx"}"#), Some(user_at("now", "\u{fffd} low \u{fffd}x")));
    assert_eq!(repair_lone_surrogates(r#"{"text":"🐈 \\ud83d"}"#), None);
    assert_eq!(parse_entry(br#"{"type":"user","at":"now","text":"\ud83d"#), None);
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

#[test]
fn conversation_ids_are_directory_names_and_not_a_sidecars() {
    for id in ["default", "app-1", "_x", "-x", "a.b", "A9", &"x".repeat(128)] {
        assert!(is_valid_conversation_id(id), "{id}");
        assert_eq!(require_conversation_id(id).unwrap(), id);
    }
    for id in ["", ".hidden", "a/b", "a b", "é", "..", "pins.json", "reads.json", "questions.json", "x\n", &"x".repeat(129)] {
        assert!(!is_valid_conversation_id(id), "{id:?}");
        let refusal = require_conversation_id(id).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.status), ("invalid_conversation_id", 400));
        assert_eq!(refusal.message, "Conversation ids are 1-128 letters, digits, '.', '_' or '-', and not pins.json, reads.json, questions.json.");
    }
    assert_eq!(conversation_environment("app-1"), [("GHOST_SESSION".to_string(), "app-1".to_string())]);
}

// ── Titles and previews ─────────────────────────────────────────────────

/// Titles extracted from first owner messages, shaped like the owner's real ones.
#[test]
fn derives_titles() {
    for (text, title) in [
        ("can you recommend a good grocery store on the way home from here", "Recommend a good grocery store"),
        ("hey what is the latest on tsla", "What is the latest on tsla"),
        ("let's try setting up whatsapp", "Try setting up whatsapp"),
        ("Create a doc called \"Tool Approval Test Feb 26\" with some placeholder content", "Tool Approval Test Feb 26"),
        ("Weekly backup check. Run `omacloud status` and tell me.", "Weekly backup check"),
        ("[Attachment: profile_picture.jpg]\nwhat do you see", "What do you see"),
        ("what is in this picture?\n\n![image](attachments/k1-0123abcd.jpg)", "What is in this picture"),
        ("Find the latest Grok 4.5 release notes online and summarize them", "Find the latest Grok 4.5 release notes"),
        // Each way a first clause ends, and each opener that is dropped; the
        // answers are the ones the earlier daemon gave.
        ("Could you please help me to book the dentist; then lunch", "Book the dentist"),
        ("help me fix the printer — it jams", "Fix the printer"),
        ("tell me, please, what time it is", "Tell me, please, what time it"),
        ("remind me to call mom, then dad", "Remind me to call mom, then dad"),
        ("hi\u{a0}there friend of mine", "There friend of mine"),
        ("ßtraße names in the old town", "SStraße names in the old town"),
        ("𝒳 marks the spot today", "𝒳 marks the spot today"),
        ("a b", "A b"),
        ("ok so I'd like you to tidy my notes folder, and I will check it", "Tidy my notes folder"),
        ("please tell me about the moon landing - the first one", "About the moon landing"),
        ("I need to renew the car insurance: it lapses soon", "Renew the car insurance"),
        ("Order new filters, can you find the size", "Order new filters"),
        ("make a note titled “# Packing list” for the trip", "Packing list"),
        ("for me find the cheapest flight to Lisbon in", "Find the cheapest flight to Lisbon"),
        ("éclairs and other things to bake with my", "Éclairs and other things to bake"),
        ("Is v2.1 ready? I think so", "Is v2.1 ready"),
    ] {
        assert_eq!(derived_title(text).as_deref(), Some(title), "{text}");
    }
}

#[test]
fn gives_no_title_for_a_bare_greeting() {
    for text in [
        "hey",
        "Hello!",
        "",
        "ok so well",
        "thanks",
        "the",
        "![image](attachments/a-0123abcd.png)",
        // The first clause alone is looked at, and these have nothing in theirs.
        "Hello! Could you please help me to book the dentist; then lunch",
        "HEY, can you PLEASE look at THE",
        "well... let's see what the weather is",
        "yo!!! what's up with the build",
        "I want you to check: the logs",
        "summarize this:\nfoo bar",
    ] {
        assert_eq!(derived_title(text), None, "{text}");
    }
}

#[test]
fn the_preview_skips_attachment_lines_and_names_a_message_of_photos_alone() {
    let at = "2026-10-05T00:00:00.000Z";
    assert_eq!(log_state(&[user_at(at, "![image](attachments/a-0123abcd.png)\nlook at this")]).preview.as_deref(), Some("look at this"));
    let photo = log_state(&[user_at(at, "![image](attachments/a-0123abcd.png)")]);
    assert_eq!(photo.preview.as_deref(), Some("Photo"));
    assert_eq!(photo.title, None);
    // A long first line is cut to 120, without trailing white space.
    let long = format!("{} tail that is cut", "word ".repeat(24));
    assert_eq!(log_state(&[user_at(at, &long)]).preview, Some("word ".repeat(24).trim_end().to_string()));
    // A `!command` previews a conversation until the owner writes; an excluded one does not.
    let ran = [command(at, "secret", "", Some(0), true), command(at, "ls -la", "", Some(0), false), user_at(at, "now list the big files")];
    assert_eq!(log_state(&ran[..1]).preview, None);
    let state = log_state(&ran);
    assert_eq!((state.preview.as_deref(), state.title.as_deref(), state.message_count), (Some("!ls -la"), Some("Now list the big files"), 3));
}

#[test]
fn the_title_is_derived_until_the_owner_names_the_conversation_and_again_once_they_clear_it() {
    let at = "2026-10-05T00:00:00.000Z";
    let opened = user_at(at, "can you find cafes near the station");
    assert_eq!(log_state(std::slice::from_ref(&opened)).title.as_deref(), Some("Find cafes near the station"));
    assert_eq!(log_state(&[opened.clone(), title(at, Some("Coffee"))]).title.as_deref(), Some("Coffee"));
    assert_eq!(log_state(&[opened, title(at, Some("Coffee")), title(at, None)]).title.as_deref(), Some("Find cafes near the station"));
}

#[test]
fn the_title_ignores_messages_the_owner_did_not_type() {
    let at = "2026-10-05T00:00:00.000Z";
    let state = log_state(&[LogEntry::User { at: at.into(), text: "Scheduled check now".into(), origin: Some(Origin::FollowUp) }]);
    assert_eq!((state.title, state.preview, state.message_count, state.active_at.as_deref()), (None, None, 1, Some(at)));
}

// ── Transcript pages ────────────────────────────────────────────────────

#[test]
fn pages_preserve_message_ids_split_command_pairs_totals_and_out_of_range_pages() {
    let ran = command("now", "pwd", "```\n/tmp", Some(1), false);
    let entries = [
        title("now", Some("ignored")),
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

// ── The handoff ─────────────────────────────────────────────────────────

#[test]
fn the_handoff_preserves_chronological_labels_and_skips_display_only_and_excluded_entries() {
    let context = handoff_context(&[
        user_at("now", "hello"),
        LogEntry::User { at: "now".into(), text: "continue".into(), origin: Some(Origin::Hook) },
        LogEntry::Assistant {
            at: "now".into(),
            content: vec![
                AssistantPart::text(" answer "),
                AssistantPart::ToolCall { id: "1".into(), name: "read".into(), arguments: json!({}), failed: false, output: None },
            ],
            error: None,
        },
        title("now", Some("ignored")),
        command("now", "pwd", "/tmp", Some(0), false),
        command("now", "secret", "ignored", Some(0), true),
        LogEntry::Assistant { at: "now".into(), content: vec![AssistantPart::text(" \n")], error: None },
    ]);
    assert_eq!(context.as_deref(), Some("Owner: hello\n\nHook: continue\n\nYou: answer \n[ran read]\n\nOwner ran `pwd`:\n/tmp"));
    assert_eq!(handoff_context(&[]), None);
}

#[test]
fn the_handoff_matches_the_exact_suffix_across_the_context_boundary() {
    for length in [HANDOFF_CONTEXT_CHARS - 7, HANDOFF_CONTEXT_CHARS - 6, HANDOFF_CONTEXT_CHARS, HANDOFF_CONTEXT_CHARS + 1] {
        let text = "x".repeat(length);
        let full = format!("Owner: first\n\nOwner: {text}");
        assert_eq!(
            handoff_context(&[user_at("now", "first"), user_at("now", &text)]),
            Some(format!("…{}", &full[full.len() - HANDOFF_CONTEXT_CHARS..]))
        );
        let single = format!("Owner: {text}");
        let expected = if single.len() > HANDOFF_CONTEXT_CHARS { format!("…{}", &single[single.len() - HANDOFF_CONTEXT_CHARS..]) } else { single };
        assert_eq!(handoff_context(&[user_at("now", &text)]), Some(expected));
    }
}

#[test]
fn the_handoff_is_the_newest_context_alone_once_it_is_full_and_never_starts_inside_a_character() {
    assert_eq!(
        handoff_context(&[user_at("now", "old"), user_at("now", &"x".repeat(HANDOFF_CONTEXT_CHARS))]),
        Some(format!("…{}", "x".repeat(HANDOFF_CONTEXT_CHARS)))
    );
    // The cut would fall inside the cat (two UTF-16 units): it is left out whole.
    let cats = handoff_context(&[user_at("now", &format!("🐈{}", "x".repeat(HANDOFF_CONTEXT_CHARS - 1)))]).unwrap();
    assert_eq!(cats, format!("…{}", "x".repeat(HANDOFF_CONTEXT_CHARS - 1)));
}

// ── Reads from the file ─────────────────────────────────────────────────

#[test]
fn reads_chunk_boundaries_and_skips_malformed_blank_and_torn_lines() {
    let root = Scratch::new();
    let entry = user_at("now", &"🐈".repeat(40_000));
    std::fs::write(log_path(&root.0, "s"), format!("\n{}\nmalformed\nnull\n{{}}\n{{\"type\":", entry.to_json())).unwrap();
    assert_eq!(read_log(&root.0, "s").unwrap(), Some(vec![entry]));
    assert_eq!(read_log(&root.0, "missing").unwrap(), None);
}

/// A line ends at a line feed and nowhere else: U+2028 and U+2029 are written
/// unescaped inside a text, and the entry holding one is whole to both readers.
#[test]
fn a_text_holding_a_unicode_line_separator_is_one_entry_to_the_log_and_the_index() {
    let _turn = index_tests();
    let root = Scratch::new();
    let entries = [user("first\u{2028}second"), answer(AT, "one\u{2029}two\r"), user("third")];
    append_log(&root.0, "s", &entries).unwrap();
    assert!(std::fs::read_to_string(log_path(&root.0, "s")).unwrap().contains("first\u{2028}second"));
    assert_eq!(read_log(&root.0, "s").unwrap().as_deref(), Some(&entries[..]));
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap(), whole(&entries));
    assert_eq!(handoff_context(&entries).as_deref(), Some("Owner: first\u{2028}second\n\nYou: one\u{2029}two\n\nOwner: third"));
}

#[test]
fn skips_records_it_does_not_write_retired_ones_or_a_later_versions() {
    let _turn = index_tests();
    let root = Scratch::new();
    let owner = user_at("2026-10-15T00:00:00Z", "hello");
    let others = [
        json!({ "type": "resources", "at": "2026-10-15T00:01:00Z", "run": "r1", "harness": "codex",
            "resources": { "skills": ["mail"], "extensions": [], "mcpServers": [] }, "supplied": { "instructions": [], "mcpServers": [] }, "summary": "legacy" }),
        json!({ "type": "handoff", "at": "2026-10-12T00:00:00Z", "harness": "pi", "text": "idle reply" }),
        json!({ "type": "user", "at": "2026-10-12T00:00:00Z", "text": "next work", "origin": "auto" }),
        json!({ "type": "user", "at": "2026-10-30T00:00:00Z", "text": "[ghost-peer] wife\n\"hi\"", "origin": "peer" }),
        json!({ "type": "user", "at": "2026-10-30T00:00:00Z", "text": "nobody's", "origin": null }),
        json!({ "type": "sent", "at": "2026-10-30T00:01:00Z", "peer": "wife", "text": "hello back" }),
        json!({ "type": "handed", "at": "2026-10-30T00:02:00Z", "id": "m1" }),
        json!({ "type": "future", "at": "later" }),
        json!({ "type": 7 }),
        json!(["user"]),
    ];
    let body: String = std::iter::once(owner.to_json()).chain(others).map(|line| format!("{line}\n")).collect();
    std::fs::write(log_path(&root.0, "s"), body).unwrap();
    assert_eq!(read_log(&root.0, "s").unwrap(), Some(vec![owner.clone()]));
    let listed = listed_log(&root.0, "s").unwrap().unwrap();
    assert_eq!((listed.state.active_at.as_deref(), listed.state.message_count), (Some("2026-10-15T00:00:00Z"), 1));
    assert_eq!(listed.updated_at, "2026-10-15T00:00:00Z");
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap(), whole(&[owner]));
}

#[test]
fn a_log_with_no_dated_entry_is_as_new_as_its_file() {
    let _turn = index_tests();
    let root = Scratch::new();
    let path = log_path(&root.0, "s");
    std::fs::write(&path, lines(&[new_conversation_entry("s", 0)])).unwrap();
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_795_594_880_123);
    File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
    let listed = listed_log(&root.0, "s").unwrap().unwrap();
    assert_eq!(listed, ListedLog { state: LogState::default(), updated_at: "2026-11-25T08:21:20.123Z".into() });
}

#[test]
fn refreshes_a_replaced_log_even_if_its_size_and_mtime_match_the_cached_file() {
    let _turn = index_tests();
    let root = Scratch::new();
    let path = log_path(&root.0, "s");
    let replacement = path.with_extension("new");
    std::fs::write(&path, lines(&[user("first topic")])).unwrap();
    let original = std::fs::metadata(&path).unwrap();
    assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state.preview.as_deref(), Some("first topic"));
    std::fs::write(&replacement, lines(&[user("other topic")])).unwrap();
    File::options().write(true).open(&replacement).unwrap().set_modified(original.modified().unwrap()).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let replaced = std::fs::metadata(&path).unwrap();
    assert_eq!((replaced.len(), replaced.modified().unwrap()), (original.len(), original.modified().unwrap()));
    assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state.preview.as_deref(), Some("other topic"));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(listed_log(&root.0, "s").unwrap(), None);
}

#[test]
fn preserves_every_page_and_entry_id_through_incremental_appends() {
    let _turn = index_tests();
    let root = Scratch::new();
    let entries = [
        LogEntry::Conversation { v: 1, id: "s".into(), created_at: AT.into() },
        user("Explain the new feature"),
        command(AT, "printf hello", "hello", Some(0), false),
        answer(AT, "answer"),
        command(AT, "private", "hidden", Some(0), true),
        title(AT, Some("Custom title")),
    ];
    for (index, entry) in entries.iter().enumerate() {
        append_log(&root.0, "s", std::slice::from_ref(entry)).unwrap();
        assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state, log_state(&entries[..=index]));
    }
    let expected = whole(&entries);
    assert_eq!(expected.total, 4);
    for offset in 0..=expected.total + 1 {
        for limit in [1, 2, 4] {
            let messages: Vec<TranscriptMessage> = expected.messages.iter().skip(offset).take(limit).cloned().collect();
            assert_eq!(read_transcript_page(&root.0, "s", offset, limit).unwrap(), TranscriptPage { messages, total: expected.total });
        }
    }
    assert_eq!(read_transcript_page(&root.0, "s", 0, usize::MAX).unwrap(), expected);
}

#[test]
fn parses_only_appended_records_for_list_refresh_and_only_requested_records_for_a_warm_page() {
    let _turn = index_tests();
    let root = Scratch::new();
    let entries: Vec<LogEntry> = (0..1500).map(|n| user(&format!("indexed-payload-{n} {}", "x".repeat(4000)))).collect();
    append_log(&root.0, "s", &entries).unwrap();
    listed_log(&root.0, "s").unwrap();
    let before = parsed();
    assert_eq!(read_transcript_page(&root.0, "s", 1499, 1).unwrap().messages[0].entry_id, "e1499");
    assert_eq!(parsed() - before, 1);
    append_log(&root.0, "s", &[user("indexed-payload-new")]).unwrap();
    assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state.message_count, 1501);
    assert_eq!(parsed() - before, 2);
    listed_log(&root.0, "s").unwrap();
    assert_eq!(parsed() - before, 2);
    // The appended record is on the next page read, found without a rescan.
    assert_eq!(read_transcript_page(&root.0, "s", 1500, 5).unwrap().messages[0].entry_id, "e1500");
    assert_eq!(parsed() - before, 3);
}

#[test]
fn retains_lightweight_summaries_after_more_than_sixteen_offset_indexes_are_evicted() {
    let _turn = index_tests();
    let root = Scratch::new();
    for n in 0..24 {
        append_log(&root.0, &format!("summary-{n}"), &[user(&format!("summary-cache-{n}"))]).unwrap();
        listed_log(&root.0, &format!("summary-{n}")).unwrap();
    }
    let before = parsed();
    for n in 0..24 {
        assert_eq!(listed_log(&root.0, &format!("summary-{n}")).unwrap().unwrap().state.message_count, 1);
    }
    assert_eq!(parsed() - before, 0);
    // An evicted offset array can be rebuilt without affecting the summary.
    assert_eq!(read_transcript_page(&root.0, "summary-0", 0, 1).unwrap().messages[0].entry_id, "e0");
    assert_eq!(parsed() - before, 2);
    append_log(&root.0, "summary-1", &[user("summary-cache-new")]).unwrap();
    assert_eq!(listed_log(&root.0, "summary-1").unwrap().unwrap().state.message_count, 2);
    assert_eq!(parsed() - before, 3);
}

#[test]
fn keeps_page_snapshots_intact_while_concurrent_reads_evict_more_than_sixteen_indexes() {
    let _turn = index_tests();
    let root = Scratch::new();
    let names: Vec<String> = (0..24).map(|n| format!("parallel-{n}")).collect();
    for name in &names {
        let entries: Vec<LogEntry> = (0..30).map(|n| user(&format!("{name}: {n}"))).collect();
        append_log(&root.0, name, &entries).unwrap();
    }
    let pages: Vec<TranscriptPage> = std::thread::scope(|scope| {
        let reads: Vec<_> = names.iter().map(|name| scope.spawn(|| read_transcript_page(&root.0, name, 5, 20).unwrap())).collect();
        reads.into_iter().map(|read| read.join().unwrap()).collect()
    });
    for (name, page) in names.iter().zip(&pages) {
        assert_eq!((page.total, page.messages.len()), (30, 20));
        let message = |index: usize| (page.messages[index].entry_id.as_str(), page.messages[index].content.clone());
        assert_eq!(message(0), ("e5", vec![AssistantPart::text(format!("{name}: 5"))]));
        assert_eq!(message(19), ("e24", vec![AssistantPart::text(format!("{name}: 24"))]));
    }
}

#[test]
fn rebuilds_for_truncation_and_replacement() {
    let _turn = index_tests();
    let root = Scratch::new();
    let path = log_path(&root.0, "s");
    // An in-place rewrite that grows the file reads as an append: ghostd is
    // the log's only writer, and it only appends.
    for entries in [vec![user("entirely different and longer"), user("second")], vec![user("first")], vec![]] {
        let body = entries.iter().map(|entry| entry.to_json().to_string()).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&path, body).unwrap();
        assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap(), whole(&entries));
        assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state, log_state(&entries));
    }
    let replacement = path.with_extension("new");
    std::fs::write(&replacement, lines(&[user("replacement")])).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 1).unwrap().messages[0].content, [AssistantPart::text("replacement")]);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 1).unwrap(), TranscriptPage::default());
}

#[test]
fn keeps_concurrent_reads_and_appends_coherent_and_rebuilds_after_an_unterminated_record() {
    let _turn = index_tests();
    let root = Scratch::new();
    let mut entries: Vec<LogEntry> = (0..300).map(|n| user(&format!("message {n}"))).collect();
    append_log(&root.0, "s", &entries).unwrap();
    listed_log(&root.0, "s").unwrap();
    for n in 0..5 {
        let entry = user(&format!("append {n}"));
        let page = std::thread::scope(|scope| {
            let page = scope.spawn(|| read_transcript_page(&root.0, "s", 250, 10).unwrap());
            let appended = scope.spawn(|| append_log(&root.0, "s", std::slice::from_ref(&entry)).unwrap());
            let listed = scope.spawn(|| listed_log(&root.0, "s").unwrap());
            appended.join().unwrap();
            listed.join().unwrap();
            page.join().unwrap()
        });
        assert_eq!(page.messages, transcript_page(&entries, 250, 10).messages);
        entries.push(entry);
        assert_eq!(listed_log(&root.0, "s").unwrap().unwrap().state, log_state(&entries));
    }
    std::fs::write(log_path(&root.0, "s"), user("no newline").to_json().to_string()).unwrap();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap().total, 1);
    append_log(&root.0, "s", &[user("concatenated")]).unwrap();
    let actual = read_log(&root.0, "s").unwrap().unwrap_or_default();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap(), whole(&actual));
}

#[test]
fn handles_malformed_split_utf8_torn_and_valid_unterminated_final_lines() {
    let _turn = index_tests();
    let root = Scratch::new();
    let path = log_path(&root.0, "s");
    let append = |text: &str| File::options().append(true).open(&path).unwrap().write_all(text.as_bytes()).unwrap();
    let first = user(&"🐈".repeat(40_000));
    std::fs::write(&path, format!("\n{}\nmalformed\nnull\n{{}}\n{{\"type\":", first.to_json())).unwrap();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap().messages, whole(std::slice::from_ref(&first)).messages);
    append(r#""user","at":"now","text":"recovered"}"#);
    let recovered = user_at("now", "recovered");
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap().messages, whole(&[first.clone(), recovered.clone()]).messages);
    append("\n");
    append_log(&root.0, "s", &[user("last")]).unwrap();
    assert_eq!(read_transcript_page(&root.0, "s", 0, 10).unwrap(), whole(&[first, recovered, user("last")]));
}

#[test]
fn entries_and_pages_are_shareable_across_threads() {
    fn shareable<T: Send + Sync>() {}
    shareable::<LogEntry>();
    shareable::<TranscriptPage>();
    shareable::<ListedLog>();
}
