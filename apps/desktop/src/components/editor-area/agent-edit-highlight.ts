import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
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

export const agentEditHighlight: Extension = [agentEditHighlightField, freshPulse];
