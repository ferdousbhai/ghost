pragma Singleton
import QtQml

// The production singleton's focused monitor, its dispatcher and raw event
// stream; a test sets the monitor, reads what was dispatched, and emits events.
QtObject {
    property var focusedMonitor: null
    property var dispatched: []

    signal rawEvent(var event)

    function dispatch(request: string): void {
        dispatched = dispatched.concat([request]);
    }
}
