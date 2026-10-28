-- Ghost — Omarchy 4 (Lua) Hyprland config.
--
-- Append this binding to your own ~/.config/hypr/bindings.lua, or drop this
-- file somewhere and `require` it from ~/.config/hypr/hyprland.lua.
--
-- `o.bind(keys, description, command)` is Omarchy's wrapper — the description
-- is what `omarchy menu keybindings` shows, so give it a real one.

-- Ghost is an omarchy-shell plugin, so summoning it is a shell IPC call into
-- the shell that is already running. `toggle` lights the screen edges and
-- opens a prompt that is already listening; pressed again, it closes the
-- prompt. Leave Omarchy's SUPER+G window-grouping shortcut intact.
o.bind("SUPER + CTRL + G", "Summon ghost", "omarchy-shell shell toggle ferdousbhai.ghost")

-- Summon a named ghost directly.
-- o.bind("SUPER + SHIFT + G", "Summon casper", "omarchy-shell ghost summon casper")

-- Open the chat window instead (the bar's ghost mark does the same).
-- o.bind("SUPER + CTRL + SHIFT + G", "Ghost window", "omarchy-shell ghost section chat")

-- Nothing else to bind. The chat window is a real toplevel window, so
-- Hyprland's own binds act on it like any app: SHIFT+SUPER+<n> sends it to a workspace and it
-- tiles and resizes in the normal layout.
--
-- A window rule has to match by title, not app-id: a plugin's window carries
-- the host shell's app-id (org.quickshell), and only a root shell.qml may set
-- one. Uncomment to float it at a fixed size instead of tiling:
-- hl.window_rule({ match = { title = "^Ghost( — .*)?$" }, float = true })
-- hl.window_rule({ match = { title = "^Ghost( — .*)?$" }, size = { 880, 620 } })
