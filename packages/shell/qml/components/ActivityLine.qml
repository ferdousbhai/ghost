// SummoningIndicator — state-aware copy and the layered orb recovered from
// summon-ghost. Tool activity wins over thinking; copy rotates every 2.5s.
import QtQuick
import qs.services

Item {
    id: root

    readonly property bool failing: !Ghostd.streaming && Ghostd.lastError !== ""
    readonly property string stateKey: Ghostd.activity !== "" ? Ghostd.activity : "thinking"
    property int phraseIndex: 0
    property int ellipsisStep: 0
    readonly property var phrases: root.phrasesFor(root.stateKey)
    readonly property string phrase: root.phrases && root.phrases.length > 0
        ? root.phrases[root.phraseIndex % root.phrases.length] : ""

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
            ghost_notes_list: [
                "Opening the haunted vault", "Listing the spectral archive",
                "Following phantom folder trails"
            ],
            ghost_notes_read: [
                "Unfolding the ghost note", "Drawing out spectral detail",
                "Reading the haunted archive"
            ],
            ghost_notes_grep: [
                "Searching the haunted vault", "Matching spectral pages",
                "Following phantom ink trails"
            ],
            ghost_notes_write: [
                "Inscribing the haunted archive", "Putting spectral ink to paper",
                "Sealing the ghost note"
            ],
            ghost_memory_list: [
                "Opening the spirit memory", "Sorting the spectral echoes",
                "Following remembered threads"
            ],
            ghost_memory_read: [
                "Recalling a spectral echo", "Reading the haunted memory",
                "Following an old ghost thread"
            ],
            ghost_memory_write: [
                "Saving the spectral echo", "Binding a ghost memory",
                "Keeping the haunted thread"
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
            ghost_character: [
                "Sketching the spirit self", "Inking the ghost’s character",
                "Learning who I am"
            ]
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

    onStateKeyChanged: phraseIndex = root.randomPhrase(-1)

    Timer {
        interval: 2500
        repeat: true
        running: Ghostd.streaming
        onTriggered: root.phraseIndex = root.randomPhrase(root.phraseIndex)
    }

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
