import QtQuick
import QtTest
import "../qml/components/MemoryEdit.js" as MemoryEdit

TestCase {
    name: "MemoryEdit"

    function test_emptiedOrUnchangedTextIsNeverWritten(): void {
        verify(!MemoryEdit.shouldWrite("", ""));
        verify(!MemoryEdit.shouldWrite("", "   \n"));
        verify(!MemoryEdit.shouldWrite("Prefers one item.", "Prefers one item."));
        verify(!MemoryEdit.shouldWrite("Prefers one item.", "  Prefers one item.\n"));
        verify(!MemoryEdit.shouldWrite("Prefers one item.", ""));
        verify(MemoryEdit.shouldWrite("", "Prefers one item."));
        verify(MemoryEdit.shouldWrite("Prefers one item.", "Prefers two items."));
    }

    function test_dayLabelDropsTheCurrentYear(): void {
        const now = new Date(2026, 7, 28);
        compare(MemoryEdit.dayLabel("2026-08-21T10:00:00.000Z", now), "Aug 21");
        compare(MemoryEdit.dayLabel("2025-12-03T10:00:00.000Z", now), "Dec 3, 2025");
        compare(MemoryEdit.dayLabel("", now), "");
        compare(MemoryEdit.dayLabel("not a date", now), "");
    }
}
