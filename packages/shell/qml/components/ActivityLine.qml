// SummoningIndicator — state-aware copy and the layered orb recovered from
// summon-ghost. Tool activity wins over thinking; copy rotates every 3s.
//
// This is also where the ghost's own narration lands. When a turn opens with
// "Checking your Dropbox for the invoice" before reaching for a tool, that line
// is status rather than reply (TurnBlocks.js makes the call) and it belongs
// here, beside the orb, for exactly as long as it is true. Real words outrank
// the spectral phrases, which stay for the silences: thinking, a tool call the
// ghost did not announce, the gap between blocks.
import QtQuick
import qs.services

Item {
    id: root

    readonly property bool failing: !Ghostd.streaming && Ghostd.lastError !== ""
    readonly property string stateKey: Ghostd.activity !== "" ? Ghostd.activity : "thinking"
    /**
     * The state the copy is currently drawn from, which trails `stateKey` by up
     * to one beat. Ghostd's `activity` clears to "" between every tool
     * lifecycle event — call start, call end, execution start, execution end —
     * so a single tool call alone flips `stateKey` four times, and adopting
     * each flip on sight is what made the phrases flicker past far faster than
     * the 3s they were written for. The beat below is the only thing allowed
     * to change what this line says.
     */
    property string heldKey: "thinking"
    property int phraseIndex: 0
    property int ellipsisStep: 0
    readonly property var phrases: root.phrasesFor(root.heldKey)
    readonly property string narration: Ghostd.statusText
    readonly property string phrase: root.narration !== "" ? root.narration
        : (root.phrases && root.phrases.length > 0
            ? root.phrases[root.phraseIndex % root.phrases.length] : "")

    function adopt(fresh: bool): void {
        root.heldKey = root.stateKey;
        root.phraseIndex = root.randomPhrase(fresh ? -1 : root.phraseIndex);
    }

    // The web original whispered its phrases in slate-300 at 80%. Light mode has
    // no such near-white to dim, so the neutral dim token carries the same role.
    readonly property color phraseColor: Theme.light
        ? Theme.foregroundDim : Qt.rgba(0.796, 0.835, 0.882, 0.8)

    implicitHeight: visible ? 30 : 0
    visible: Ghostd.streaming || root.failing
    clip: false

    function randomPhrase(current: int): int {
        if (!root.phrases || root.phrases.length <= 1) return 0;
        let next = Math.floor(Math.random() * root.phrases.length);
        if (next === current) next = (next + 1) % root.phrases.length;
        return next;
    }

    function phrasesFor(state: string): var {
        const copy = {
            thinking: [
                "Weighing the haunted question", "Threading the ghost thought",
                "Reading the shadow veil", "Clearing the spectral fog",
                "Tracing the phantom logic", "Polishing the spirit reply"
            ],
            ask: [
                "Asking the ghost keeper", "Passing the haunted question",
                "Opening the séance door", "Waiting for the phantom voice"
            ],
            ghost_browser: [
                "Scrying the live web", "Following fresh omens",
                "Peering past the veil", "Gathering spectral whispers"
            ],
            ghost_memory_list: [
                "Opening the spirit memory", "Sorting the spectral echoes",
                "Following remembered threads"
            ],
            ghost_memory_read: [
                "Recalling a spectral echo", "Reading the haunted memory",
                "Following an old ghost thread"
            ],
            inspect_image: [
                "Peering through the spectral lens", "Reading the haunted image",
                "Tracing shapes beyond the veil"
            ],
            // Ghost's own pre-OMP name for the same work; kept so historical
            // transcripts still replay with flavour.
            look_at_image: [
                "Peering through the spectral lens", "Reading the haunted image",
                "Tracing shapes beyond the veil"
            ],
        };
        if (state.startsWith("switching model") || state.startsWith("using fallback")) {
            return [
                "Crossing to a steadier spirit",
                "Calling the next spectral voice",
                "Reweaving the model thread"
            ];
        }
        return copy[state] || [
            "Summoning the ghost spark", "Gathering the spectral thread",
            "Coaxing the haunted mist", "Finding the veil glow",
            "Shaping the spirit reply", "Crossing the phantom veil"
        ];
    }

    // A turn opens on a phrase of its own rather than finishing the last one,
    // and the ghost's own words giving way to invented ones is a real change of
    // state, not a beat.
    onNarrationChanged: if (root.narration === "" && Ghostd.streaming) root.adopt(false)

    Connections {
        target: Ghostd
        function onStreamingChanged(): void {
            if (Ghostd.streaming) root.adopt(true);
        }
    }

    // Real words hold the line until they stop being true; only invented ones
    // need rotating to stay alive. Stopping the beat also restarts its interval,
    // so the phrase that follows a narration gets its full 3s.
    Timer {
        interval: 3000
        repeat: true
        running: Ghostd.streaming && root.narration === ""
        onTriggered: root.adopt(false)
    }

    // The dots keep their own faster clock: the phrase says what is happening,
    // these say it is still happening. TurnBlocks strips a narration's trailing
    // stop so the ghost's own sentence does not end up with four of them.
    Timer {
        interval: 430
        repeat: true
        running: Ghostd.streaming && !Theme.reducedMotion
        onTriggered: root.ellipsisStep = (root.ellipsisStep + 1) % 4
    }

    Row {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.gap

        Item {
            width: 22
            height: 22
            clip: false

            SpectralOrb {
                visible: Ghostd.streaming
                anchors.centerIn: parent
                diameter: 20
                running: Ghostd.streaming
            }

            Rectangle {
                visible: root.failing
                anchors.centerIn: parent
                width: 6
                height: 6
                radius: 3
                color: Theme.ghostRose
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(parent.width - 22 - Theme.gap, 0)
            text: root.failing
                ? Ghostd.lastError
                : root.phrase + (Theme.reducedMotion ? "…" : ".".repeat(root.ellipsisStep))
            color: root.failing ? Theme.ghostRose : root.phraseColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: Font.Light
            font.letterSpacing: 0.5
            elide: Text.ElideRight
        }
    }
}
