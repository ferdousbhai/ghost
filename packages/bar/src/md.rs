//! The assistant's Markdown as GTK labels: paragraphs, headings, lists, emphasis and code.

use gtk::{glib, prelude::*};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// One block of the answer: its Pango markup and how it is shown.
#[derive(Debug, PartialEq)]
enum Block {
    Para(String),
    Heading(String),
    Item { depth: usize, marker: String, markup: String },
    Code(String),
}

/// Whether a label can show this markup.
fn valid_markup(m: &str) -> bool {
    gtk::pango::parse_markup(m, '\0').is_ok()
}

fn blocks(md: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut in_item = false;
    let mut item_marker = String::new();
    let mut heading = false;
    let mut code: Option<String> = None;
    let flush = |cur: &mut String, out: &mut Vec<Block>, heading: bool, in_item: bool, lists: &Vec<Option<u64>>, marker: &str| {
        let markup = cur.trim().to_owned();
        cur.clear();
        if markup.is_empty() {
            return;
        }
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
            Event::Start(Tag::Heading { .. }) => {
                flush(&mut cur, &mut out, heading, in_item, &lists, &item_marker);
                heading = true;
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

/// The answer as widgets in `into` (emptied first).
pub fn render(into: &gtk::Box, md: &str) {
    omui::clear(into);
    for b in blocks(md) {
        let (markup, class, indent, marker) = match &b {
            Block::Para(m) => (m.clone(), "md-p", 0, None),
            Block::Heading(m) => (m.clone(), "md-h", 0, None),
            Block::Item { depth, marker, markup } => (markup.clone(), "md-li", *depth, Some(marker.clone())),
            Block::Code(m) => (m.clone(), "md-code", 0, None),
        };
        let label = omui::label("", class);
        if valid_markup(&markup) {
            label.set_markup(&markup);
        } else {
            label.set_text(&markup); // half-written markup mid-stream: shown as text until it closes
        }
        label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        label.set_selectable(true);
        label.set_hexpand(true);
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
    fn emphasis_and_unclosed_markup() {
        let b = blocks("Boil it **one minute**.");
        let Block::Para(m) = &b[0] else { panic!("{b:?}") };
        assert_eq!(m, "Boil it <b>one minute</b>.");
        assert!(valid_markup(m));
        assert!(!valid_markup("<b>half"), "unclosed markup is refused");
    }

    #[test]
    fn lists_headings_and_escaping() {
        let b = blocks("### Steps\n1. Fill <1 L> & stir\n2. Wait\n\n- note");
        assert_eq!(b[0], Block::Heading("Steps".into()));
        assert_eq!(b[1], Block::Item { depth: 0, marker: "1.".into(), markup: "Fill &lt;1 L&gt; &amp; stir".into() });
        assert!(matches!(&b[2], Block::Item { marker, .. } if marker == "2."));
        assert!(matches!(&b[3], Block::Item { marker, .. } if marker == "•"));
    }
}
