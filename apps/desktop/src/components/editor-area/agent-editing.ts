import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { isAgentEditing, subscribeAgentEditing } from "@/lib/agent-turn";
import { insertedWordRanges, textDiff } from "@/lib/text-diff";
import { agentEditHighlight, showAgentEdit } from "./agent-edit-highlight";
import { EditorView } from "@codemirror/view";

export const agentFrontmatter = StateEffect.define<string | null>();
export const agentFrontmatterField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(agentFrontmatter)) value = effect.value;
    return value;
  },
});

function agentLock(path: string): Extension {
  return isAgentEditing(path)
    ? [EditorState.readOnly.of(true), EditorView.editorAttributes.of({ "data-agent-editing": "" })]
    : EditorState.readOnly.of(false);
}

export function agentEditingExtensions(
  frontmatter: string | null,
  compartment: Compartment,
  path: () => string,
): Extension {
  return [
    agentFrontmatterField.init(() => frontmatter),
    agentEditHighlight,
    invertedEffects.of((tr) =>
      tr.effects.some((e) => e.is(agentFrontmatter))
        ? [agentFrontmatter.of(tr.startState.field(agentFrontmatterField))]
        : [],
    ),
    compartment.of(agentLock(path())),
    // readOnly alone does not reject explicit dispatches by widgets or menus.
    EditorState.transactionFilter.of((tr) =>
      isAgentEditing(path()) &&
      (tr.docChanged || tr.effects.some((e) => e.is(agentFrontmatter))) &&
      !tr.isUserEvent("writer")
        ? []
        : tr,
    ),
  ];
}
export function watchAgentEditing(view: EditorView, compartment: Compartment, path: () => string) {
  view.dispatch({ effects: compartment.reconfigure(agentLock(path())) });
  return subscribeAgentEditing(() =>
    view.dispatch({ effects: compartment.reconfigure(agentLock(path())) }),
  );
}
/** `turnId` marks a Co-writer edit, whose new words get highlighted; restores pass none. */
export function agentReloadTransaction(
  before: string,
  after: string,
  frontmatter: string | null,
  turnId?: string,
) {
  const effects: StateEffect<unknown>[] = [agentFrontmatter.of(frontmatter)];
  if (turnId) effects.push(showAgentEdit.of({ turnId, ranges: insertedWordRanges(before, after) }));
  return {
    changes: textDiff(before, after),
    effects,
    annotations: [Transaction.addToHistory.of(true), isolateHistory.of("full")],
    userEvent: "writer.agent-reload",
  };
}
