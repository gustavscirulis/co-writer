import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  Annotation,
  type EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { presentableDiff } from "@codemirror/merge";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  GFM,
  parser as markdownParser,
  type InlineContext,
  type MarkdownConfig,
} from "@lezer/markdown";
import * as emoji from "node-emoji";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/main";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { textDiff } from "@/lib/text-diff";
import { parseWikiLink } from "@/lib/wiki-links";
import {
  buildTableCellMenuItemsSpec,
  showNativeContextMenu,
  type TableCellMenuActionId,
} from "./editor-context-menu";
import {
  cellAtOffset,
  type CellPos,
  deleteColumn,
  deleteRow,
  diffTables,
  escapeCellText,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseMarkdownTable,
  serializeTable,
  setAlign,
  setCell,
  tableAligns,
  type TableCellRanges,
  type TableModel,
  type TableDiff,
  tableWidth,
} from "./table-model";

const tableCellLineHeight = 1.4;
const tableCellVerticalPaddingEm = 1;
const tableWidgetVerticalPaddingEm = 0.5;
const tableBorderWidthPx = 1;
// Ceiling on how much width a single column may demand, at roughly half the
// editor measure. The auto table layout hands out width in proportion to each
// column's max-content, so without a ceiling one long-prose column takes
// nearly everything and its neighbours collapse toward their minimum. Capping
// the demand lets the other columns keep their natural width instead.
const tableCellMaxWidthCh = 48;

function numericSettingDefault(key: string, fallback: number): number {
  const def = SETTINGS_SCHEMA.find((entry) => entry.key === key);
  return typeof def?.default === "number" ? def.default : fallback;
}

const defaultEditorFontSizePx = numericSettingDefault("editor.font-size", 16);

export type TableCellInlineNode =
  | { type: "text"; text: string }
  | { type: "break" }
  | {
      type: "element";
      tag: "strong" | "em" | "code" | "s" | "span" | "ins" | "del";
      className?: string;
      href?: string;
      wikiTarget?: string;
      children: TableCellInlineNode[];
    };

const tableCellWikiLinkMarkdownSyntaxExtension: MarkdownConfig = {
  defineNodes: ["WikiLink", "WikiLinkMark"],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse: (cx: InlineContext, next: number, pos: number): number => {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91 /* [ */) return -1;

        for (let end = pos + 2; end < cx.end - 1; end++) {
          if (cx.char(end) === 92 /* \ */) {
            end++;
            continue;
          }
          if (cx.char(end) !== 93 /* ] */ || cx.char(end + 1) !== 93 /* ] */) continue;

          return cx.addElement(
            cx.elt("WikiLink", pos, end + 2, [
              cx.elt("WikiLinkMark", pos, pos + 2),
              cx.elt("WikiLinkMark", end, end + 2),
            ]),
          );
        }

        return -1;
      },
    },
  ],
};

const tableCellMarkdownParser = markdownParser.configure([
  GFM,
  prosemarkMarkdownSyntaxExtensions,
  tableCellWikiLinkMarkdownSyntaxExtension,
]);
const defaultHiddenMarkdownMarks = new Set([
  "CodeMark",
  "EmphasisMark",
  "EscapeMark",
  "LinkMark",
  "StrikethroughMark",
]);
const linkHiddenMarkdownNodes = new Set([
  ...defaultHiddenMarkdownMarks,
  "LinkLabel",
  "LinkTitle",
  "URL",
]);

function estimateTableWidgetHeight(rows: number): number {
  const rowHeight = defaultEditorFontSizePx * (tableCellLineHeight + tableCellVerticalPaddingEm);
  const wrapperPadding = defaultEditorFontSizePx * tableWidgetVerticalPaddingEm;
  const horizontalBorders = Math.max(0, rows + 1) * tableBorderWidthPx;

  return Math.ceil(wrapperPadding + rows * rowHeight + horizontalBorders);
}

function pushText(nodes: TableCellInlineNode[], text: string) {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  nodes.push({ type: "text", text });
}

function pushNodes(nodes: TableCellInlineNode[], next: TableCellInlineNode[]) {
  for (const node of next) {
    if (node.type === "text") {
      pushText(nodes, node.text);
    } else {
      nodes.push(node);
    }
  }
}

function decodeMarkdownEntity(entity: string): string {
  const fromCodePoint = (codePoint: number): string =>
    Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;

  if (entity.startsWith("&#x") || entity.startsWith("&#X")) {
    return fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
  }
  if (entity.startsWith("&#")) {
    return fromCodePoint(Number.parseInt(entity.slice(2, -1), 10));
  }

  switch (entity) {
    case "&amp;":
      return "&";
    case "&apos;":
      return "'";
    case "&gt;":
      return ">";
    case "&lt;":
      return "<";
    case "&nbsp;":
      return "\u00a0";
    case "&quot;":
      return '"';
    default:
      return entity;
  }
}

function renderMarkdownChildren(
  markdown: string,
  node: SyntaxNode,
  hiddenNames = defaultHiddenMarkdownMarks,
): TableCellInlineNode[] {
  const nodes: TableCellInlineNode[] = [];
  let pos = node.from;

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) {
      pushText(nodes, markdown.slice(pos, child.from));
    }
    if (!hiddenNames.has(child.name)) {
      pushNodes(nodes, renderMarkdownNode(markdown, child));
    }
    pos = child.to;
  }

  if (node.to > pos) {
    pushText(nodes, markdown.slice(pos, node.to));
  }

  return nodes;
}

function markdownElement(
  tag: Extract<TableCellInlineNode, { type: "element" }>["tag"],
  children: TableCellInlineNode[],
  options: { className?: string; href?: string; wikiTarget?: string } = {},
): TableCellInlineNode[] {
  return [{ type: "element", tag, children, ...options }];
}

function linkHref(markdown: string, node: SyntaxNode): string | undefined {
  const url = node.getChild("URL");
  if (!url) return undefined;
  return markdown.slice(url.from, url.to).trim();
}

function renderLink(markdown: string, node: SyntaxNode): TableCellInlineNode[] {
  const children = renderMarkdownChildren(markdown, node, linkHiddenMarkdownNodes);
  const href = linkHref(markdown, node);
  if (children.length === 0 && href) {
    pushText(children, href);
  }
  return markdownElement("span", children, { className: "cm-rendered-link", href });
}

function renderMarkdownNode(markdown: string, node: SyntaxNode): TableCellInlineNode[] {
  switch (node.name) {
    case "Document":
    case "Paragraph":
      return renderMarkdownChildren(markdown, node);
    case "StrongEmphasis":
      return markdownElement("strong", renderMarkdownChildren(markdown, node));
    case "Emphasis":
      return markdownElement("em", renderMarkdownChildren(markdown, node));
    case "Strikethrough":
      return markdownElement("s", renderMarkdownChildren(markdown, node));
    case "InlineCode":
      return markdownElement("code", renderMarkdownChildren(markdown, node), {
        className: "cm-inline-code",
      });
    case "Link":
    case "Autolink":
      return renderLink(markdown, node);
    case "WikiLink": {
      const rawTarget = markdown.slice(node.from + 2, node.to - 2);
      return markdownElement(
        "span",
        [{ type: "text", text: parseWikiLink(rawTarget).displayText }],
        {
          className: "cm-wiki-link",
          wikiTarget: rawTarget,
        },
      );
    }
    case "URL":
      return markdownElement("span", [{ type: "text", text: markdown.slice(node.from, node.to) }], {
        className: "cm-rendered-link",
        href: markdown.slice(node.from, node.to),
      });
    case "Image": {
      const alt = renderMarkdownChildren(markdown, node, linkHiddenMarkdownNodes);
      return alt.length > 0 ? alt : [{ type: "text", text: markdown.slice(node.from, node.to) }];
    }
    case "Escape":
      return [{ type: "text", text: markdown.slice(node.from + 1, node.to) }];
    case "Entity":
      return [{ type: "text", text: decodeMarkdownEntity(markdown.slice(node.from, node.to)) }];
    case "HardBreak":
      return [{ type: "break" }];
    case "Dash": {
      const dashCount = node.to - node.from;
      if (dashCount === 2) return [{ type: "text", text: "\u2013" }];
      if (dashCount === 3) return [{ type: "text", text: "\u2014" }];
      return [{ type: "text", text: markdown.slice(node.from, node.to) }];
    }
    case "Emoji": {
      const emojiName = markdown.slice(node.from + 1, node.to - 1);
      return [{ type: "text", text: emoji.get(emojiName) || markdown.slice(node.from, node.to) }];
    }
    default:
      if (node.firstChild) return renderMarkdownChildren(markdown, node);
      return [{ type: "text", text: markdown.slice(node.from, node.to) }];
  }
}

export function parseTableCellInlineMarkdown(markdown: string): TableCellInlineNode[] {
  return renderMarkdownNode(markdown, tableCellMarkdownParser.parse(markdown).topNode);
}

function appendInlineMarkdownNodes(parent: HTMLElement, nodes: TableCellInlineNode[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.appendChild(document.createTextNode(node.text));
      continue;
    }
    if (node.type === "break") {
      parent.appendChild(document.createElement("br"));
      continue;
    }

    const child = document.createElement(node.tag);
    if (node.className) child.className = node.className;
    if (node.href) child.dataset.href = node.href;
    if (node.wikiTarget) child.dataset.wikiTarget = node.wikiTarget;
    appendInlineMarkdownNodes(child, node.children);
    parent.appendChild(child);
  }
}

function setCellMarkdownContent(cell: HTMLElement, markdown: string) {
  cell.replaceChildren();
  appendInlineMarkdownNodes(cell, parseTableCellInlineMarkdown(markdown));
}

// -- Diff --
//
// The history preview's diff can't reach inside the widget, so a table given a
// baseline renders its own, with the merge view's classes.

const plainText = (nodes: TableCellInlineNode[]): string =>
  nodes
    .map((node) =>
      node.type === "text" ? node.text : node.type === "break" ? "\n" : plainText(node.children),
    )
    .join("");

/**
 * The cell as `after` renders, with the text that changed since `before`
 * highlighted and removed text struck through in place. Compares rendered text,
 * so markdown syntax is never split; a formatting-only edit highlights the cell.
 */
export function diffCellMarkdown(before: string, after: string): TableCellInlineNode[] {
  const nodes = parseTableCellInlineMarkdown(after);
  const textA = plainText(parseTableCellInlineMarkdown(before));
  const textB = plainText(nodes);
  if (textA === textB) return markdownElement("span", nodes, { className: "cm-changedText" });

  const changes = presentableDiff(textA, textB);
  const removedAt = (at: number, out: TableCellInlineNode[]) => {
    for (const change of changes) {
      if (change.fromB !== at || change.toA === change.fromA) continue;
      const text = textA.slice(change.fromA, change.toA);
      out.push(
        ...markdownElement("del", [{ type: "text", text }], { className: "cm-deletedText" }),
      );
    }
  };
  let pos = 0;
  const walk = (list: TableCellInlineNode[]): TableCellInlineNode[] => {
    const out: TableCellInlineNode[] = [];
    for (const node of list) {
      if (node.type === "element") {
        out.push({ ...node, children: walk(node.children) });
        continue;
      }
      if (node.type === "break") {
        removedAt(pos, out);
        out.push(node);
        pos++;
        continue;
      }
      const start = pos;
      const end = start + node.text.length;
      while (pos < end) {
        removedAt(pos, out);
        const inserted = changes.find((change) => change.fromB <= pos && change.toB > pos);
        const stop = inserted
          ? Math.min(inserted.toB, end)
          : Math.min(end, ...changes.filter((change) => change.fromB > pos).map((c) => c.fromB));
        const piece: TableCellInlineNode = {
          type: "text",
          text: node.text.slice(pos - start, stop - start),
        };
        out.push(
          ...(inserted
            ? markdownElement("span", [piece], { className: "cm-changedText" })
            : [piece]),
        );
        pos = stop;
      }
    }
    return out;
  };
  const out = walk(nodes);
  removedAt(pos, out);
  return out;
}

function cellDiffNodes(before: string | undefined, after: string | undefined) {
  if (after === undefined) {
    return before
      ? markdownElement("del", parseTableCellInlineMarkdown(before), {
          className: "cm-deletedText",
        })
      : [];
  }
  if (before === undefined) {
    return after
      ? markdownElement("ins", parseTableCellInlineMarkdown(after), {
          className: "cm-insertedLine",
        })
      : [];
  }
  return before === after ? parseTableCellInlineMarkdown(after) : diffCellMarkdown(before, after);
}

/** Paints `diff` into the table sections; returns the cells of the shown version's rows. */
function paintTableDiff(
  thead: HTMLElement,
  tbody: HTMLElement,
  model: TableModel,
  { columns, rows }: TableDiff,
): HTMLElement[][] {
  const aligns = tableAligns(model);
  const cells: HTMLElement[][] = [];
  for (const row of rows) {
    const shown = row.kind === "deleted" ? undefined : row.r;
    const header = shown === 0;
    const tr = (header ? thead : tbody).appendChild(document.createElement("tr"));
    if (row.kind !== "same") tr.className = `cm-table-row-${row.kind}`;
    const after = shown === undefined ? undefined : model.rows[shown].cells;
    const before =
      row.kind === "deleted" ? row.cells : row.kind === "inserted" ? undefined : row.before;
    const rowCells: HTMLElement[] = [];
    for (const col of columns) {
      const cell = tr.appendChild(document.createElement(header ? "th" : "td"));
      if (col.after !== undefined) {
        const align = aligns[col.after];
        if (align) cell.style.textAlign = align;
        if (shown !== undefined) {
          cell.dataset.row = String(shown);
          cell.dataset.column = String(col.after);
          rowCells[col.after] = cell;
        }
      }
      appendInlineMarkdownNodes(
        cell,
        cellDiffNodes(
          col.before === undefined ? undefined : before?.[col.before],
          col.after === undefined ? undefined : after?.[col.after],
        ),
      );
    }
    if (shown !== undefined) cells[shown] = rowCells;
  }
  return cells;
}

// -- Editing --
//
// Every cell renders its markdown, and only the cell holding the caret shows
// the raw source, with its syntax marks dimmed, the way prose reveals the line
// under the caret. Typing writes straight back to the document.

const rawMarkNodes = new Set([...defaultHiddenMarkdownMarks, "WikiLinkMark", "HTMLTag"]);
const rawStyledNodes: Record<string, { tag: string; className?: string }> = {
  StrongEmphasis: { tag: "strong" },
  Emphasis: { tag: "em" },
  Strikethrough: { tag: "s" },
  InlineCode: { tag: "code", className: "cm-inline-code" },
  Link: { tag: "span", className: "cm-table-raw-link" },
  Autolink: { tag: "span", className: "cm-table-raw-link" },
  WikiLink: { tag: "span", className: "cm-table-raw-link" },
};

function appendMark(parent: Node, text: string) {
  const mark = parent.appendChild(document.createElement("span"));
  mark.className = "cm-table-mark";
  mark.textContent = text;
}

/** The cell's raw markdown, styled; its `textContent` is exactly `markdown`. */
function setCellRawContent(cell: HTMLElement, markdown: string) {
  cell.replaceChildren();
  const walk = (node: SyntaxNode, parent: Node, inLink: boolean) => {
    let pos = node.from;
    const text = (from: number, to: number) => {
      if (to > from) parent.appendChild(document.createTextNode(markdown.slice(from, to)));
    };
    for (let child = node.firstChild; child; child = child.nextSibling) {
      text(pos, child.from);
      pos = child.to;
      if (child.name === "Escape") {
        appendMark(parent, "\\");
        text(child.from + 1, child.to);
      } else if (rawMarkNodes.has(child.name) || (inLink && child.name === "URL")) {
        appendMark(parent, markdown.slice(child.from, child.to));
      } else {
        const style = rawStyledNodes[child.name];
        const el = style ? document.createElement(style.tag) : null;
        if (el && style.className) el.className = style.className;
        walk(child, el ?? parent, inLink || child.name === "Link");
        if (el) parent.appendChild(el);
      }
    }
    text(pos, node.to);
  };
  walk(tableCellMarkdownParser.parse(markdown).topNode, cell, false);
}

/** Maps a character count in the rendered cell to a source offset in its raw rendering. */
function rawOffsetForRendered(cell: HTMLElement, rendered: number): number {
  let left = rendered;
  let offset = 0;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!node.parentElement?.closest(".cm-table-mark")) {
      if (left <= length) return offset + left;
      left -= length;
    }
    offset += length;
  }
  return offset;
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function textOffset(cell: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(cell, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function renderedCharsAt(cell: HTMLElement, x: number, y: number): number | null {
  const hit = caretFromPoint(x, y);
  return hit && cell.contains(hit.node) ? textOffset(cell, hit.node, hit.offset) : null;
}

function caretOffset(cell: HTMLElement): number | null {
  const selection = document.getSelection();
  if (!selection?.focusNode || !cell.contains(selection.focusNode)) return null;
  return textOffset(cell, selection.focusNode, selection.focusOffset);
}

function setCaret(cell: HTMLElement, offset: number | "end") {
  const selection = document.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  if (offset !== "end") {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (left <= length) {
        range.setStart(node, left);
        range.collapse(true);
        break;
      }
      left -= length;
    }
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Whether the caret sits on the cell's first (or last) visual line. */
function caretOnEdgeLine(cell: HTMLElement, edge: "first" | "last"): boolean {
  const selection = document.getSelection();
  const caret = selection?.rangeCount ? selection.getRangeAt(0).getClientRects()[0] : undefined;
  if (!caret) return true;
  const box = cell.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(cell).lineHeight) || 20;
  return edge === "first"
    ? caret.top - box.top < lineHeight * 1.2
    : box.bottom - caret.bottom < lineHeight * 1.2;
}

function cellAtX(cells: HTMLElement[], x: number | undefined): number {
  if (x === undefined) return 0;
  const index = cells.findIndex((cell) => cell.getBoundingClientRect().right > x);
  return index === -1 ? cells.length - 1 : index;
}

const linkSelector = ".cm-rendered-link, .cm-wiki-link";

/** Marks transactions the table editor dispatched itself. */
const tableEdit = Annotation.define<boolean>();

type CellCaret = number | "end" | { rendered: number | null };
type CellFocus = CellPos & { caret: number | "end" };
type ActiveCell = CellPos & { cell: HTMLElement };
type ParsedTable = { model: TableModel; cells: TableCellRanges };

/**
 * The previous source of the table starting at `from`, for a view that shows a
 * diff: `""` when the table is new, `null` when it didn't change.
 */
export const tableBaseline = Facet.define<
  (state: EditorState, from: number) => string | null,
  ((state: EditorState, from: number) => string | null) | undefined
>({ combine: (values) => values[0] });

const tableEditors = new WeakMap<HTMLElement, TableEditor>();
const viewTableEditors = new WeakMap<EditorView, Set<TableEditor>>();

function editorsOf(view: EditorView): Set<TableEditor> {
  let editors = viewTableEditors.get(view);
  if (!editors) viewTableEditors.set(view, (editors = new Set()));
  return editors;
}

function focusTableAtSelection(view: EditorView): boolean {
  const { main } = view.state.selection;
  if (!main.empty) return false;
  for (const editor of editorsOf(view)) if (editor.focusAt(main.head)) return true;
  return false;
}

class TableEditor {
  readonly dom = document.createElement("div");
  private readonly inner = document.createElement("div");
  raw = "";
  editable = false;
  private model!: TableModel;
  private cellRanges: TableCellRanges = [];
  private baseline: string | null = null;
  private diff: TableDiff | null = null;
  private cells: HTMLElement[][] = [];
  private active: ActiveCell | null = null;

  constructor(
    readonly view: EditorView,
    widget: TableWidget,
  ) {
    this.dom.className = "cm-table-widget";
    this.dom.contentEditable = "false";
    this.inner.className = "cm-table-inner";
    const hint = document.createElement("div");
    hint.className = "cm-table-hint";
    hint.innerHTML =
      "<kbd>Tab</kbd> next cell <span>·</span> <kbd>Enter</kbd> new row <span>·</span> " +
      "<kbd>⌫</kbd> in an empty row removes it <span>·</span> right-click for columns";
    this.dom.append(this.inner, hint);
    this.dom.addEventListener("mousedown", this.onMouseDown);
    this.dom.addEventListener("contextmenu", this.onContextMenu);
    this.dom.addEventListener("keydown", this.onKeyDown);
    this.dom.addEventListener("input", this.onInput);
    this.dom.addEventListener("compositionend", this.onInput);
    this.dom.addEventListener("paste", this.onPaste);
    this.dom.addEventListener("focusout", this.onFocusOut);
    this.paint(widget);
    tableEditors.set(this.dom, this);
    editorsOf(view).add(this);
  }

  update(widget: TableWidget) {
    if (
      widget.raw === this.raw &&
      widget.writable === this.editable &&
      widget.baseline === this.baseline
    ) {
      return;
    }
    this.paint(widget);
  }

  destroy() {
    editorsOf(this.view).delete(this);
  }

  from(): number {
    return this.view.posAtDOM(this.dom);
  }

  rowCount(): number {
    return this.model.rows.length;
  }

  /** Puts the caret in the cell holding document position `pos`, if it's inside this table. */
  focusAt(pos: number): boolean {
    if (!this.editable || !this.dom.isConnected) return false;
    const from = this.from();
    if (pos < from || pos > from + this.raw.length) return false;
    const { pos: cell, offset } = cellAtOffset(this.cellRanges, pos - from);
    this.activate(cell.r, cell.c, offset);
    return true;
  }

  /** Enters row `r` under viewport `x`, at its first or last visual line. */
  enterRow(r: number, x: number | undefined, edge: "top" | "bottom") {
    const row = this.cells[r];
    if (!row) return;
    const c = cellAtX(row, x);
    const cell = row[c];
    if (x === undefined) {
      this.activate(r, c, edge === "top" ? 0 : "end");
      return;
    }
    const box = cell.getBoundingClientRect();
    const style = getComputedStyle(cell);
    const y =
      edge === "top"
        ? box.top + parseFloat(style.paddingTop) + 2
        : box.bottom - parseFloat(style.paddingBottom) - 2;
    const clampedX = Math.max(box.left + 1, Math.min(x, box.right - 1));
    this.activate(r, c, { rendered: renderedCharsAt(cell, clampedX, y) });
  }

  private paint({
    raw,
    table,
    writable: editable,
    baseline,
    diff,
  }: Pick<TableWidget, "raw" | "table" | "writable" | "baseline" | "diff">) {
    const hadFocus = this.dom.contains(document.activeElement);
    this.raw = raw;
    this.model = table.model;
    this.cellRanges = table.cells;
    this.baseline = baseline;
    this.diff = diff;
    this.editable = editable;
    this.active = null;
    this.dom.classList.toggle("cm-table-editable", editable);

    const tableEl = document.createElement("table");
    const thead = tableEl.appendChild(document.createElement("thead"));
    const tbody = tableEl.appendChild(document.createElement("tbody"));
    if (diff) {
      this.cells = paintTableDiff(thead, tbody, table.model, diff);
    } else {
      const aligns = tableAligns(table.model);
      this.cells = table.model.rows.map((row, r) => {
        const tr = (r === 0 ? thead : tbody).appendChild(document.createElement("tr"));
        return row.cells.map((markdown, c) => {
          const cell = tr.appendChild(document.createElement(r === 0 ? "th" : "td"));
          cell.dataset.row = String(r);
          cell.dataset.column = String(c);
          if (aligns[c]) cell.style.textAlign = aligns[c];
          setCellMarkdownContent(cell, markdown);
          return cell;
        });
      });
    }
    this.inner.replaceChildren(tableEl);

    // Repainted under the caret (undo, a reload from disk): keep editing where
    // the document selection now points. Deferred, as paint runs mid-update.
    if (hadFocus) {
      queueMicrotask(() => {
        if (!focusTableAtSelection(this.view)) this.view.focus();
      });
    }
  }

  private cellOf(target: EventTarget | null): ActiveCell | null {
    if (!(target instanceof Element)) return null;
    const cell = target.closest<HTMLElement>("td, th");
    if (!cell || !this.inner.contains(cell)) return null;
    return { cell, r: Number(cell.dataset.row), c: Number(cell.dataset.column) };
  }

  private activate(r: number, c: number, caret: CellCaret) {
    const cell = this.cells[r]?.[c];
    if (!cell || !this.editable) return;
    if (this.active?.cell !== cell) {
      this.deactivate();
      this.active = { cell, r, c };
      cell.classList.add("cm-table-cell-active");
      cell.contentEditable = "plaintext-only";
      setCellRawContent(cell, this.model.rows[r].cells[c]);
    }
    const offset =
      typeof caret === "object"
        ? caret.rendered === null
          ? "end"
          : rawOffsetForRendered(cell, caret.rendered)
        : caret;
    cell.focus({ preventScroll: true });
    setCaret(cell, offset);
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.syncSelection(r, c, caretOffset(cell) ?? 0);
  }

  private deactivate() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.cell.classList.remove("cm-table-cell-active");
    active.cell.removeAttribute("contenteditable");
    setCellMarkdownContent(active.cell, this.model.rows[active.r].cells[active.c]);
  }

  /** Mirrors the cell caret into the document selection, so undo returns to it. */
  private syncSelection(r: number, c: number, offset: number) {
    const range = this.cellRanges[r]?.[c];
    if (!range) return;
    const anchor = this.from() + range.from + Math.min(offset, range.to - range.from);
    const { selection } = this.view.state;
    if (selection.ranges.length === 1 && selection.main.empty && selection.main.head === anchor) {
      return;
    }
    this.view.dispatch({ selection: { anchor }, annotations: tableEdit.of(true) });
  }

  /**
   * Writes `next` to the document. With `keepDom` the cell DOM already shows
   * the edit (typing), so the widget keeps it and the caret survives.
   */
  private write(next: TableModel, focus: CellFocus, userEvent: string, keepDom: boolean) {
    const { view } = this;
    const before = this.raw;
    if (view.state.readOnly) {
      if (keepDom) this.reset(before);
      return;
    }
    const from = this.from();
    const text = serializeTable(next);
    const table = parseMarkdownTable(text);
    if (!table) throw new Error("Serialized table failed to parse");
    const range = table.cells[focus.r][focus.c];
    const length = range.to - range.from;
    const caret = focus.caret === "end" ? length : Math.min(focus.caret, length);
    const change = textDiff(before, text);
    if (keepDom) {
      this.raw = text;
      this.model = table.model;
      this.cellRanges = table.cells;
    }
    view.dispatch({
      changes: { from: from + change.from, to: from + change.to, insert: change.insert },
      selection: { anchor: from + range.from + caret },
      annotations: tableEdit.of(true),
      userEvent,
    });
    // A transaction filter (the agent edit lock) can still drop the change.
    if (keepDom && view.state.sliceDoc(from, from + text.length) !== text) this.reset(before);
  }

  private reset(raw: string) {
    const table = parseMarkdownTable(raw);
    if (table) {
      const { editable: writable, baseline, diff } = this;
      this.paint({ raw, table, writable, baseline, diff });
    }
  }

  private commitStructure(next: TableModel, focus: CellFocus) {
    this.write(next, focus, "input.table", false);
    queueMicrotask(() => focusTableAtSelection(this.view));
  }

  private history(command: typeof undo) {
    command(this.view);
    queueMicrotask(() => {
      if (!focusTableAtSelection(this.view)) this.view.focus();
    });
  }

  private updateFromCell({ cell, r, c }: ActiveCell) {
    const typed = cell.textContent ?? "";
    const markdown = escapeCellText(typed);
    const caret = escapeCellText(typed.slice(0, caretOffset(cell) ?? typed.length)).length;
    setCellRawContent(cell, markdown);
    setCaret(cell, caret);
    if (markdown === this.model.rows[r].cells[c]) return;
    this.write(setCell(this.model, { r, c }, markdown), { r, c, caret }, "input.type", true);
  }

  private wrap({ cell, r, c }: ActiveCell, marker: string) {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const start = textOffset(cell, range.startContainer, range.startOffset);
    const end = start + range.toString().length;
    const markdown = this.model.rows[r].cells[c];
    const next = `${markdown.slice(0, start)}${marker}${markdown.slice(start, end)}${marker}${markdown.slice(end)}`;
    const caret = end + marker.length * (end > start ? 2 : 1);
    setCellRawContent(cell, next);
    setCaret(cell, caret);
    this.write(setCell(this.model, { r, c }, next), { r, c, caret }, "input", true);
  }

  /** Moves the caret into the prose before or after the table, adding a line at the document edge. */
  private leave(direction: "before" | "after") {
    const { view } = this;
    const from = this.from();
    const to = from + this.raw.length;
    const after = direction === "after";
    const pad = (after ? to >= view.state.doc.length : from === 0) && !view.state.readOnly;
    const anchor = after
      ? pad || to < view.state.doc.length
        ? to + 1
        : to
      : Math.max(0, from - 1);
    view.focus();
    view.dispatch({
      changes: pad ? { from: after ? to : 0, insert: "\n" } : undefined,
      selection: { anchor },
      annotations: tableEdit.of(true),
      scrollIntoView: true,
      userEvent: pad ? "input" : "select",
    });
  }

  private vertical(active: ActiveCell, r: number) {
    const selection = document.getSelection();
    const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const x =
      caret && caret.width + caret.height > 0
        ? caret.left
        : active.cell.getBoundingClientRect().left + 4;
    this.deactivate();
    this.enterRow(r, x, r < active.r ? "bottom" : "top");
  }

  private runMenuAction(id: TableCellMenuActionId, r: number, c: number) {
    const m = this.model;
    if (!this.editable || !this.dom.isConnected || !m.rows[r] || c >= tableWidth(m)) return;
    const below = Math.max(1, r + 1);
    const actions: Record<TableCellMenuActionId, () => [TableModel, CellFocus]> = {
      "row-above": () => [insertRow(m, r), { r: Math.max(1, r), c, caret: 0 }],
      "row-below": () => [insertRow(m, below), { r: below, c, caret: 0 }],
      "row-up": () => [moveRow(m, r, r - 1), { r: r - 1, c, caret: "end" }],
      "row-down": () => [moveRow(m, r, r + 1), { r: r + 1, c, caret: "end" }],
      "row-delete": () => [deleteRow(m, r), { r: Math.min(r, m.rows.length - 2), c, caret: "end" }],
      "column-left": () => [insertColumn(m, c), { r, c, caret: 0 }],
      "column-right": () => [insertColumn(m, c + 1), { r, c: c + 1, caret: 0 }],
      "align-left": () => [setAlign(m, c, "left"), { r, c, caret: "end" }],
      "align-center": () => [setAlign(m, c, "center"), { r, c, caret: "end" }],
      "align-right": () => [setAlign(m, c, "right"), { r, c, caret: "end" }],
      "column-move-left": () => [moveColumn(m, c, c - 1), { r, c: c - 1, caret: "end" }],
      "column-move-right": () => [moveColumn(m, c, c + 1), { r, c: c + 1, caret: "end" }],
      "column-delete": () => [
        deleteColumn(m, c),
        { r, c: Math.min(c, tableWidth(m) - 2), caret: "end" },
      ],
    };
    const [next, focus] = actions[id]();
    this.commitStructure(next, focus);
  }

  private handleKey(event: KeyboardEvent, active: ActiveCell): boolean {
    const { cell, r, c } = active;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") return (this.history(event.shiftKey ? redo : undo), true);
      if (event.shiftKey) return false;
      if (key === "b") return (this.wrap(active, "**"), true);
      if (key === "i") return (this.wrap(active, "*"), true);
      return false;
    }
    if (mod || event.altKey) return false;

    const lastRow = this.model.rows.length - 1;
    const lastColumn = tableWidth(this.model) - 1;
    const collapsed = document.getSelection()?.isCollapsed ?? true;
    const at = caretOffset(cell);
    switch (event.key) {
      case "Tab":
        if (event.shiftKey) {
          if (c > 0) this.activate(r, c - 1, "end");
          else if (r > 0) this.activate(r - 1, lastColumn, "end");
          else this.leave("before");
        } else if (c < lastColumn) this.activate(r, c + 1, "end");
        else if (r < lastRow) this.activate(r + 1, 0, "end");
        else this.commitStructure(insertRow(this.model, r + 1), { r: r + 1, c: 0, caret: 0 });
        return true;
      case "Enter": {
        if (event.shiftKey) return false;
        const below = Math.max(1, r + 1);
        this.commitStructure(insertRow(this.model, below), { r: below, c: 0, caret: 0 });
        return true;
      }
      case "Backspace":
        if (!collapsed || at !== 0 || r === 0 || this.model.rows[r].cells.some(Boolean)) {
          return false;
        }
        this.commitStructure(deleteRow(this.model, r), { r: r - 1, c: lastColumn, caret: "end" });
        return true;
      case "Escape":
        this.leave("after");
        return true;
      case "ArrowUp":
        if (event.shiftKey || !caretOnEdgeLine(cell, "first")) return false;
        if (r > 0) this.vertical(active, r - 1);
        else this.leave("before");
        return true;
      case "ArrowDown":
        if (event.shiftKey || !caretOnEdgeLine(cell, "last")) return false;
        if (r < lastRow) this.vertical(active, r + 1);
        else this.leave("after");
        return true;
      case "ArrowLeft":
        if (event.shiftKey || !collapsed || at !== 0) return false;
        if (c > 0) this.activate(r, c - 1, "end");
        else if (r > 0) this.activate(r - 1, lastColumn, "end");
        else this.leave("before");
        return true;
      case "ArrowRight":
        if (event.shiftKey || !collapsed || at !== (cell.textContent ?? "").length) return false;
        if (c < lastColumn) this.activate(r, c + 1, 0);
        else if (r < lastRow) this.activate(r + 1, 0, 0);
        else this.leave("after");
        return true;
    }
    return false;
  }

  private onMouseDown = (event: MouseEvent) => {
    if (!this.editable || event.button !== 0) return;
    const hit = this.cellOf(event.target);
    if (!hit || hit.cell === this.active?.cell) return;
    if (event.target instanceof Element && event.target.closest(linkSelector)) return;
    event.preventDefault();
    this.activate(hit.r, hit.c, {
      rendered: renderedCharsAt(hit.cell, event.clientX, event.clientY),
    });
  };

  private onContextMenu = (event: MouseEvent) => {
    if (!this.editable) return;
    const hit = this.cellOf(event.target);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    if (hit.cell !== this.active?.cell) this.activate(hit.r, hit.c, "end");
    const { r, c } = hit;
    const spec = buildTableCellMenuItemsSpec(
      { row: r, rows: this.model.rows.length, column: c, columns: tableWidth(this.model) },
      (id) => this.runMenuAction(id, r, c),
    );
    showNativeContextMenu(spec).catch((error: unknown) => {
      console.error("[table] Failed to show the table menu:", error);
    });
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const { active } = this;
    if (!active || event.target !== active.cell || event.isComposing) return;
    if (this.handleKey(event, active)) event.preventDefault();
  };

  private onInput = (event: Event) => {
    const { active } = this;
    if (!active || event.target !== active.cell) return;
    if (event instanceof InputEvent && event.isComposing) return;
    this.updateFromCell(active);
  };

  private onPaste = (event: ClipboardEvent) => {
    const { active } = this;
    if (!active || !(event.target instanceof Node) || !active.cell.contains(event.target)) return;
    event.preventDefault();
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*\r?\n\s*/g, " ");
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    this.updateFromCell(active);
  };

  private onFocusOut = (event: FocusEvent) => {
    const { active } = this;
    if (!active || event.target !== active.cell) return;
    if (event.relatedTarget instanceof Node && this.dom.contains(event.relatedTarget)) return;
    // The window lost focus; the cell keeps it for when the window comes back.
    if (event.relatedTarget === null && document.activeElement === active.cell) return;
    this.deactivate();
  };
}

class TableWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly table: ParsedTable,
    readonly writable: boolean,
    readonly baseline: string | null,
    readonly diff: TableDiff | null,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return (
      other.raw === this.raw && other.writable === this.writable && other.baseline === this.baseline
    );
  }

  get estimatedHeight(): number {
    return estimateTableWidgetHeight(this.table.model.rows.length);
  }

  toDOM(view: EditorView): HTMLElement {
    return new TableEditor(view, this).dom;
  }

  updateDOM(dom: HTMLElement): boolean {
    const editor = tableEditors.get(dom);
    if (!editor) return false;
    editor.update(this);
    return true;
  }

  destroy(dom: HTMLElement) {
    tableEditors.get(dom)?.destroy();
  }

  // The table handles its own input. Link clicks still reach the editor's
  // link navigation, and a read-only table gets the editor's context menu.
  ignoreEvent(event: Event): boolean {
    if (event.type === "contextmenu") return this.writable;
    if (event.type !== "mousedown" && event.type !== "click") return true;
    return !(event.target instanceof Element && event.target.closest(linkSelector));
  }
}

// Line prefixes a table can sit behind: indentation and blockquote markers.
const tablePrefix = /^(?:[\t ]*>)*[\t ]*$/;
const tableContainers = new Set([
  "Document",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
]);

const isEditable = (state: EditorState) => !state.readOnly && state.facet(EditorView.editable);

/** The source range of every table the widget renders, in document order. */
export function tableRanges(doc: Text, tree: Tree): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return tableContainers.has(node.name);
      const line = doc.lineAt(node.from);
      // The widget starts at the line start so a row's indentation or `>` is
      // part of the source it rewrites.
      if (tablePrefix.test(doc.sliceString(line.from, node.from))) {
        ranges.push({ from: line.from, to: node.to });
      }
      return false;
    },
  });
  return ranges;
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const editable = isEditable(state);
  const baselineOf = state.facet(tableBaseline);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of tableRanges(state.doc, syntaxTree(state))) {
    const raw = state.doc.sliceString(from, to);
    const parsed = parseMarkdownTable(raw);
    if (!parsed) continue;
    const baseline = baselineOf?.(state, from) ?? null;
    const diff =
      baseline === null
        ? null
        : diffTables(parseMarkdownTable(baseline)?.model ?? null, parsed.model);
    ranges.push(
      Decoration.replace({
        widget: new TableWidget(raw, parsed, editable, baseline, diff),
        block: true,
      }).range(from, to),
    );
  }
  return Decoration.set(ranges);
}

const tableField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(decorations, tr) {
    if (
      tr.docChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      isEditable(tr.state) !== isEditable(tr.startState)
    ) {
      return buildTableDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function tableEditorAt(view: EditorView, from: number): TableEditor | undefined {
  for (const editor of editorsOf(view)) {
    if (editor.dom.isConnected && editor.from() === from) return editor;
  }
  return undefined;
}

// Vertical motion skips block widgets, so ↑/↓ from the prose next to a table
// step into its nearest row instead, under the caret's x.
function enterTableVertically(forward: boolean) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const target = view.moveVertically(range, forward);
    let hit: { from: number; to: number } | undefined;
    view.state
      .field(tableField)
      .between(Math.min(range.head, target.head), Math.max(range.head, target.head), (from, to) => {
        if (forward ? from > range.head && !hit : to < range.head) hit = { from, to };
      });
    if (!hit) return false;
    const editor = tableEditorAt(view, hit.from);
    if (!editor?.editable) return false;
    const x = view.coordsAtPos(range.head)?.left;
    editor.enterRow(forward ? 0 : editor.rowCount() - 1, x, forward ? "top" : "bottom");
    return true;
  };
}

const tableKeymap = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: enterTableVertically(true) },
    { key: "ArrowUp", run: enterTableVertically(false) },
  ]),
);

// Moves that land the document caret inside a table's source (←/→ across its
// edge, undo from the prose, inserting a table) continue in the matching cell.
const tableSelectionRedirect = EditorView.updateListener.of((update) => {
  if (!update.selectionSet || !update.view.hasFocus) return;
  if (update.transactions.some((tr) => tr.annotation(tableEdit))) return;
  queueMicrotask(() => focusTableAtSelection(update.view));
});

const tableTheme = EditorView.baseTheme({
  ".cm-table-widget": {
    padding: `${tableWidgetVerticalPaddingEm / 2}em 0`,
  },
  ".cm-table-inner": {
    display: "inline-block",
  },
  ".cm-table-widget table": {
    borderCollapse: "separate",
    borderSpacing: "0",
    border: `${tableBorderWidthPx}px solid var(--border-color, #3e3e42)`,
    borderRadius: "8px",
    overflow: "hidden",
    fontFamily: "inherit",
    fontSize: "inherit",
    width: "auto",
  },
  ".cm-table-widget th, .cm-table-widget td": {
    padding: `${tableCellVerticalPaddingEm / 2}em 0.8em`,
    maxWidth: `${tableCellMaxWidthCh}ch`,
    // `EditorView.lineWrapping` applies `overflow-wrap: anywhere` (plus
    // Safari's `word-break: break-word`) to `.cm-content`, and these cells
    // inherit it. Unlike `break-word`, `anywhere` contributes its break
    // opportunities to min-content sizing, so every column's minimum collapses
    // to a single character and the auto table layout is free to squeeze a
    // column until ordinary words shred mid-word. Resetting to `break-word`
    // puts the column minimum back at "longest word": an overlong token still
    // breaks, but only once it cannot fit on a line at all.
    overflowWrap: "break-word",
    wordBreak: "normal",
    // Short cells sit against the first line of a tall wrapped row rather than
    // floating in the middle of it.
    verticalAlign: "top",
    fontSize: "inherit",
    lineHeight: `${tableCellLineHeight}`,
    borderBottom: `${tableBorderWidthPx}px solid var(--border-color, #3e3e42)`,
    borderRight: `${tableBorderWidthPx}px solid var(--border-color, #3e3e42)`,
  },
  ".cm-table-widget th:last-child, .cm-table-widget td:last-child": {
    borderRight: "none",
  },
  ".cm-table-widget tbody tr:last-child td": {
    borderBottom: "none",
  },
  ".cm-table-widget th": {
    fontWeight: "600",
    backgroundColor: "var(--surface-subtle, var(--code-bg, #2d2d2d))",
    // Headers match their left-aligned bodies instead of taking the browser's
    // centered `th` default. An alignment parsed from the delimiter row is set
    // as an inline style on the cell, so `:---:` / `---:` still win here.
    textAlign: "left",
  },
  ".cm-table-editable td, .cm-table-editable th": {
    cursor: "text",
  },
  ".cm-table-widget .cm-table-cell-active": {
    backgroundColor: "color-mix(in srgb, var(--fg-base) 3.5%, transparent)",
    whiteSpace: "pre-wrap",
    outline: "none",
  },
  ".cm-table-widget th.cm-table-cell-active": {
    backgroundColor: "color-mix(in srgb, var(--fg-base) 7%, transparent)",
  },
  // drawSelection resets a focused descendant's caret to the browser default.
  ".cm-content .cm-table-widget .cm-table-cell-active": {
    caretColor: "var(--pm-cursor-color) !important",
  },
  ".cm-table-cell-active .cm-inline-code": {
    padding: "0",
    background: "none",
  },
  ".cm-table-mark": {
    color: "var(--text-muted)",
    fontWeight: "400",
    fontStyle: "normal",
  },
  ".cm-table-raw-link": {
    color: "var(--pm-link-color)",
  },
  ".cm-table-hint": {
    position: "relative",
    top: "6px",
    height: "0",
    overflow: "visible",
    font: "11.5px/1 var(--ui-font)",
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    opacity: "0",
    transform: "translateY(-2px)",
    transition: "opacity 150ms ease-out, transform 150ms cubic-bezier(0.23, 1, 0.32, 1)",
  },
  ".cm-table-editable:focus-within .cm-table-hint": {
    opacity: "1",
    transform: "none",
  },
  ".cm-table-hint kbd": {
    font: "inherit",
    padding: "1px 4px",
    borderRadius: "3px",
    background: "var(--code-bg)",
    color: "var(--text-secondary)",
  },
  ".cm-table-hint span": {
    margin: "0 4px",
    opacity: "0.6",
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-table-hint": {
      transform: "none",
    },
  },
});

export function tableDecorations(): Extension {
  return [tableField, tableKeymap, tableSelectionRedirect, tableTheme];
}
