pragma Singleton
import QtQml

// The production singleton's focused monitor; a test sets it.
QtObject {
    property var focusedMonitor: null
}
