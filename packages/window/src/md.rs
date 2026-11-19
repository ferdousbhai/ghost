// SPDX-License-Identifier: MIT
//! The assistant's Markdown as GTK labels: paragraphs, headings, lists, emphasis and code, with citation keys like [S3]
//! turned into links ("cite:S3") the chat page answers.

use gtk::{glib, prelude::*};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// One block of the answer: its Pango markup and how it is shown.
#[derive(Debug, PartialEq)]
pub enum Block {
    Para(String),
    Heading(String),
    Item { depth: usize, marker: String, markup: String },
    Code(String),
}

/// Citation keys the assistant writes (S for library sources, M for map results), including grouped forms like [S1, S2].
fn cite_links(escaped: &str, cited: &dyn Fn(&str) -> bool) -> String {
    let mut out = String::new();
    let mut rest = escaped;
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find(']') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let keys: Vec<&str> = inner.split([',', ';']).map(str::trim).collect();
        let all_keys = !keys.is_empty() && keys.iter().all(|k| k.len() >= 2 && matches!(&k[..1], "S" | "M") && k[1..].chars().all(|c| c.is_ascii_digit()));
        if all_keys {
            for k in keys {
                let label = k.trim_start_matches('S');
                // Bracketed and full size: superscripts of [S2][S4] side by side read as "24".
                if cited(k) {
                    out.push_str(&format!("<a href=\"cite:{k}\">[{label}]</a>"));
                } else {
                    out.push_str(&format!("<span alpha=\"60%\">[{label}]</span>"));
                }
            }
        } else {
            out.push('[');
            out.push_str(inner);
            out.push(']');
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Whether a label can show this markup. GtkLabel reads <a href> itself, but Pango's parser rejects it, so links are
/// taken out before asking Pango.
pub fn valid_markup(m: &str) -> bool {
    let mut plain = String::with_capacity(m.len());
    let mut rest = m;
    while let Some(i) = rest.find("<a ") {
        plain.push_str(&rest[..i]);
        match rest[i..].find('>') {
            Some(j) => rest = &rest[i + j + 1..],
            None => return false,
        }
    }
    plain.push_str(rest);
    gtk::pango::parse_markup(&plain.replace("</a>", ""), '\0').is_ok()
}

pub fn blocks(md: &str, cited: &dyn Fn(&str) -> bool) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut in_item = false;
    let mut item_marker = String::new();
    let mut heading = false;
    let mut code: Option<String> = None;
    let flush = |cur: &mut String, out: &mut Vec<Block>, heading: bool, in_item: bool, lists: &Vec<Option<u64>>, marker: &str| {
        let text = cur.trim().to_owned();
        cur.clear();
        if text.is_empty() {
            return;
        }
        let markup = cite_links(&text, cited);
        out.push(if heading {
            Block::Heading(markup)
        } else if in_item {
            Block::Item { depth: lists.len().saturating_sub(1), marker: marker.to_owned(), markup }
        } else {
            Block::Para(markup)
        });
    };
    for ev in Parser::new_ext(md, Options::ENABLE_STRIKETHROUGH) {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                heading = level <= HeadingLevel::H6;
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                heading = false;
            }
            Event::Start(Tag::List(start)) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                lists.pop();
                in_item = !lists.is_empty();
            }
            Event::Start(Tag::Item) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                in_item = true;
                item_marker = match lists.last_mut() {
                    Some(Some(n)) => {
                        let m = format!("{n}.");
                        *n += 1;
                        m
                    }
                    _ => "•".into(),
                };
            }
            Event::End(TagEnd::Item) => flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker),
            Event::End(TagEnd::Paragraph) => flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker),
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                code = Some(String::new());
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(c) = code.take() {
                    out.push(Block::Code(glib::markup_escape_text(c.trim_end()).to_string()));
                }
            }
            Event::Start(Tag::Strong) => cur.push_str("<b>"),
            Event::End(TagEnd::Strong) => cur.push_str("</b>"),
            Event::Start(Tag::Emphasis) => cur.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => cur.push_str("</i>"),
            Event::Start(Tag::Strikethrough) => cur.push_str("<s>"),
            Event::End(TagEnd::Strikethrough) => cur.push_str("</s>"),
            Event::Code(t) => cur.push_str(&format!("<tt>{}</tt>", glib::markup_escape_text(&t))),
            Event::Text(t) => match code.as_mut() {
                Some(c) => c.push_str(&t),
                None => cur.push_str(&glib::markup_escape_text(&t)),
            },
            Event::SoftBreak => cur.push(' '),
            Event::HardBreak => cur.push('\n'),
            _ => {}
        }
    }
    flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
    out
}

/// The answer as widgets in `into` (emptied first). `on_link` gets "cite:S3" when a citation is clicked.
pub fn render(into: &gtk::Box, md: &str, cited: &dyn Fn(&str) -> bool, on_link: impl Fn(&str) + Clone + 'static) {
    while let Some(c) = into.first_child() {
        into.remove(&c);
    }
    for b in blocks(md, cited) {
        let (markup, class, indent, marker) = match &b {
            Block::Para(m) => (m.clone(), "md-p", 0, None),
            Block::Heading(m) => (m.clone(), "md-h", 0, None),
            Block::Item { depth, marker, markup } => (markup.clone(), "md-li", *depth, Some(marker.clone())),
            Block::Code(m) => (m.clone(), "md-code", 0, None),
        };
        let label = gtk::Label::new(None);
        if valid_markup(&markup) {
            label.set_markup(&markup);
        } else {
            label.set_text(&markup);   // half-written markup mid-stream: shown as text until it closes
        }
        label.add_css_class(class);
        label.set_xalign(0.0);
        label.set_wrap(true);
        label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        label.set_selectable(true);
        label.set_hexpand(true);
        let f = on_link.clone();
        label.connect_activate_link(move |_, uri| {
            f(uri);
            glib::Propagation::Stop
        });
        if let Some(marker) = marker {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            row.set_margin_start(4 + 18 * indent as i32);
            let m = gtk::Label::new(Some(&marker));
            m.add_css_class("md-marker");
            m.set_valign(gtk::Align::Start);
            m.set_width_chars(if marker.len() > 2 { 3 } else { 2 });
            m.set_xalign(1.0);
            row.append(&m);
            row.append(&label);
            into.append(&row);
        } else {
            into.append(&label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn citations_become_links_only_when_cited() {
        let b = blocks("Boil it **one minute** [S2][S9], or [S1, S3].", &|k| k != "S9");
        let Block::Para(m) = &b[0] else { panic!("{b:?}") };
        assert!(m.contains("<b>one minute</b>"));
        assert!(m.contains("<a href=\"cite:S2\">[2]</a>"));
        assert!(m.contains("[9]") && !m.contains("cite:S9"), "an uncited key is not a link");
        assert!(m.contains("cite:S1") && m.contains("cite:S3"), "grouped keys split");
        assert!(valid_markup(m));
        assert!(!valid_markup("<b>half"), "unclosed markup is refused");
    }

    #[test]
    fn lists_headings_and_escaping() {
        let b = blocks("### Steps\n1. Fill <1 L> & stir\n2. Wait\n\n- note", &|_| true);
        assert_eq!(b[0], Block::Heading("Steps".into()));
        assert_eq!(b[1], Block::Item { depth: 0, marker: "1.".into(), markup: "Fill &lt;1 L&gt; &amp; stir".into() });
        assert!(matches!(&b[2], Block::Item { marker, .. } if marker == "2."));
        assert!(matches!(&b[3], Block::Item { marker, .. } if marker == "•"));
    }

    #[test]
    fn brackets_that_are_not_citations_stay() {
        let b = blocks("See [the manual] and [S] and [S1x].", &|_| true);
        let Block::Para(m) = &b[0] else { panic!() };
        assert_eq!(m, "See [the manual] and [S] and [S1x].");
    }
}
