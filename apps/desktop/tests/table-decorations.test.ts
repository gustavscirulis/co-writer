import { describe, expect, test } from "vite-plus/test";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  diffCellMarkdown,
  parseTableCellInlineMarkdown,
  tableDecorations,
} from "../src/components/editor-area/table-decorations";

const before = "before\n";
const table = ["| Name | Count |", "| --- | ---: |", "| Tea | 2 |"].join("\n");
const after = "\n\nafter";
const doc = before + table + after;
const tableFrom = before.length;
const tableTo = tableFrom + table.length;

type TableDecoration = {
  from: number;
  to: number;
  editable: boolean;
  estimatedHeight: number;
};

function makeState(anchor: number, content = doc, extensions: Extension[] = []): EditorState {
  const state = EditorState.create({
    doc: content,
    extensions: [markdown({ extensions: [GFM] }), tableDecorations(), ...extensions],
    selection: EditorSelection.single(anchor),
  });
  ensureSyntaxTree(state, content.length, 1000);
  return state.update({ selection: state.selection }).state;
}

function collectTables(state: EditorState): TableDecoration[] {
  const tables: TableDecoration[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, to, decoration) => {
      const widget = decoration.spec.widget as
        | { writable?: unknown; estimatedHeight?: unknown }
        | undefined;
      if (typeof widget?.writable !== "boolean") return;
      tables.push({
        from,
        to,
        editable: widget.writable,
        estimatedHeight: widget.estimatedHeight as number,
      });
    });
  }
  return tables;
}

function tableEstimate(markdownTable: string): number {
  const [table] = collectTables(makeState(0, `${before}${markdownTable}${after}`));
  if (!table) throw new Error("Expected a table widget");
  return table.estimatedHeight;
}

describe("tableDecorations", () => {
  test("parses inline markdown for folded table preview cells", () => {
    expect(
      parseTableCellInlineMarkdown(
        "**Bold** _em_ `code` [link](https://example.test) ~~gone~~ &amp; &lt; \\|",
      ),
    ).toEqual([
      { type: "element", tag: "strong", children: [{ type: "text", text: "Bold" }] },
      { type: "text", text: " " },
      { type: "element", tag: "em", children: [{ type: "text", text: "em" }] },
      { type: "text", text: " " },
      {
        type: "element",
        tag: "code",
        className: "cm-inline-code",
        children: [{ type: "text", text: "code" }],
      },
      { type: "text", text: " " },
      {
        type: "element",
        tag: "span",
        className: "cm-rendered-link",
        href: "https://example.test",
        children: [{ type: "text", text: "link" }],
      },
      { type: "text", text: " " },
      { type: "element", tag: "s", children: [{ type: "text", text: "gone" }] },
      { type: "text", text: " & < |" },
    ]);
  });

  test("parses Obsidian wiki links with table-escaped aliases in preview cells", () => {
    expect(parseTableCellInlineMarkdown("[[Format your notes\\|Formatting]]")).toEqual([
      {
        type: "element",
        tag: "span",
        className: "cm-wiki-link",
        wikiTarget: "Format your notes\\|Formatting",
        children: [{ type: "text", text: "Formatting" }],
      },
    ]);
  });

  test("parses table-cell wiki links inside other inline markdown", () => {
    expect(parseTableCellInlineMarkdown("**[[Roadmap]]**")).toEqual([
      {
        type: "element",
        tag: "strong",
        children: [
          {
            type: "element",
            tag: "span",
            className: "cm-wiki-link",
            wikiTarget: "Roadmap",
            children: [{ type: "text", text: "Roadmap" }],
          },
        ],
      },
    ]);
  });

  test("keeps inline html in table cells as text", () => {
    expect(parseTableCellInlineMarkdown("<img src=x onerror=alert(1)> **safe**")).toEqual([
      { type: "text", text: "<img src=x onerror=alert(1)> " },
      { type: "element", tag: "strong", children: [{ type: "text", text: "safe" }] },
    ]);
  });

  test("renders the table as an editable widget wherever the caret is", () => {
    for (const anchor of [0, tableFrom + 2, tableTo]) {
      expect(collectTables(makeState(anchor))).toEqual([
        expect.objectContaining({ from: tableFrom, to: tableTo, editable: true }),
      ]);
    }
  });

  test("covers a list-indented table from its line start", () => {
    const indented = "- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n";
    const [table] = collectTables(makeState(0, indented));
    expect(indented.slice(table.from, table.to)).toBe("  | a | b |\n  | - | - |\n  | 1 | 2 |");
  });

  test("is read-only when the editor is", () => {
    expect(collectTables(makeState(0, doc, [EditorState.readOnly.of(true)]))).toEqual([
      expect.objectContaining({ editable: false }),
    ]);
    expect(collectTables(makeState(0, doc, [EditorView.editable.of(false)]))).toEqual([
      expect.objectContaining({ editable: false }),
    ]);
  });

  test("estimates the widget height for the virtualized heightmap", () => {
    expect(tableEstimate(table)).toBeGreaterThan(70);
  });

  test("grows the height estimate with body rows", () => {
    const longTable = [
      "| Name | Count |",
      "| --- | ---: |",
      ...Array.from({ length: 12 }, (_, index) => `| Row ${index + 1} | ${index + 1} |`),
    ].join("\n");

    expect(tableEstimate(longTable)).toBeGreaterThan(tableEstimate(table));
  });
});

describe("diffCellMarkdown", () => {
  const changed = (text: string) => ({
    type: "element",
    tag: "span",
    className: "cm-changedText",
    children: [{ type: "text", text }],
  });
  const removed = (text: string) => ({
    type: "element",
    tag: "del",
    className: "cm-deletedText",
    children: [{ type: "text", text }],
  });

  test("highlights only the words that changed and keeps removed words in place", () => {
    expect(diffCellMarkdown("Land early", "Land late")).toEqual([
      { type: "text", text: "Land " },
      removed("early"),
      changed("late"),
    ]);
  });

  test("diffs the rendered text, so markdown syntax isn't split", () => {
    expect(diffCellMarkdown("Land **early**", "Land **early**, then Alfama")).toEqual([
      { type: "text", text: "Land " },
      { type: "element", tag: "strong", children: [{ type: "text", text: "early" }] },
      changed(", then Alfama"),
    ]);
  });

  test("highlights the whole cell when only formatting changed", () => {
    expect(diffCellMarkdown("early", "**early**")).toEqual([
      {
        type: "element",
        tag: "span",
        className: "cm-changedText",
        children: [{ type: "element", tag: "strong", children: [{ type: "text", text: "early" }] }],
      },
    ]);
  });

  test("shows a cleared cell as struck-through text", () => {
    expect(diffCellMarkdown("gone", "")).toEqual([removed("gone")]);
  });
});
