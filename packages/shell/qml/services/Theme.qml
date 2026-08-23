pragma Singleton

// Theme — Ghost keeps Omarchy's accent and semantic colours, while its own
// reading surfaces use a quiet neutral foundation. This prevents a theme's
// decorative muted colour from becoming low-contrast body copy and gives the
// HUD a stable hierarchy across light and dark Omarchy themes.
//
// Omarchy (>= 4.0 "Quattro") keeps the active theme as a *copy* at
// ~/.local/state/omarchy/current/theme/. Two files matter to us:
//
//   colors.toml   flat `key = "#rrggbb"` pairs + `mode = "dark"|"light"`
//   shell.toml    sectioned TOML; [bar] gives us bar height/colors so a
//                 standalone ghost bar surface lines up with Omarchy's own
//
// Only the keys the theme author actually wrote are present in colors.toml —
// Omarchy derives the rest (color0..15, bg/fg aliases, bright_* mixes) in
// `omarchy-theme-color`. We deliberately do NOT shell out to that script on
// every read: the ~10 keys we need are the ones every stock theme writes, and
// a synchronous subprocess in a HUD open path is worse than a fallback.
//
// Theme switches: `omarchy-theme-set` does `rm -rf theme/ && mv next-theme/
// theme/`, which destroys any inotify watch on files *inside* that directory —
// Omarchy's own shell hits this and sets watchChanges: false. It then rewrites
// theme.name in place with `echo >`, so a watch on *that* file survives and
// gives us a reliable single-shot edge. We watch theme.name and re-read
// colors.toml when it fires.
//
// Everything degrades to the fallback palette below when Omarchy is absent,
// so these surfaces still run on a bare Hyprland or in a nested compositor.
import Quickshell
import Quickshell.Io
import QtQuick

Singleton {
    id: root

    readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
        + "/omarchy/current"

    /** Raw key → value from colors.toml. Empty when Omarchy is not installed. */
    property var colors: ({})
    /** Raw "section.key" → value from shell.toml. */
    property var shell: ({})
    /** Theme name, e.g. "tokyo-night". Empty when unknown. */
    property string themeName: ""
    /** True when we are painting on top of an Omarchy theme rather than the fallback. */
    readonly property bool themed: Object.keys(root.colors).length > 0
    /** Explicit accessibility escape hatch for every decorative loop. */
    readonly property bool reducedMotion: {
        const value = String(Quickshell.env("GHOST_REDUCE_MOTION") || "").toLowerCase();
        return value === "1" || value === "true" || value === "yes";
    }

    // ---- Fallback palette -------------------------------------------------
    // Tokyo Night, Omarchy's default theme. Chosen so a non-Omarchy machine
    // gets a coherent dark surface rather than Qt's default battleship grey.
    readonly property var fallback: ({
        "mode": "dark",
        "background": "#1a1b26",
        "dark_background": "#13141c",
        "darker_background": "#0e0e14",
        "lighter_background": "#24283b",
        "foreground": "#a9b1d6",
        "dark_foreground": "#565f89",
        "bright_foreground": "#c0caf5",
        "accent": "#7aa2f7",
        "selection": "#292e42",
        "muted": "#414868",
        "red": "#f7768e",
        "green": "#9ece6a",
        "yellow": "#e0af68",
        "magenta": "#ad8ee6"
    })

    function pick(key: string): string {
        const value = root.colors[key];
        return (value !== undefined && value !== "") ? value : root.fallback[key];
    }

    // ---- Semantic roles ---------------------------------------------------
    readonly property bool light: root.pick("mode") === "light"

    // Neutral canvas and ink ladder. Omarchy can be richly coloured; the chat
    // itself stays neutral so long-form text, rows, and controls remain calm.
    readonly property color background: root.light ? "#fafafa" : "#0d0d0d"
    readonly property color surface: root.light ? "#ffffff" : "#161616"
    readonly property color surfaceDeep: root.light ? "#f2f2f2" : "#1b1b1b"
    readonly property color foregroundBright: root.light ? "#111111" : "#f5f5f5"
    readonly property color foreground: root.light ? "#383838" : "#c7c7c7"
    readonly property color foregroundDim: root.light ? "#666666" : "#929292"
    readonly property color foregroundFaint: root.light ? "#858585" : "#707070"

    // Chrome has its own ladder instead of borrowing a text colour.
    readonly property color hover: root.light ? "#eeeeee" : "#212121"
    readonly property color selection: root.light ? "#e5e5e5" : "#2a2a2a"
    readonly property color pressed: root.light ? "#dddddd" : "#343434"
    readonly property color border: root.light ? "#dedede" : "#292929"
    readonly property color borderStrong: root.light ? "#bdbdbd" : "#444444"
    // Compatibility alias for host integrations; new UI code should choose a
    // text or border token explicitly.
    readonly property color muted: root.border

    // One inherited accent carries focus, selection, and the active state.
    readonly property color accent: root.pick("accent")
    readonly property color danger: root.pick("red")
    readonly property color ok: root.pick("green")
    readonly property color warn: root.pick("yellow")
    readonly property color thinking: root.pick("magenta")
    readonly property color onAccent: {
        const luma = root.accent.r * 0.299 + root.accent.g * 0.587 + root.accent.b * 0.114;
        return luma > 0.58 ? "#111111" : "#ffffff";
    }

    /** Bar geometry, from the theme's [bar] section when present. */
    readonly property int barSize: Number(root.shell["bar.size-horizontal"]) || 26
    readonly property color barBackground: root.shell["bar.background"] || root.background
    readonly property color barForeground: root.shell["bar.text"] || root.foreground
    readonly property color barActive: root.shell["bar.active"] || root.accent

    // ---- Fixed design tokens ---------------------------------------------
    // Not themed by Omarchy; kept here so every surface agrees on an 8px
    // rhythm, restrained rounding, and a readable native type scale.
    readonly property int radius: 8
    readonly property int pad: 16
    readonly property int gap: 8
    readonly property int sectionGap: 24
    readonly property int controlHeight: 36
    readonly property string fontFamily: "sans-serif"
    readonly property string fontFamilyMono: root.shell["font.family"] || "monospace"
    readonly property int fontSize: Number(root.shell["font.body"]) || 14
    readonly property int fontSizeSmall: Number(root.shell["font.body-small"]) || 12

    // ---- TOML ------------------------------------------------------------
    // A deliberately small parser. Omarchy's theme files are generated from
    // templates and only ever contain `key = "value"`, `key = number`,
    // `key = true`, `# comment` and `[section]`. Anything fancier (arrays,
    // inline tables, multi-line strings) does not appear and is skipped rather
    // than mis-parsed.
    function parseToml(text: string, sectioned: bool): var {
        const out = {};
        let section = "";
        for (const rawLine of text.split("\n")) {
            const line = rawLine.trim();
            if (line === "" || line.startsWith("#")) continue;
            if (line.startsWith("[")) {
                section = sectioned ? line.replace(/^\[|\]$/gu, "").trim() + "." : "";
                continue;
            }
            const eq = line.indexOf("=");
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim().replace(/\s+#.*$/u, "");
            if (/^["']/u.test(value)) value = value.slice(1, -1);
            out[section + key] = value;
        }
        return out;
    }

    function reload(): void {
        colorsFile.reload();
        shellFile.reload();
        nameFile.reload();
    }

    FileView {
        id: colorsFile
        path: root.stateDir + "/theme/colors.toml"
        blockLoading: true
        printErrors: false
        onLoaded: root.colors = root.parseToml(colorsFile.text(), false)
        onLoadFailed: root.colors = ({})
    }

    FileView {
        id: shellFile
        path: root.stateDir + "/theme/shell.toml"
        blockLoading: true
        printErrors: false
        onLoaded: root.shell = root.parseToml(shellFile.text(), true)
        onLoadFailed: root.shell = ({})
    }

    // The one watchable file: rewritten in place on every theme switch, and
    // it survives the directory swap that kills watches inside theme/.
    FileView {
        id: nameFile
        path: root.stateDir + "/theme.name"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onLoaded: root.themeName = nameFile.text().trim()
        onLoadFailed: root.themeName = ""
        onFileChanged: {
            nameFile.reload();
            // The directory swap has already happened by the time theme.name is
            // rewritten, so re-reading immediately is safe.
            colorsFile.reload();
            shellFile.reload();
        }
    }
}
