import { afterEach, expect, test } from "vite-plus/test";
import { Compartment, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import {
  agentEditingExtensions,
  agentFrontmatterField,
  agentReloadTransaction,
  watchAgentEditing,
} from "../src/components/editor-area/agent-editing";
import {
  agentEditHighlightField,
  clearAgentEdit,
  hasAgentEdits,
} from "../src/components/editor-area/agent-edit-highlight";
import { acquireAgentEditing, clearAgentEditing } from "../src/lib/agent-turn";
import { EditorView } from "@codemirror/view";
afterEach(clearAgentEditing);
function harness(body: string, frontmatter: string | null) {
  let state = EditorState.create({
    doc: body,
    extensions: [
      history(),
      agentEditingExtensions(frontmatter, new Compartment(), () => "/note.md"),
    ],
  });
  return {
    get state() {
      return state;
    },
    dispatch: (transaction: Transaction) => {
      state = transaction.state;
    },
    change: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
  };
}
for (const after of ["Revised paragraph", "Original paragraph"]) {
  test(`agent reload undoes/redoes frontmatter and ${after === "Original paragraph" ? "unchanged" : "changed"} body in one step`, () => {
    const editor = harness("Original paragraph", "title: Before");
    const release = acquireAgentEditing("/note.md");
    editor.change(agentReloadTransaction(editor.state.doc.toString(), after, "title: After"));
    expect(undoDepth(editor.state)).toBe(1);
    release();
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("Original paragraph");
    expect(editor.state.field(agentFrontmatterField)).toBe("title: Before");
    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(after);
    expect(editor.state.field(agentFrontmatterField)).toBe("title: After");
  });
}
test("explicit widget/formatting document dispatches are rejected while locked", () => {
  const editor = harness("Draft", null);
  acquireAgentEditing("/note.md");
  editor.change({ changes: { from: 0, insert: "Unexpected" } });
  expect(editor.state.doc.toString()).toBe("Draft");
  editor.change(agentReloadTransaction("Draft", "Approved reload", null));
  expect(editor.state.doc.toString()).toBe("Approved reload");
});

test("a reused pane reconfigures readonly and dispatch guards for its current note", () => {
  let path = "/a.md";
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: "Draft",
    extensions: [agentEditingExtensions(null, compartment, () => path)],
  });
  const view = {
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const release = acquireAgentEditing("/a.md");
  let unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(true);
  view.dispatch({ changes: { from: 0, insert: "Blocked" } });
  expect(state.doc.toString()).toBe("Draft");
  unwatch();
  path = "/b.md";
  unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(false);
  view.dispatch({ changes: { from: 0, insert: "B: " } });
  expect(state.doc.toString()).toBe("B: Draft");
  unwatch();
  path = "/a.md";
  unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(true);
  release();
  expect(state.readOnly).toBe(false);
  unwatch();
});

test("the editor carries a wait-cursor marker only while its note is locked", () => {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: "Draft",
    extensions: [agentEditingExtensions(null, compartment, () => "/a.md")],
  });
  const view = {
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const marked = () =>
    state.facet(EditorView.editorAttributes).some((attrs) => "data-agent-editing" in attrs);
  const unwatch = watchAgentEditing(view, compartment, () => "/a.md");
  expect(marked()).toBe(false);
  const release = acquireAgentEditing("/a.md");
  expect(marked()).toBe(true);
  release();
  expect(marked()).toBe(false);
  unwatch();
});

function highlighted(state: EditorState) {
  const words: string[] = [];
  state.field(agentEditHighlightField).decorations.between(0, state.doc.length, (from, to) => {
    words.push(state.sliceDoc(from, to));
  });
  return words;
}

test("a Co-writer reload highlights its new words until the writer edits them", () => {
  const editor = harness("One two. Three four.", null);
  editor.change(
    agentReloadTransaction("One two. Three four.", "One new two. Three four more.", null, "t1"),
  );
  expect(highlighted(editor.state)).toEqual(["new", "more"]);
  editor.change({ changes: { from: 0, insert: "Yes. " } });
  expect(highlighted(editor.state)).toEqual(["new", "more"]);
  const at = editor.state.doc.toString().indexOf("new") + 1;
  editor.change({ changes: { from: at, insert: "x" } });
  expect(highlighted(editor.state)).toEqual(["more"]);
});

test("a restore reload highlights nothing", () => {
  const editor = harness("One two.", null);
  editor.change(agentReloadTransaction("One two.", "One new two.", null));
  expect(highlighted(editor.state)).toEqual([]);
});

test("edits within one turn add up and the next turn replaces them", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  editor.change(agentReloadTransaction("A one b.", "A one b two.", null, "t1"));
  expect(highlighted(editor.state)).toEqual(["one", "two"]);
  editor.change(agentReloadTransaction("A one b two.", "Three A one b two.", null, "t2"));
  expect(highlighted(editor.state)).toEqual(["Three"]);
});

test("undoing the reload or swapping the note clears its highlights", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  expect(undo(editor)).toBe(true);
  expect(highlighted(editor.state)).toEqual([]);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t2"));
  editor.change({
    changes: { from: 0, to: editor.state.doc.length, insert: "A one b." },
    userEvent: "writer.swap",
  });
  expect(highlighted(editor.state)).toEqual([]);
});

const summary = (state: EditorState) => state.field(agentEditHighlightField).summary;

test("a turn's summary counts added and removed words across its edits", () => {
  const editor = harness("Pack shoes and a big coat.", null);
  editor.change(
    agentReloadTransaction(
      "Pack shoes and a big coat.",
      "Pack shoes and a light jacket.",
      null,
      "t1",
    ),
  );
  expect(summary(editor.state)).toEqual({ added: 2, removed: 2 });
  editor.change(
    agentReloadTransaction(
      "Pack shoes and a light jacket.",
      "Pack shoes, sunscreen and a light jacket.",
      null,
      "t1",
    ),
  );
  expect(summary(editor.state)).toEqual({ added: 3, removed: 2 });
  editor.change(agentReloadTransaction(editor.state.doc.toString(), "Pack shoes.", null, "t2"));
  expect(summary(editor.state)).toEqual({ added: 0, removed: 5 });
});

test("clearing drops the highlights and summary, but not a newer turn's", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  editor.change(agentReloadTransaction("A one b.", "A one b two.", null, "t2"));
  editor.change({ effects: clearAgentEdit.of({ turnId: "t1" }) });
  expect(highlighted(editor.state)).toEqual(["two"]);
  expect(hasAgentEdits(editor.state)).toBe(true);
  editor.change({ effects: clearAgentEdit.of({ turnId: "t2" }) });
  expect(highlighted(editor.state)).toEqual([]);
  expect(summary(editor.state)).toBeNull();
  expect(hasAgentEdits(editor.state)).toBe(false);
});

test("the summary goes once every new phrase is edited, unless words were removed", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  const at = editor.state.doc.toString().indexOf("one") + 1;
  editor.change({ changes: { from: at, insert: "x" } });
  expect(summary(editor.state)).toBeNull();
  editor.change(agentReloadTransaction(editor.state.doc.toString(), "A b.", null, "t2"));
  editor.change({ changes: { from: 0, insert: "Z " } });
  expect(summary(editor.state)).toEqual({ added: 0, removed: 1 });
  editor.change({
    changes: { from: 0, to: editor.state.doc.length, insert: "Other note." },
    userEvent: "writer.swap",
  });
  expect(summary(editor.state)).toBeNull();
});

test("undo takes a Co-writer edit's highlights and summary with it, and redo brings them back", () => {
  const editor = harness("Pack shoes and a big coat.", null);
  editor.change(
    agentReloadTransaction(
      "Pack shoes and a big coat.",
      "Pack shoes and a light jacket.",
      null,
      "t1",
    ),
  );
  expect(undo(editor)).toBe(true);
  expect(highlighted(editor.state)).toEqual([]);
  expect(summary(editor.state)).toBeNull();
  expect(redo(editor)).toBe(true);
  expect(highlighted(editor.state)).toEqual(["light jacket"]);
  expect(summary(editor.state)).toEqual({ added: 2, removed: 2 });
});

test("undoing the writer's edit to a phrase brings its highlight back", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  const at = editor.state.doc.toString().indexOf("one") + 1;
  editor.change({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
  expect(highlighted(editor.state)).toEqual([]);
  expect(undo(editor)).toBe(true);
  expect(highlighted(editor.state)).toEqual(["one"]);
  expect(summary(editor.state)).toEqual({ added: 1, removed: 0 });
});

test("after Clear, undoing later typing doesn't bring the highlights back", () => {
  const editor = harness("A b.", null);
  editor.change(agentReloadTransaction("A b.", "A one b.", null, "t1"));
  editor.change({ changes: { from: 0, insert: "Z " }, userEvent: "input.type" });
  editor.change({ effects: clearAgentEdit.of({ turnId: "t1" }) });
  expect(undo(editor)).toBe(true);
  expect(editor.state.doc.toString()).toBe("A one b.");
  expect(highlighted(editor.state)).toEqual([]);
  expect(summary(editor.state)).toBeNull();
});

test("a version restore clears the highlights, and undoing it brings them back", () => {
  const editor = harness("A b. C d.", null);
  editor.change(agentReloadTransaction("A b. C d.", "A one b. C d two.", null, "t1"));
  editor.change(agentReloadTransaction("A one b. C d two.", "A one b. C d.", null));
  expect(highlighted(editor.state)).toEqual([]);
  expect(summary(editor.state)).toBeNull();
  expect(undo(editor)).toBe(true);
  expect(highlighted(editor.state)).toEqual(["one", "two"]);
  expect(summary(editor.state)).toEqual({ added: 2, removed: 0 });
});
