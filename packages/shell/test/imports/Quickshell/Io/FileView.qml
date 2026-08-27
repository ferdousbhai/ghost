import QtQml

QtObject {
    property string path: ""
    property bool blockLoading: false
    property bool printErrors: true
    property bool watchChanges: false
    property bool atomicWrites: false
    property string writtenText: ""

    signal loaded()
    signal loadFailed()
    signal fileChanged()
    signal saved()
    signal saveFailed()

    function text(): string { return ""; }
    function reload(): void {}
    function setText(value: string): void { writtenText = value; saved(); }
    function waitForJob(): void {}
}
