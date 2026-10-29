.pragma library

// The Piper voices the Character pane offers: a few English ones, women and
// men, American and British, each heard from Piper's published sample before
// anything is downloaded. Any other Piper voice the owner puts in the voices
// directory is offered too, under its file name.

var BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/";
var SAMPLES = "https://rhasspy.github.io/piper-samples/samples/en/";

var CATALOGUE = [
    { id: "en_US-lessac-medium", name: "Lessac", accent: "American", voice: "woman" },
    { id: "en_US-amy-medium", name: "Amy", accent: "American", voice: "woman" },
    { id: "en_US-ryan-medium", name: "Ryan", accent: "American", voice: "man" },
    { id: "en_US-norman-medium", name: "Norman", accent: "American", voice: "man" },
    { id: "en_GB-jenny_dioco-medium", name: "Jenny", accent: "British", voice: "woman" },
    { id: "en_GB-alan-medium", name: "Alan", accent: "British", voice: "man" }
];

/** `en_US-lessac-medium` as its locale, speaker, and quality. */
function parts(id) {
    var match = /^([a-z]{2}_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/.exec(String(id));
    return match ? { locale: match[1], speaker: match[2], quality: match[3] } : null;
}

/** Where a catalogue voice's model downloads from, without the `.onnx` / `.onnx.json` suffix. */
function modelUrl(id) {
    var p = parts(id);
    return p ? BASE + p.locale + "/" + p.speaker + "/" + p.quality + "/" + id : "";
}

/** Piper's published sample of a voice, played before it is installed. */
function sampleUrl(id) {
    var p = parts(id);
    return p ? SAMPLES + p.locale + "/" + p.speaker + "/" + p.quality + "/speaker_0.mp3" : "";
}

/**
 * The voices to offer: the catalogue, then any other installed voice, each
 * with whether it is installed.
 */
function offered(installed) {
    var list = [];
    var known = {};
    for (var i = 0; i < CATALOGUE.length; i++) {
        var voice = CATALOGUE[i];
        known[voice.id] = true;
        list.push({ id: voice.id, name: voice.name, detail: voice.accent + ", " + voice.voice,
            installed: installed.indexOf(voice.id) >= 0, sample: true });
    }
    for (var j = 0; j < installed.length; j++) {
        if (known[installed[j]]) continue;
        list.push({ id: installed[j], name: installed[j], detail: "installed", installed: true, sample: false });
    }
    return list;
}
