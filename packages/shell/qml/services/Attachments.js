.pragma library

// Attachments — how a message names the images sent with it.
//
// The tailnet viewer stores a photo in the conversation directory and names
// it on its own line as a Markdown image, `![image](attachments/<file>)`, so
// the harness (whose working directory that is) can open it. The HUD only
// reads that format: it draws the line as a picture instead of printing it.

// One path segment under attachments/, so a line never names a file outside
// the conversation directory.
const LINE = /^!\[[^\]]*\]\((attachments\/[^/\s)]+)\)$/u;

/** A message body as `{ text, images }`: the image lines lifted out, the rest kept verbatim. */
function split(body) {
    const kept = [];
    const images = [];
    for (const line of String(body || "").split("\n")) {
        const match = LINE.exec(line.trim());
        if (match) images.push(match[1]);
        else kept.push(line);
    }
    return { text: images.length > 0 ? kept.join("\n").replace(/\s+$/u, "") : String(body || ""), images: images };
}
