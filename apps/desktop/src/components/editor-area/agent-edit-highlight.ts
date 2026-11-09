import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  BlockType,
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  layer,
  type BlockInfo,
  type DecorationSet,
  type LayerMarker,
  type ViewUpdate,
} from "@codemirror/view";
import { invertedEffects } from "@codemirror/commands";
import { blockRect } from "./block-rect";
import { editorDocumentPath } from "@/lib/editor-views";
import { setAgentEditSummary, type AgentEditSummary } from "./agent-edit-summary-store";
import "./agent-edit-highlight.css";

export const showAgentEdit = StateEffect.define<{
  turnId: string;
  ranges: { from: number; to: number }[];
  added: number;
  removed: number;
}>();

/** Drops the highlights and summary, unless a newer turn has replaced them. */
export const clearAgentEdit = StateEffect.define<{ turnId: string }>();

type Snapshot = {
  turnId: string | null;
  ranges: { from: number; to: number }[];
  summary: AgentEditSummary | null;
  dismissed: boolean;
};

/** Undo and redo put back the highlights as they were before the undone change. */
const restoreAgentEdit = StateEffect.define<Snapshot>({
  map: (value, mapping) => ({
    ...value,
    ranges: value.ranges
      .map((r) => ({ from: mapping.mapPos(r.from, 1), to: mapping.mapPos(r.to, -1) }))
      .filter((r) => r.from < r.to),
  }),
});

const mark = Decoration.mark({ class: "writer-agent-new" });
const FRESH_MS = 1200;
const CLEAR_FADE_MS = 180;

type HighlightState = {
  turnId: string | null;
  decorations: DecorationSet;
  summary: AgentEditSummary | null;
  /** Cleared by the writer: undo doesn't bring this turn's highlights back. */
  dismissed: boolean;
};

const EMPTY: HighlightState = {
  turnId: null,
  decorations: Decoration.none,
  summary: null,
  dismissed: false,
};

function snapshot(value: HighlightState): Snapshot {
  const ranges: { from: number; to: number }[] = [];
  value.decorations.between(0, Number.MAX_SAFE_INTEGER, (from, to) => {
    ranges.push({ from, to });
  });
  return { turnId: value.turnId, ranges, summary: value.summary, dismissed: value.dismissed };
}

/** Words Co-writer added, tinted until the writer edits them, clears them, or the next turn
 *  replaces them. The summary counts the turn's added and removed words for the footer. */
export const agentEditHighlightField = StateField.define<HighlightState>({
  create: () => EMPTY,
  update(value, tr) {
    // History merges a group's inverses newest first, so the last one is the group's start.
    let restore: Snapshot | null = null;
    for (const effect of tr.effects) if (effect.is(restoreAgentEdit)) restore = effect.value;
    if (restore) {
      if (value.dismissed && restore.turnId === value.turnId) return value;
      return {
        turnId: restore.turnId,
        decorations: Decoration.set(restore.ranges.map((r) => mark.range(r.from, r.to))),
        summary: restore.summary,
        dismissed: restore.dismissed,
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(clearAgentEdit) && effect.value.turnId === value.turnId) {
        return { ...EMPTY, turnId: value.turnId, dismissed: true };
      }
      if (!effect.is(showAgentEdit)) continue;
      const { turnId, ranges, added, removed } = effect.value;
      const marks = ranges.map((r) => mark.range(r.from, r.to));
      const sameTurn = turnId === value.turnId;
      const kept = sameTurn ? value.decorations.map(tr.changes) : Decoration.none;
      const prior = sameTurn ? value.summary : null;
      const total = {
        added: added + (prior?.added ?? 0),
        removed: removed + (prior?.removed ?? 0),
      };
      return {
        turnId,
        decorations: kept.update({ add: marks, sort: true }),
        summary: total.added + total.removed > 0 ? total : null,
        dismissed: false,
      };
    }
    if (!tr.docChanged || (value.decorations === Decoration.none && !value.summary)) return value;
    // A version restore is a reload with no Co-writer turn behind it.
    if (
      tr.isUserEvent("writer.swap") ||
      tr.isUserEvent("writer.reload") ||
      tr.isUserEvent("writer.agent-reload")
    ) {
      return EMPTY;
    }
    if (value.decorations === Decoration.none) return value;
    const decorations = value.decorations.map(tr.changes).update({
      filter: (from, to) => {
        let touched = false;
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          if (fromB <= to && toB >= from) touched = true;
        });
        return !touched;
      },
    });
    // Once the writer has edited every phrase, the summary has nothing left to point at.
    const summary = decorations.size === 0 && value.summary?.removed === 0 ? null : value.summary;
    return { ...value, decorations, summary };
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

/** Whether there are highlights or a footer summary left to clear. */
export function hasAgentEdits(state: EditorState) {
  const { decorations, summary } = state.field(agentEditHighlightField, false) ?? EMPTY;
  return decorations.size > 0 || summary !== null;
}

/** Fades the tint out, then clears it. A turn landing mid-fade keeps its highlights. */
export function clearAgentEdits(view: EditorView) {
  const { turnId } = view.state.field(agentEditHighlightField);
  if (turnId === null) return;
  const clear = () => {
    view.dom.removeAttribute("data-agent-clearing");
    view.dispatch({ effects: clearAgentEdit.of({ turnId }) });
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return clear();
  view.dom.setAttribute("data-agent-clearing", "");
  window.setTimeout(clear, CLEAR_FADE_MS);
}

// A pane swap rebinds the view to another path, so the old path's summary is cleared.
const summaryPublisher = ViewPlugin.fromClass(
  class {
    path: string | null = null;
    summary: AgentEditSummary | null = null;
    constructor(view: EditorView) {
      this.publish(view);
    }
    update(update: ViewUpdate) {
      this.publish(update.view);
    }
    publish(view: EditorView) {
      const { summary } = view.state.field(agentEditHighlightField);
      const path = editorDocumentPath(view) || null;
      if (path === this.path && summary === this.summary) return;
      if (this.path && this.path !== path) setAgentEditSummary(this.path, null);
      this.path = path;
      this.summary = summary;
      if (path) setAgentEditSummary(path, summary);
    }
    destroy() {
      if (this.path) setAgentEditSummary(this.path, null);
    }
  },
);

// Low precedence: closing search or a popup, and collapsing multiple cursors, take Esc first.
const clearOnEscape = Prec.low(
  keymap.of([
    {
      key: "Escape",
      run: (view) => {
        if (!hasAgentEdits(view.state)) return false;
        clearAgentEdits(view);
        return true;
      },
    },
  ]),
);

// Effect-only changes (Clear, Esc) stay out of history, so ⌘Z still undoes text first.
const undoableHighlights = invertedEffects.of((tr) => {
  const before = tr.startState.field(agentEditHighlightField);
  return tr.docChanged && before !== tr.state.field(agentEditHighlightField)
    ? [restoreAgentEdit.of(snapshot(before))]
    : [];
});

export const agentEditHighlight: Extension = [
  agentEditHighlightField,
  undoableHighlights,
  freshPulse,
  blockLayer,
  summaryPublisher,
  clearOnEscape,
];
