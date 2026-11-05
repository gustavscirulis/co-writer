# Highlight what Co-writer added

After Co-writer edits a note, the words it added get a faint green tint ("Wash") so the writer can find them. Removed text gets no marker.

## Prototype

Four treatments were built in the playground and compared on the real editor: Wash (tint behind new words), Underline, Margin (gutter bar per changed line) and Ink (green text until you type). Wash was picked.

## Rules

- Only new words are marked, whole words only, as one range per line. Whitespace and every line's block marker (`- `, `- [ ] `, `## `, `1. `, `> `) are left out, including the next item's marker when a new list item diffs as `Item.\n- `. A mark over a list marker knocks its bullet out of line. Runs split by a single kept word are joined so a rewrite reads as one phrase, and runs with no word character (a stray table pipe) aren't marked.
- Tables show the wash on the new words inside each cell. Diagrams, HTML blocks, embeds and standalone images can't be marked word by word, so a block Co-writer added or changed gets the wash behind the whole block.
- Editing inside or at the edge of a highlighted phrase clears that phrase.
- The next Co-writer turn replaces the highlights. Several edits to the same note in one turn add up.
- Only Co-writer edits are highlighted. Restoring a version from history uses the same reload path but passes no turn id.
- Swapping the pane to another note, or an external reload, clears the highlights. Tabs keep their own views, so switching tabs keeps them. Notes Co-writer edits while they aren't open get no highlight.
- When the edit lands the tint is stronger (22%) for 1.2s, then settles to 10% over 700ms. Dark mode uses `#3ccf7a` at 24% / 12%. No transition with reduced motion.
- The green matches version history's insertions, so "new" means one thing across the app and never reads as the accent-tinted selection or a link.

## Implementation

- `lib/text-diff.ts` `insertedWordRanges(before, after)`: a word-level LCS over the region `textDiff` says changed, with a semantic cleanup that stays within one line. Pure insertions slide onto a line boundary. When the region is over 4M token pairs (roughly a 2000-word rewrite) it falls back to `presentableDiff` with a 50ms timeout. `presentableDiff` alone isn't used because its character-level heuristics can splice a new sentence into an unrelated deleted one.
- `components/editor-area/agent-edit-highlight.ts`: `showAgentEdit` effect, the decoration field, and a view plugin that sets `data-agent-fresh` on the editor for the landing pulse. It is included in `agentEditingExtensions`.
- Block widgets: marks can't reach inside a widget that replaces its source. A below-content layer in `agent-edit-highlight.ts` draws one `writer-agent-new-block` rectangle per block widget holding a highlight (geometry shared with the ⌥-hover layer in `block-rect.ts`). The table widget sets `showsAgentEdits`, reads `agentAddedRanges(state, from, to)`, and wraps each cell's new rendered text in `writer-agent-new`; `addedCellText` maps source offsets to rendered text with the same hidden-syntax rules as the raw cell view.
- `markAgentReload` stores the turn id; `use-prosemark-editor.ts` passes it to `agentReloadTransaction`.

## Not yet verified

A real Co-writer turn in the native app. Checked in unit tests and in the playground (`?full`, dispatching `agentReloadTransaction` with a turn id) in light and dark mode. Tables, Mermaid, HTML blocks, embeds and images were checked in light mode only.
