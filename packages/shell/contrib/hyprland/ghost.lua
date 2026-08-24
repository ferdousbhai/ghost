-- Ghost shell — Omarchy 4 (Lua) Hyprland config.
--
-- Omarchy's Hyprland config is Lua as of 4.0. Append these lines to your own
-- ~/.config/hypr/bindings.lua (the binding) and ~/.config/hypr/looknfeel.lua
-- (the layer rules), or drop this whole file somewhere and `require` it from
-- ~/.config/hypr/hyprland.lua.
--
-- `o.bind(keys, description, command)` is Omarchy's wrapper — the description
-- is what `omarchy menu keybindings` shows, so give it a real one.

-- ---- Summon (launch-or-focus) ---------------------------------------------
-- The chat HUD is a normal toplevel window (app-id `ghost`), so SUPER+CTRL+G is
-- launch-or-focus: it reveals and focuses the window (pulling it to the front
-- if already open elsewhere) and hides it only when it is already focused.
-- Leave Omarchy's SUPER+G window-grouping shortcut intact.
o.bind("SUPER + CTRL + G", "Summon ghost", "ghost-launch toggle")

-- Summon a named ghost directly.
-- o.bind("SUPER + SHIFT + G", "Summon casper", "qs -c ghost ipc call ghost summon casper")

-- ---- Moving the window ----------------------------------------------------
-- Nothing to bind. The HUD is a real toplevel window, so Hyprland's own binds
-- act on it like any app: SHIFT+SUPER+<n> sends it to a workspace and it
-- tiles/resizes in the normal layout. The old `moveNext` IPC workaround (only
-- needed while the HUD was a layer surface) is gone.

-- ---- Window rules (optional) ----------------------------------------------
-- The HUD tiles by default. To float it at a fixed size instead, target its
-- app-id. Uncomment to taste:
-- hl.window_rule({ match = { class = "^(ghost)$" }, float = true })
-- hl.window_rule({ match = { class = "^(ghost)$" }, size = { 880, 620 } })

-- ---- Layer rules ----------------------------------------------------------
-- Only the opt-in bar strip (GHOST_BAR_SURFACE=1) is still a layer surface; the
-- HUD is a normal window and takes no layer rule. Skip the bar's fade so it
-- appears instantly. `^ghost-` is anchored so it cannot collide with Omarchy's
-- own namespaces (note Omarchy's `omarchy-bar` rule is deliberately unanchored).
hl.layer_rule({ match = { namespace = "^ghost-" }, no_anim = true, animation = "none" })

-- ---- Autostart ------------------------------------------------------------
-- Put this in ~/.config/hypr/autostart.lua instead if you prefer Hyprland to
-- own the lifecycle rather than systemd (contrib/systemd/):
-- o.launch_on_start("qs -c ghost")
