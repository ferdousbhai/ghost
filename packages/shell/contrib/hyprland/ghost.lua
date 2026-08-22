-- Ghost shell — Omarchy 4 (Lua) Hyprland config.
--
-- Omarchy's Hyprland config is Lua as of 4.0. Append these lines to your own
-- ~/.config/hypr/bindings.lua (the binding) and ~/.config/hypr/looknfeel.lua
-- (the layer rules), or drop this whole file somewhere and `require` it from
-- ~/.config/hypr/hyprland.lua.
--
-- `o.bind(keys, description, command)` is Omarchy's wrapper — the description
-- is what `omarchy menu keybindings` shows, so give it a real one.

-- ---- Summon ---------------------------------------------------------------
o.bind("SUPER + G", "Summon ghost", "qs -c ghost ipc call ghost toggle")

-- Summon a named ghost directly.
-- o.bind("SUPER + SHIFT + G", "Summon casper", "qs -c ghost ipc call ghost summon casper")

-- ---- Layer rules ----------------------------------------------------------
-- The HUD animates itself; skip the compositor's layer fade so summoning is
-- instant. `^ghost-` is anchored so it cannot collide with Omarchy's own
-- namespaces (note Omarchy's `omarchy-bar` rule is deliberately unanchored).
hl.layer_rule({ match = { namespace = "^ghost-" }, no_anim = true, animation = "none" })

-- ---- Autostart ------------------------------------------------------------
-- Put this in ~/.config/hypr/autostart.lua instead if you prefer Hyprland to
-- own the lifecycle rather than systemd (contrib/systemd/):
-- o.launch_on_start("qs -c ghost")
