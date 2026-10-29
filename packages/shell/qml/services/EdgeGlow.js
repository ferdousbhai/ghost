.pragma library

// The screen-edge glow as one ring around the monitor. A point on the edge is
// its distance `s` clockwise around the perimeter from the top-left corner:
// along the top, down the right, back along the bottom, up the left. Colour
// flows around the ring; an ignition starts at one point and lights the ring
// outward both ways until the two fronts meet opposite it, a bright head
// riding each front. PresenceEdge paints its stretch from `at`.

/** Where `u` (pixels from an edge's top or left end) lies on the ring. */
function ringAt(edge, u, width, height) {
    if (edge === "top") return u;
    if (edge === "right") return width + u;
    if (edge === "bottom") return width + height + (width - u);
    return 2 * width + height + (height - u);
}

/** The ring position of a point `at` (0..1, from the top or left end) along `edge`. */
function origin(edge, at, width, height) {
    return ringAt(edge, at * (edge === "top" || edge === "bottom" ? width : height), width, height);
}

/** How far round the ring `s` is from `from`, the shorter way, as 0..1 of half the ring. */
function reach(s, from, perimeter) {
    var d = Math.abs(s - from) % perimeter;
    return Math.min(d, perimeter - d) / (perimeter / 2);
}

function mix(a, b, t) {
    return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 1);
}

/** The palette's colour at `t` (0..1, wrapping), blended between neighbours. */
function paletteAt(palette, t) {
    var scaled = (((t % 1) + 1) % 1) * palette.length;
    var index = Math.floor(scaled);
    return mix(palette[index], palette[(index + 1) % palette.length], scaled - index);
}

/**
 * The glow at ring position `s`: `front` (0..1) is how far round the ignition
 * has reached, 1 being all of it; `flare` (0..1) is the brightness of the
 * fronts' heads, which fades once they meet; `phase` turns the colours.
 * Returns the colour with its alpha.
 */
function glowAt(s, perimeter, from, front, flare, phase, palette) {
    var d = reach(s, from, perimeter);
    // A soft edge on the lit region, so the fronts arrive rather than snap;
    // the ring is whole once the front is past the far point.
    var lit = Math.max(0, Math.min(1, (front * 1.12 - d) / 0.12));
    var head = flare * Math.exp(-Math.pow((front * 1.12 - d) / 0.06, 2));
    var colour = mix(paletteAt(palette, s / perimeter * 2 + phase), Qt.rgba(1, 1, 1, 1), Math.min(1, head) * 0.65);
    return Qt.rgba(colour.r, colour.g, colour.b, Math.max(lit, Math.min(1, head)));
}
