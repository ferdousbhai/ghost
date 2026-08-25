import QtQml

// The production type is a non-visual object with a default child collection.
// Reproduce that shape without Item's `enabled`/`palette` properties, which
// would collide with legitimate singleton state and add false test warnings.
QtObject {
    default property list<QtObject> data
}
