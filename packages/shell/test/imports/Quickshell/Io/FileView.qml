import QtQml

QtObject {
    property string path: ""
    property bool blockLoading: false
    property bool printErrors: true
    property bool watchChanges: false

    signal loaded()
    signal loadFailed()
    signal fileChanged()

    function text(): string { return ""; }
    function reload(): void {}
}
