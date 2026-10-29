pragma Singleton

// Speech — the ghost's reply read aloud, when the owner asked aloud.
//
// Optional twice over. Ghost ships no voice: Piper is the owner's install
// (`piper-tts-bin`, whose command is `piper-tts`; upstream's is `piper`), and
// each Piper voice is a model file in ~/.local/share/piper/voices that the
// Character pane downloads on request. And each ghost is silent until the
// owner picks it a voice there. With no Piper, or no voice, a spoken turn is
// just a turn.
//
// A reply streams in; `follow` speaks its opening (Speakable) a sentence at a
// time, so the ghost starts talking while it is still writing. One sentence
// is synthesised while the one before it plays. `stop` silences it at once:
// a dismissal, a new summon, or the owner starting to speak again.
//
// This is the seam a natively spoken model would replace: everything that
// decides *when* the ghost talks calls only `canSpeak`, `follow`, and `stop`.
import Quickshell
import Quickshell.Io
import QtQuick
import "Speakable.js" as Speakable
import "SpeechVoices.js" as Voices

Singleton {
    id: root

    /** How much of a reply's opening is read: about forty seconds of speech. */
    readonly property int limit: 600

    /** The Piper command, or "" while Piper is not installed. */
    property string engine: ""
    /** Installed voices: ids with both their model and its config in `voicesDir`. */
    property var installed: []
    /** The voice each ghost speaks in, by ghost name; a ghost not here is silent. */
    property var choices: ({})
    /** The voice being downloaded, and why the last download failed. */
    property string installing: ""
    property string installError: ""
    /** The voice whose sample is playing. */
    property string previewing: ""

    readonly property string home: Quickshell.env("HOME")
    readonly property string voicesDir: (Quickshell.env("XDG_DATA_HOME") || root.home + "/.local/share") + "/piper/voices"
    readonly property string choicesPath: (Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state") + "/ghost/voices.json"
    readonly property string scratchDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/ghost-speech"

    /** Sentences waiting to be synthesised, and synthesised files waiting to play. */
    property var pending: []
    property var ready: []
    /** Per reply being followed: its key, and how many of its sentences are queued. */
    property string followed: ""
    property int queued: 0
    /** Bumped by `stop`, so a synthesis finishing after it is dropped. */
    property int generation: 0
    property int files: 0

    readonly property bool speaking: root.pending.length > 0 || root.ready.length > 0
        || synth.running || player.running

    Component.onCompleted: root.refresh()

    /** The voice `ghost` speaks in, while it is installed; else "". */
    function voiceFor(ghost: string): string {
        const id = root.choices[ghost] || "";
        return root.installed.indexOf(id) >= 0 ? id : "";
    }

    /** `ghost` has a voice and Piper to speak it. */
    function canSpeak(ghost: string): bool {
        return root.engine !== "" && root.voiceFor(ghost) !== "";
    }

    /** Give `ghost` the installed voice `id`, or "" for silence. */
    function choose(ghost: string, id: string): void {
        const next = Object.assign({}, root.choices);
        if (id === "") delete next[ghost];
        else next[ghost] = id;
        root.choices = next;
        choicesFile.setText(JSON.stringify(next, null, 2) + "\n");
    }

    /** Look again for Piper and the installed voices. */
    function refresh(): void {
        if (!engineProbe.running) engineProbe.running = true;
        if (!voiceList.running) voiceList.running = true;
    }

    /**
     * Speak the opening of a reply as it streams: `key` names the message, so
     * a new one starts its own opening, and `finished` lets the last,
     * unpunctuated sentence go.
     */
    function follow(ghost: string, key: string, markdown: string, finished: bool): void {
        if (!root.canSpeak(ghost)) return;
        if (key !== root.followed) {
            root.followed = key;
            root.queued = 0;
        }
        const split = Speakable.sentences(Speakable.opening(markdown, root.limit));
        const all = finished && split.rest !== "" ? split.done.concat([split.rest]) : split.done;
        if (all.length <= root.queued) return;
        root.pending = root.pending.concat(all.slice(root.queued).map(text => ({ text: text, voice: root.voiceFor(ghost) })));
        root.queued = all.length;
        root.pump();
    }

    /** Silence: drop what is queued and stop what is playing. */
    function stop(): void {
        root.generation += 1;
        root.pending = [];
        for (const file of root.ready) Quickshell.execDetached(["rm", "-f", "--", file]);
        root.ready = [];
        root.followed = "";
        root.queued = 0;
        synth.running = false;
        player.running = false;
        root.previewing = "";
        sampler.running = false;
    }

    /** Play a voice's published sample, or stop the one playing. */
    function preview(id: string): void {
        const playing = root.previewing === id;
        root.stop();
        if (playing) return;
        const url = Voices.sampleUrl(id);
        if (url === "") return;
        root.previewing = id;
        sampler.command = ["mpv", "--no-video", "--really-quiet", url];
        sampler.running = true;
    }

    /** Download a catalogue voice; asked again while it downloads, cancel. */
    function install(id: string, ghost: string): void {
        if (root.installing !== "") {
            if (root.installing === id) downloader.running = false;
            return;
        }
        const url = Voices.modelUrl(id);
        if (url === "") return;
        root.installError = "";
        root.installing = id;
        downloader.ghost = ghost;
        downloader.command = ["sh", "-c",
            'set -e; mkdir -p "$1"; cd "$1"; '
            + 'curl -fsSL -o "$2.onnx.part" "$3.onnx"; curl -fsSL -o "$2.onnx.json.part" "$3.onnx.json"; '
            + 'mv "$2.onnx.json.part" "$2.onnx.json"; mv "$2.onnx.part" "$2.onnx"',
            "ghost-voice", root.voicesDir, id, url];
        downloader.running = true;
    }

    /** Delete an installed voice; a ghost speaking in it falls silent. */
    function remove(id: string): void {
        Quickshell.execDetached(["rm", "-f", "--", root.voicesDir + "/" + id + ".onnx", root.voicesDir + "/" + id + ".onnx.json"]);
        root.installed = root.installed.filter(voice => voice !== id);
        for (const ghost in root.choices)
            if (root.choices[ghost] === id) root.choose(ghost, "");
    }

    function pump(): void {
        if (!synth.running && root.pending.length > 0 && root.ready.length < 2) {
            const next = root.pending[0];
            root.pending = root.pending.slice(1);
            root.files += 1;
            synth.output = root.scratchDir + "/" + root.files + ".wav";
            synth.made = root.generation;
            synth.environment = ({ GHOST_SAY: next.text });
            synth.command = ["sh", "-c", 'mkdir -p "${3%/*}" && printf %s "$GHOST_SAY" | "$1" -m "$2" -f "$3" >/dev/null 2>&1',
                "ghost-say", root.engine, root.voicesDir + "/" + next.voice + ".onnx", synth.output];
            synth.running = true;
        }
        if (!player.running && root.ready.length > 0) {
            player.file = root.ready[0];
            root.ready = root.ready.slice(1);
            player.command = ["pw-play", player.file];
            player.running = true;
        }
    }

    // The owner speaking again is the owner talking over it.
    Connections {
        target: Dictation
        function onStateChanged(): void {
            if (Dictation.recording) root.stop();
        }
    }

    Process {
        id: synth
        objectName: "speechSynth"
        property string output: ""
        property int made: 0
        onExited: exitCode => {
            if (exitCode === 0 && synth.made === root.generation) root.ready = root.ready.concat([synth.output]);
            else Quickshell.execDetached(["rm", "-f", "--", synth.output]);
            Qt.callLater(root.pump);
        }
    }

    Process {
        id: player
        objectName: "speechPlayer"
        property string file: ""
        onExited: {
            Quickshell.execDetached(["rm", "-f", "--", player.file]);
            Qt.callLater(root.pump);
        }
    }

    Process {
        id: sampler
        onExited: root.previewing = ""
    }

    Process {
        id: downloader
        property string ghost: ""
        onExited: exitCode => {
            const id = root.installing;
            root.installing = "";
            if (exitCode !== 0) {
                Quickshell.execDetached(["sh", "-c", 'rm -f "$1/$2".onnx.part "$1/$2".onnx.json.part', "x", root.voicesDir, id]);
                root.installError = "Could not download " + id + "; check the network and try again.";
                return;
            }
            root.installed = root.installed.concat([id]);
            if (downloader.ghost !== "") root.choose(downloader.ghost, id);
        }
    }

    Process {
        id: engineProbe
        command: ["sh", "-c", "command -v piper-tts || command -v piper || true"]
        stdout: StdioCollector {
            onStreamFinished: root.engine = text.trim().split("\n")[0] || ""
        }
    }

    Process {
        id: voiceList
        command: ["sh", "-c", 'cd "$1" 2>/dev/null || exit 0; for f in *.onnx; do [ -f "$f.json" ] && echo "${f%.onnx}"; done; true', "x", root.voicesDir]
        stdout: StdioCollector {
            onStreamFinished: root.installed = text.split("\n").filter(line => line !== "")
        }
    }

    FileView {
        id: choicesFile
        path: root.choicesPath
        blockLoading: true
        printErrors: false
        atomicWrites: true
        onLoaded: {
            try {
                const parsed = JSON.parse(choicesFile.text());
                root.choices = parsed && typeof parsed === "object" ? parsed : ({});
            } catch (error) {
                root.choices = ({});
            }
        }
    }
}
