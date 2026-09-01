import QtQml

QtObject {
    property var command: []
    property bool running: false
    property bool stdinEnabled: false
    property var stdout: null
    property var stderr: null
    property var writes: []

    signal started()

    function write(value: string): void {
        writes.push(value);
    }

    function simulateStarted(): void {
        running = true;
        started();
    }

    function simulateExited(): void {
        running = false;
    }
}
