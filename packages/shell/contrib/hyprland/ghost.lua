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

-- Open history and settings instead (the bar's ghost mark does the same).
-- o.bind("SUPER + CTRL + SHIFT + G", "Ghost history", "omarchy-shell ghost section home")

-- Nothing else to bind: the shell sets the window rules for the prompt and
-- the HUD itself, at runtime.
