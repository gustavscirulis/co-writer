import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  BlockType,
  Decoration,
  EditorView,
  ViewPlugin,
  layer,
  type BlockInfo,
  type DecorationSet,
  type LayerMarker,
  type ViewUpdate,
} from "@codemirror/view";
import { blockRect } from "./block-rect";
import "./agent-edit-highlight.css";

export const showAgentEdit = StateEffect.define<{
  turnId: string;
  ranges: { from: number; to: number }[];
}>();

const mark = Decoration.mark({ class: "writer-agent-new" });
const FRESH_MS = 1200;

/** Words Co-writer added, tinted until the writer edits them or the next turn replaces them. */
export const agentEditHighlightField = StateField.define<{
  turnId: string | null;
  decorations: DecorationSet;
}>({
  create: () => ({ turnId: null, decorations: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(showAgentEdit)) continue;
      const added = effect.value.ranges.map((r) => mark.range(r.from, r.to));
      const kept =
        effect.value.turnId === value.turnId ? value.decorations.map(tr.changes) : Decoration.none;
      return { turnId: effect.value.turnId, decorations: kept.update({ add: added, sort: true }) };
    }
    if (!tr.docChanged || value.decorations === Decoration.none) return value;
    if (tr.isUserEvent("writer.swap") || tr.isUserEvent("writer.reload")) {
      return { turnId: null, decorations: Decoration.none };
    }
    const decorations = value.decorations.map(tr.changes).update({
      filter: (from, to) => {
        let touched = false;
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          if (fromB <= to && toB >= from) touched = true;
        });
        return !touched;
      },
    });
    return { turnId: value.turnId, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Highlighted ranges overlapping `from`–`to`, relative to `from`, for widgets that draw their own text. */
export function agentAddedRanges(state: EditorState, from: number, to: number) {
  const ranges: { from: number; to: number }[] = [];
  state.field(agentEditHighlightField, false)?.decorations.between(from, to, (a, b) => {
    if (b > from && a < to)
      ranges.push({ from: Math.max(a, from) - from, to: Math.min(b, to) - from });
  });
  return ranges;
}

const widgetBlockAt = (view: EditorView, pos: number): BlockInfo | null => {
  const line = view.lineBlockAt(pos);
  const blocks = Array.isArray(line.type) ? line.type : [line];
  return (
    blocks.find((b) => b.type === BlockType.WidgetRange && b.from <= pos && pos < b.to) ?? null
  );
};

// Marks can't reach into a block widget, so it's tinted whole unless it sets `showsAgentEdits`.
const blockLayer = layer({
  above: false,
  class: "writer-agent-new-block-layer",
  markers(view) {
    const { decorations } = view.state.field(agentEditHighlightField);
    const markers: LayerMarker[] = [];
    let last = -1;
    decorations.between(view.viewport.from, view.viewport.to, (pos) => {
      const block = pos > last ? widgetBlockAt(view, pos) : null;
      if (!block || (block.widget as { showsAgentEdits?: boolean } | null)?.showsAgentEdits) {
        return;
      }
      last = block.to;
      markers.push(blockRect(view, "writer-agent-new-block", block.top, block.bottom));
    });
    return markers;
  },
  update: (update) =>
    update.docChanged ||
    update.geometryChanged ||
    update.viewportChanged ||
    update.state.field(agentEditHighlightField) !==
      update.startState.field(agentEditHighlightField),
});

const freshPulse = ViewPlugin.fromClass(
  class {
    timer = 0;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (!update.transactions.some((tr) => tr.effects.some((e) => e.is(showAgentEdit)))) return;
      clearTimeout(this.timer);
      this.view.dom.setAttribute("data-agent-fresh", "");
      this.timer = window.setTimeout(
        () => this.view.dom.removeAttribute("data-agent-fresh"),
        FRESH_MS,
      );
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

export const agentEditHighlight: Extension = [agentEditHighlightField, freshPulse, blockLayer];
