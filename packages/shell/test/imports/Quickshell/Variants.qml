import QtQml

// Production instantiates `delegate` per model entry; tests have no screens.
QtObject {
    property var model: []
    default property Component delegate
}
