import { ChangeSet, EditorState, Facet, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Chunk, getChunks, unifiedMergeView } from "@codemirror/merge";
import type { Parser } from "@lezer/common";
import { prosemarkBasicSetup, prosemarkBaseThemeSetup } from "@/lib/prosemark-core/main";
import { headingWeightHighlight, writerMarkdown } from "@/components/editor-area/editor-extensions";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import { imageSrcResolver } from "@/components/editor-area/image-src-resolver";
import { mathDecorations } from "@/components/editor-area/math-decorations";
import {
  tableBaseline,
  tableDecorations,
  tableRanges,
} from "@/components/editor-area/table-decorations";
import { viewportParsePlugin } from "@/components/editor-area/viewport-parse";

// A trailing empty line gives the parked selection somewhere to sit that
// touches no markdown node, so live-preview hiding renders the whole note.
function withTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** `pos` in the shown version, mapped into the previous one; inside a chunk it snaps to the chunk's edge. */
function toOriginal(chunks: readonly Chunk[], pos: number, edge: "start" | "end"): number {
  let delta = 0;
  for (const chunk of chunks) {
    if (pos < chunk.fromB) break;
    if (pos < chunk.toB || pos === chunk.fromB) return edge === "start" ? chunk.fromA : chunk.toA;
    delta = chunk.toA - chunk.toB;
  }
  return pos + delta;
}

/** Previous source of each changed table, keyed by where the table starts in the shown version. */
const tableBaselines = Facet.define<ReadonlyMap<number, string>, ReadonlyMap<number, string>>({
  combine: (values) => values[0] ?? new Map(),
});

/**
 * Pairs each changed table with the table at the same place in the previous
 * version. Tables render their own diff, so the merge view gets an original
 * with each paired table already swapped for its new source: otherwise a chunk
 * starting at a table would also show the old table as raw markdown.
 */
function pairTables(doc: Text, original: Text, parser: Parser) {
  const chunks = Chunk.build(original, doc);
  const oldTables = tableRanges(original, parser.parse(original.toString()));
  const baselines = new Map<number, string>();
  const swaps: { from: number; to: number; insert: string }[] = [];
  const used = new Set<number>();
  for (const table of tableRanges(doc, parser.parse(doc.toString()))) {
    if (!chunks.some((chunk) => chunk.fromB <= table.to && chunk.toB >= table.from)) continue;
    const fromA = Math.min(toOriginal(chunks, table.from, "start"), original.length);
    const toA = Math.min(toOriginal(chunks, table.to, "end"), original.length);
    const old = oldTables.find((t) => t.from <= toA && t.to >= fromA && !used.has(t.from));
    if (!old) {
      baselines.set(table.from, "");
      continue;
    }
    used.add(old.from);
    const source = doc.sliceString(table.from, table.to);
    const before = original.sliceString(old.from, old.to);
    if (before === source) continue;
    baselines.set(table.from, before);
    swaps.push({ from: old.from, to: old.to, insert: source });
  }
  swaps.sort((a, b) => a.from - b.from);
  return { baselines, mergeOriginal: ChangeSet.of(swaps, original.length).apply(original) };
}

// The live editor's rendering without anything that writes back to the note
// (store sync, feedback anchors, Mermaid's editable canvas, undo history).
export function historyPreviewState(
  body: string,
  original: string,
  getFilePath: () => string,
): EditorState {
  const doc = Text.of(withTrailingNewline(body).split("\n"));
  const markdown = writerMarkdown();
  const { baselines, mergeOriginal } = pairTables(
    doc,
    Text.of(withTrailingNewline(original).split("\n")),
    markdown.language.parser,
  );
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      markdown,
      prosemarkBasicSetup(),
      prosemarkBaseThemeSetup(),
      headingWeightHighlight,
      viewportParsePlugin,
      tableDecorations(),
      tableBaselines.of(baselines),
      tableBaseline.of((state, from) => state.facet(tableBaselines).get(from) ?? null),
      mathDecorations(),
      headingDecorations,
      imageSrcResolver(getFilePath),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
      unifiedMergeView({
        original: mergeOriginal,
        mergeControls: false,
        allowInlineDiffs: true,
        gutter: false,
      }),
      EditorView.editorAttributes.of({ class: "writer-history-preview" }),
    ],
  });
}

/** Document position of the first change, or null when nothing changed. */
export function firstChangePosition(state: EditorState): number | null {
  const first = Math.min(
    getChunks(state)?.chunks[0]?.fromB ?? Infinity,
    ...state.facet(tableBaselines).keys(),
  );
  return first === Infinity ? null : first;
}
