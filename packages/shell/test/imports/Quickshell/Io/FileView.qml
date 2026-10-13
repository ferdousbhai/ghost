import QtQml

QtObject {
    property string path: ""
    property bool blockLoading: false
    property bool printErrors: true
    property bool watchChanges: false
    property bool atomicWrites: false
    property string writtenText: ""
    property string contents: ""
    property bool failWrites: false

    signal loaded()
    signal loadFailed()
    signal fileChanged()
    signal saved()
    signal saveFailed()

    function text(): string { return contents; }
    function reload(): void {}
    function setText(value: string): void { if (failWrites) { saveFailed(); return; } writtenText = value; saved(); }
    function waitForJob(): void {}
}
