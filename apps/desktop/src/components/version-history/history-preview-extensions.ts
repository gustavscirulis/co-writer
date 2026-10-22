import { EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Chunk, getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { language } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { prosemarkBasicSetup, prosemarkBaseThemeSetup } from "@/lib/prosemark-core/main";
import { headingWeightHighlight, writerMarkdown } from "@/components/editor-area/editor-extensions";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import { imageSrcResolver } from "@/components/editor-area/image-src-resolver";
import { mathDecorations } from "@/components/editor-area/math-decorations";
import { tableBaseline, tableDecorations } from "@/components/editor-area/table-decorations";
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

const originalTrees = new WeakMap<Text, Tree>();

// Merge decorations can't reach inside a table's block widget, so the table
// diffs itself against the table at the same place in the previous version.
function previousTableSource(state: EditorState, from: number, to: number): string | null {
  const chunks = getChunks(state)?.chunks ?? [];
  if (!chunks.some((chunk) => chunk.fromB <= to && chunk.toB >= from)) return null;
  const original = getOriginalDoc(state);
  let tree = originalTrees.get(original);
  if (!tree) {
    const parser = state.facet(language)?.parser;
    if (!parser) return null;
    tree = parser.parse(original.toString());
    originalTrees.set(original, tree);
  }
  const fromA = Math.min(toOriginal(chunks, from, "start"), original.length);
  const toA = Math.min(toOriginal(chunks, to, "end"), original.length);
  let source = "";
  tree.iterate({
    from: fromA,
    to: toA,
    enter(node) {
      if (source) return false;
      if (node.name !== "Table") return;
      source = original.sliceString(original.lineAt(node.from).from, node.to);
      return false;
    },
  });
  return source === state.sliceDoc(from, to) ? null : source;
}

// The live editor's rendering without anything that writes back to the note
// (store sync, feedback anchors, Mermaid's editable canvas, undo history).
function previewExtensions(original: string, getFilePath: () => string): Extension[] {
  return [
    writerMarkdown(),
    prosemarkBasicSetup(),
    prosemarkBaseThemeSetup(),
    headingWeightHighlight,
    viewportParsePlugin,
    tableDecorations(),
    tableBaseline.of(previousTableSource),
    mathDecorations(),
    headingDecorations,
    imageSrcResolver(getFilePath),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
    unifiedMergeView({
      original: withTrailingNewline(original),
      mergeControls: false,
      allowInlineDiffs: true,
      gutter: false,
    }),
    EditorView.editorAttributes.of({ class: "writer-history-preview" }),
  ];
}

export function historyPreviewState(
  body: string,
  original: string,
  getFilePath: () => string,
): EditorState {
  const doc = withTrailingNewline(body);
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: previewExtensions(original, getFilePath),
  });
}

/** Document position of the first change, or null when nothing changed. */
export function firstChangePosition(state: EditorState): number | null {
  return getChunks(state)?.chunks[0]?.fromB ?? null;
}
