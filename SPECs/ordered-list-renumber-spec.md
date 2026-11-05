# Ordered List Renumber Spec

## Problem

Ordered-list markers render as source text, so their numbers are what the
writer sees. Deleting a row from `1. a / 2. b / 3. c` left `1. a / 3. c`:
only Enter (lang-markdown) and the moved item on Tab / Shift-Tab were ever
renumbered.

## Behavior

`orderedListRenumber` (a transaction filter in
`apps/desktop/src/lib/prosemark-core/list/index.ts`) renumbers the ordered
lists an edit touches so their items run `start, start + 1, …`.

- Runs only for user edits (`input`, `delete`, `move` user events) that add
  or remove a row, plus Tab / Shift-Tab (`input.indent`, `delete.outdent`).
  Undo/redo, agent writes and file reloads are untouched.
- Typing in a marker adds no row, so a number set by hand (`2.` → `5.`) stays.
- Touched lists: every ordered list overlapping the changed range or the row
  after it (so the items an outdented row now holds are renumbered too).
- The start is the list's first number before the edit, so deleting the first
  row of `1. 2. 3.` gives `1. 2.` and a list starting at `4.` keeps `4.`. A
  list Tab just created is not matched to the outer list (nesting depth must
  match); a new list keeps its own first number.
- Lists with two or more items that all share a number (`1. 1. 1.`) are left
  alone as a deliberate style.
- Only the digits change; the `.` / `)` delimiter is kept.
- The renumbering is part of the same transaction, so one undo restores the
  original text and numbers.

## Validation

- `apps/desktop/tests/list-extension.test.ts` ("ordered list renumbering").
- Playground (`?full`): deleting a selected row, deleting the first row, cut
  and paste, Tab and Shift-Tab, undo, and typing a number into a marker.
