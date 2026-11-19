// SPDX-License-Identifier: MIT
//! Ghost's look, from lastbook-for-omarchy's theme module: Omarchy's current theme turned into nine semantic colours, applied as GTK CSS, and followed live.
//!
//! The approach, the token set, the Omarchy mapping and the contrast floors follow Strata (github.com/lgse/strata, MIT,
//! src/ui/theme*), so Ghost sits beside it and Lastbook on an Omarchy desktop: the palette comes from
//! ~/.local/state/omarchy/current/theme/colors.toml, the default "darker" variant puts content on the theme's darker
//! background, JetBrains Mono is the interface font, sizes scale from a 13 px root with the desktop's text size, and
//! GTK's own theme is reset underneath so a user's gtk.css cannot reshape the widgets. Without Omarchy, Tokyo Night.

use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Duration};

use gtk::{gdk, gio, glib, prelude::*};

/// The colours every stylesheet rule is written against (`@gh_<name>`).
#[derive(Clone, Debug, PartialEq)]
pub struct Tokens {
    pub name: String,
    pub background: String,
    pub surface: String,
    pub text: String,
    pub accent: String,
    pub danger: String,
    pub muted: String,
    pub highlight: String,
    pub border: String,
    pub dim_text: String,
    pub light: bool,
}

/// Strata's three ways of laying an Omarchy palette out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Variant {
    /// The plain mapping: content on the theme's background.
    Lighter,
    /// Content on the theme's darker background, as Strata does by default.
    Darker,
    /// Darker, with text, accents and borders raised to contrast floors.
    Contrast,
}

/// Tokyo Night, Strata's default, for a desktop without Omarchy.
pub fn fallback() -> Tokens {
    tokens_from_colors(
        "tokyo-night",
        r##"mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
lighter_background = "#24283b"
foreground = "#a9b1d6"
red = "#f7768e""##,
        Variant::Darker,
    )
    .expect("the bundled palette parses")
}

pub fn omarchy_state_dir() -> PathBuf {
    glib::home_dir().join(".local/state/omarchy/current")
}

/// Omarchy's current theme, or None when this desktop has no readable one.
pub fn read_omarchy(variant: Variant) -> Option<Tokens> {
    let state = omarchy_state_dir();
    let name = std::fs::read_to_string(state.join("theme.name")).unwrap_or_else(|_| "omarchy".into());
    let colors = std::fs::read_to_string(state.join("theme/colors.toml")).ok()?;
    tokens_from_colors(name.trim(), &colors, variant)
}

/// Strata's `tokens_from_quattro`: Omarchy palette keys to semantic colours.
pub fn tokens_from_colors(name: &str, source: &str, variant: Variant) -> Option<Tokens> {
    let values: toml::Table = toml::from_str(source).ok()?;
    let get = |key: &str| values.get(key).and_then(|v| v.as_str()).and_then(canonical);
    let source_background = get("background")?;
    let text = get("foreground")?;
    let accent = get("accent")?;
    let selection = get("selection").unwrap_or_else(|| blend(&source_background, &accent, 0.25));
    // Some themes set lighter_background equal to background, which would hide hover.
    let lighter = get("lighter_background")
        .filter(|l| *l != source_background)
        .unwrap_or_else(|| blend(&source_background, &text, 0.10));
    let light = match values.get("mode").and_then(|v| v.as_str()) {
        Some("light") => true,
        Some("dark") => false,
        _ => luminance(&source_background) > 0.45,
    };
    let mut t = Tokens {
        name: name.to_owned(),
        surface: get("dark_background").unwrap_or_else(|| source_background.clone()),
        background: source_background.clone(),
        muted: lighter,
        highlight: selection,
        border: get("muted").unwrap_or_else(|| blend(&source_background, &text, 0.36)),
        dim_text: blend(&source_background, &text, 0.62),
        text,
        accent,
        danger: get("red").or_else(|| get("color1")).unwrap_or_else(|| "#e5484d".into()),
        light,
    };
    if variant != Variant::Lighter {
        t.background = t.surface.clone();
    }
    if variant == Variant::Contrast {
        apply_contrast(&mut t);
    }
    Some(t)
}

fn apply_contrast(t: &mut Tokens) {
    let (back_pole, fore_pole) = if t.light { ("#ffffff", "#000000") } else { ("#000000", "#ffffff") };
    for surface in [&mut t.background, &mut t.surface, &mut t.muted, &mut t.highlight] {
        *surface = toward(surface, back_pole, |c| contrast(c, fore_pole) >= 7.0);
    }
    let backs = [t.background.clone(), t.surface.clone(), t.muted.clone(), t.highlight.clone()];
    t.text = readable(&t.text, &backs, fore_pole, 7.0);
    t.dim_text = readable(&t.dim_text, &backs, fore_pole, 4.5);
    t.accent = readable(&t.accent, &backs, fore_pole, 4.5);
    t.danger = readable(&t.danger, &backs, fore_pole, 4.5);
    t.border = readable(&t.border, &backs, fore_pole, 3.0);
}

/// Moves `color` toward `pole` until `done` holds; only luminance changes, so hue is kept.
fn toward(color: &str, pole: &str, done: impl Fn(&str) -> bool) -> String {
    (0..=255).map(|s| blend(color, pole, f64::from(s) / 255.0)).find(|c| done(c)).unwrap_or_else(|| pole.to_owned())
}

pub fn readable(color: &str, backgrounds: &[String], pole: &str, ratio: f64) -> String {
    toward(color, pole, |c| backgrounds.iter().all(|b| contrast(c, b) >= ratio))
}

fn channels(color: &str) -> Option<[u8; 3]> {
    let c = gdk::RGBA::parse(color).ok()?;
    let ch = |v: f32| (f64::from(v).clamp(0.0, 1.0) * 255.0).round() as u8;
    Some([ch(c.red()), ch(c.green()), ch(c.blue())])
}

/// A colour GTK can parse, written as `#rrggbb`; None when it cannot be read.
pub fn canonical(value: &str) -> Option<String> {
    channels(value).map(|[r, g, b]| format!("#{r:02x}{g:02x}{b:02x}"))
}

pub fn blend(left: &str, right: &str, amount: f64) -> String {
    let (Some(l), Some(r)) = (channels(left), channels(right)) else {
        return right.to_owned();
    };
    let ch = |i: usize| (f64::from(l[i]) + (f64::from(r[i]) - f64::from(l[i])) * amount).round() as u8;
    format!("#{:02x}{:02x}{:02x}", ch(0), ch(1), ch(2))
}

fn luminance(color: &str) -> f64 {
    let c = channels(color).unwrap_or([0, 0, 0]).map(|v| {
        let v = f64::from(v) / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    });
    c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

pub fn contrast(a: &str, b: &str) -> f64 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

// ------------------------------------------------------------------------------------------------ applying it to GTK --

/// Above GTK's user priority, every property is unset and GTK's built-in theme restated, so `~/.config/gtk-4.0/gtk.css`
/// cannot decide any of them (Strata's layering).
const RESET_PRIORITY: u32 = gtk::STYLE_PROVIDER_PRIORITY_USER + 1;
const BASE_PRIORITY: u32 = RESET_PRIORITY + 1;
const STYLE_PRIORITY: u32 = BASE_PRIORITY + 1;
const TOKEN_PRIORITY: u32 = STYLE_PRIORITY + 1;
const STYLE_CSS: &str = include_str!("style.css");
pub const ROOT_FONT_PX: f64 = 13.0;
const FONTS: &str = "\"JetBrains Mono\", \"JetBrainsMono Nerd Font\", monospace";

pub struct Theme {
    base: gtk::CssProvider,
    tokens_css: gtk::CssProvider,
    pub tokens: RefCell<Tokens>,
    variant: Variant,
    monitors: RefCell<Vec<gio::FileMonitor>>,
    pending: RefCell<Option<glib::SourceId>>,
}

impl Theme {
    pub fn install(display: &gdk::Display) -> Rc<Self> {
        let reset = gtk::CssProvider::new();
        reset.load_from_string("* { all: unset; }");
        let style = gtk::CssProvider::new();
        style.load_from_string(STYLE_CSS);
        let theme = Rc::new(Self {
            base: gtk::CssProvider::new(),
            tokens_css: gtk::CssProvider::new(),
            tokens: RefCell::new(fallback()),
            variant: Variant::Darker,
            monitors: RefCell::new(Vec::new()),
            pending: RefCell::new(None),
        });
        gtk::style_context_add_provider_for_display(display, &reset, RESET_PRIORITY);
        gtk::style_context_add_provider_for_display(display, &theme.base, BASE_PRIORITY);
        gtk::style_context_add_provider_for_display(display, &style, STYLE_PRIORITY);
        gtk::style_context_add_provider_for_display(display, &theme.tokens_css, TOKEN_PRIORITY);
        if let Some(settings) = gtk::Settings::default() {
            let weak = Rc::downgrade(&theme);
            settings.connect_gtk_xft_dpi_notify(move |_| {   // the desktop's text size changed
                if let Some(t) = weak.upgrade() {
                    t.apply();
                }
            });
        }
        theme.reload();
        theme.watch();
        theme
    }

    fn reload(&self) {
        // Omarchy's state can be unreadable mid-switch: the window keeps its colours until it can be read again.
        let next = read_omarchy(self.variant).or_else(|| (!omarchy_state_dir().exists()).then(fallback));
        if let Some(next) = next {
            self.tokens.replace(next);
        }
        self.apply();
    }

    /// The desktop's text size, as GTK reads it from the settings portal (gtk-xft-dpi, 96 dpi = 1.0).
    pub fn text_scale() -> f64 {
        gtk::Settings::default()
            .map(|s| s.gtk_xft_dpi())
            .filter(|d| *d > 0)
            .map(|d| (f64::from(d) / 1024.0 / 96.0).clamp(0.5, 3.0))
            .unwrap_or(1.0)
    }

    fn apply(&self) {
        let t = self.tokens.borrow().clone();
        let root = (ROOT_FONT_PX * Self::text_scale()).round();
        let dark = !t.light;
        self.base.load_from_string(&format!(
            "@import url(\"resource:///org/gtk/libgtk/theme/Default/{}\");",
            if dark { "gtk-dark.css" } else { "gtk.css" }
        ));
        if let Some(settings) = gtk::Settings::default() {
            // GTK 4.20 and later read the colour scheme setting; older ones the dark-theme flag (Strata does the same).
            if settings.find_property("gtk-interface-color-scheme").is_some() {
                set_enum_setting(&settings, "gtk-interface-color-scheme", if dark { "dark" } else { "light" });
            } else {
                settings.set_gtk_application_prefer_dark_theme(dark);
            }
            settings.set_gtk_font_name(Some(&format!("JetBrains Mono {}px", root)));
        }
        self.tokens_css.load_from_string(&format!(
            "@define-color gh_bg {};\n@define-color gh_surface {};\n@define-color gh_text {};\n@define-color gh_accent {};\n\
             @define-color gh_danger {};\n@define-color gh_muted {};\n@define-color gh_highlight {};\n@define-color gh_border {};\n\
             @define-color gh_dim_text {};\nwindow, popover, popover.background, tooltip {{ font-size: {root}px; }}\n\
             *, popover.background label, popover.background button {{ font-family: {FONTS}; }}\n",
            t.background, t.surface, t.text, t.accent, t.danger, t.muted, t.highlight, t.border, t.dim_text
        ));
    }

    /// Omarchy replaces the theme directory and rewrites theme.name on a switch: watch the state directory, the theme
    /// directory it points to, and its parents, and re-read shortly after the last change.
    fn watch(self: &Rc<Self>) {
        let state = omarchy_state_dir();
        let home = glib::home_dir();
        let mut dirs: Vec<PathBuf> = std::fs::canonicalize(state.join("theme")).ok().into_iter().collect();
        dirs.extend(state.ancestors().take_while(|p| p.starts_with(&home) && *p != home).map(PathBuf::from));
        let mut monitors = Vec::new();
        for dir in dirs.into_iter().filter(|d| d.is_dir()) {
            let Ok(m) = gio::File::for_path(&dir).monitor_directory(gio::FileMonitorFlags::WATCH_MOVES, gio::Cancellable::NONE) else {
                continue;
            };
            let weak = Rc::downgrade(self);
            m.connect_changed(move |_, _, _, _| {
                if let Some(t) = weak.upgrade() {
                    t.schedule();
                }
            });
            monitors.push(m);
        }
        self.monitors.replace(monitors);
    }

    fn schedule(self: &Rc<Self>) {
        if let Some(id) = self.pending.take() {
            id.remove();
        }
        let weak = Rc::downgrade(self);
        let id = glib::timeout_add_local_once(Duration::from_millis(150), move || {
            if let Some(t) = weak.upgrade() {
                t.pending.take();
                t.reload();
                t.watch();   // the theme directory a switch replaced is a new directory
            }
        });
        self.pending.replace(Some(id));
    }
}

/// Sets an enum GTK setting by its nick, skipping properties this GTK lacks (Strata's helper).
fn set_enum_setting(settings: &gtk::Settings, property: &str, nick: &str) {
    let Some(spec) = settings.find_property(property) else { return };
    if let Some(value) = glib::EnumClass::with_type(spec.value_type()).and_then(|class| class.to_value_by_nick(nick)) {
        settings.set_property(property, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKYO: &str = r##"mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
lighter_background = "#24283b"
foreground = "#a9b1d6"
red = "#f7768e""##;

    #[test]
    fn darker_puts_content_on_the_dark_background() {
        let t = tokens_from_colors("tokyo-night", TOKYO, Variant::Darker).unwrap();
        assert_eq!((t.background.as_str(), t.surface.as_str()), ("#13141c", "#13141c"));
        assert_eq!((t.text.as_str(), t.accent.as_str(), t.border.as_str()), ("#a9b1d6", "#7aa2f7", "#414868"));
        assert!(!t.light);
        let lighter = tokens_from_colors("tokyo-night", TOKYO, Variant::Lighter).unwrap();
        assert_eq!(lighter.background, "#1a1b26");
    }

    #[test]
    fn missing_keys_are_derived_and_unreadable_ones_refused() {
        let t = tokens_from_colors("x", "background = \"#ffffff\"\nforeground = \"#000000\"\naccent = \"#0000ff\"", Variant::Lighter).unwrap();
        assert!(t.light, "a light background with no mode reads as light");
        assert_eq!(t.muted, "#e6e6e6");
        assert!(tokens_from_colors("x", "background = \"nonsense\"\nforeground = \"#000\"\naccent = \"#00f\"", Variant::Lighter).is_none());
    }

    #[test]
    fn contrast_raises_what_is_too_faint() {
        let faint = "mode = \"dark\"\nbackground = \"#202020\"\nforeground = \"#505050\"\naccent = \"#303060\"\nmuted = \"#282828\"";
        let t = tokens_from_colors("faint", faint, Variant::Contrast).unwrap();
        for (c, floor) in [(&t.text, 7.0), (&t.accent, 4.5), (&t.border, 3.0)] {
            assert!(contrast(c, &t.background) >= floor, "{c} on {}", t.background);
        }
    }
}
