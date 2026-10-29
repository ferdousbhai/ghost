import QtQml

QtObject {
    property var command: []
    property bool running: false
    property var stdout: null
    property var environment: ({})

    signal started()
    signal exited(int exitCode, int exitStatus)

    function simulateStarted(): void {
        running = true;
        started();
    }

    /** exitStatus as QProcess::ExitStatus: 0 normal, 1 crashed. */
    function simulateExited(exitCode, exitStatus): void {
        exited(exitCode === undefined ? 0 : exitCode, exitStatus === undefined ? 0 : exitStatus);
        running = false;
    }

    /** A command that could not start: running falls without started(). */
    function simulateFailedToStart(): void {
        running = false;
    }
}
