pragma Singleton
import QtQml

// The production singleton's focused monitor and raw event stream; a test
// sets the monitor and emits events.
QtObject {
    property var focusedMonitor: null

    signal rawEvent(var event)
}
