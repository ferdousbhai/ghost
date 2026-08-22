// GhostBarSurface — the fallback for the bar widget: a tiny always-visible
// layer strip that carries GhostBarWidget on its own.
//
// Off by default. On Omarchy the right home for a bar indicator is Omarchy's
// own bar (contrib/omarchy/), because two bars stacked on one edge is a worse
// desktop than no indicator at all. This exists for the cases the plugin path
// does not cover: a non-Omarchy Hyprland, a bar that has no module system, or
// somebody who wants the indicator somewhere the bar isn't. Enable with
// GHOST_BAR_SURFACE=1.
//
// It anchors to the *bottom* right by default, out of the way of Omarchy's
// top bar, and takes an exclusive zone so nothing is covered by it.
import Quickshell
import Quickshell.Wayland
import QtQuick
import qs.services

PanelWindow {
    id: surface

    signal activated()

    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "ghost-bar"
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

    anchors.bottom: true
    anchors.right: true
    margins.bottom: 6
    margins.right: 6
    exclusionMode: ExclusionMode.Ignore
    color: Theme.barBackground

    implicitWidth: widget.implicitWidth + 20
    implicitHeight: Theme.barSize

    GhostBarWidget {
        id: widget
        anchors.centerIn: parent
        onActivated: surface.activated()
    }
}
