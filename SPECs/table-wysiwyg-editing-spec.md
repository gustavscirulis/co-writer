# WYSIWYG table editing

## Problem

A table rendered as a preview until the caret touched it. Then the whole table turned into codeblock-styled markdown source. Editing a cell meant working inside pipes and dashes, and the layout jumped every time the caret went in or out.

## Decision

From a prototype round of three variants (Inline, Grid, Reveal), we picked **Reveal**. The table stays rendered, and only the cell holding the caret shows its raw markdown, with the syntax marks dimmed. That's the same way prose reveals the line under the caret. The table has no extra chrome, and structure changes are in the right-click menu.

## Behaviour

- Clicking a cell puts the caret where you clicked, mapped from the rendered text to the source. Clicking a link in a cell you aren't editing follows the link, as it does in prose.
- Typing writes straight to the note. A typed `|` is stored as `\|` and Shift+Enter is stored as `<br>`, so each row stays on one line. Pasted text is inserted as plain text on one line.
- ⌘B and ⌘I wrap the selection in `**` or `*`. ⌘Z and ⇧⌘Z undo and redo through the note's history, and the caret goes back to the cell it was in.
- Keys:
  - Tab and Shift+Tab move between cells. Tab in the last cell adds a row.
  - Enter adds a row below.
  - Backspace at the start of an empty body row deletes the row.
  - Escape leaves the table, below it.
  - ↑ and ↓ on a cell's first or last line move to the row above or below, keeping the caret's x position. Past the edge of the table they leave it.
  - ← and → at a cell's edge move to the previous or next cell.
  - ↑ and ↓ from the prose next to a table step into its nearest row. ← and → across the table's edge land in the first or last cell.
  - Leaving a table that sits at the very start or end of the note adds an empty line, so there is somewhere for the caret to go.
- The right-click menu has:
  - Rows: insert above or below, move up or down, delete. The header row can't be moved or deleted, and you can't insert a row above it.
  - Columns: insert left or right, align left, center or right, move left or right, delete. The last remaining column can't be deleted.
- A hint line under the focused table lists the keys.
- The table is read-only when the editor is: in the history preview, and while Co-writer is editing the note.

## Round-trip

`table-model.ts` parses the table into rows and cells and remembers each source line. When a table is written back, only the rows whose cells changed are rewritten, as `| a | b |`. Untouched rows keep their exact spacing, and the delimiter row keeps its dashes until a column operation changes it. Indentation and blockquote `>` markers in front of the rows are kept.

## Known gaps

- Cmd+F can find text inside a table, but the match isn't highlighted, because the table is never shown as source.
- Clicking in a cell with wiki-link aliases, entities, `--` dashes or emoji can put the caret a few characters off, because the rendered text is a different length from the source.
- When a row with more cells than the delimiter row is edited, the extra cells are dropped.
- There is no range selection across cells, and no copying cells out as TSV.
- Editor shortcuts that live in CodeMirror's keymap (⌘L, the formatting commands other than ⌘B and ⌘I) don't run while the caret is in a cell.
