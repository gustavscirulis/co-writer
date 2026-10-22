import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { getChunks } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import {
  firstChangePosition,
  historyPreviewState,
} from "../src/components/version-history/history-preview-extensions";
import {
  focusAt,
  holdFocus,
  isCrowded,
  lensShape,
  magnify,
  nearestMark,
  timelineMarks,
  visibleDays,
} from "../src/components/version-history/version-timeline";
import { bodyKey, useHistoryStore } from "../src/stores/history-store";
import { useEditorStore } from "../src/stores/editor-store";
import { clearAgentEditing } from "../src/lib/agent-turn";
import type { NoteVersion } from "../src/lib/tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), resolveTheme: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 12, 15, 0).getTime();

function version(id: string, updatedAt: number, source: NoteVersion["source"] = "user") {
  return { id, createdAt: updatedAt, updatedAt, source };
}

describe("history preview", () => {
  test("shows the selected version with the changes since the previous one", () => {
    const state = historyPreviewState(
      "# Title\n\nNew paragraph.\n",
      "# Title\n\nOld paragraph.\n",
      () => "/n.md",
    );
    expect(state.doc.toString()).toBe("# Title\n\nNew paragraph.\n");
    expect(getChunks(state)?.chunks).toHaveLength(1);
    expect(firstChangePosition(state)).toBe(9);
  });

  test("is read-only and parks the selection on a trailing empty line", () => {
    const state = historyPreviewState("# Title", "# Title", () => "/n.md");
    expect(state.readOnly).toBe(true);
    expect(state.doc.toString()).toBe("# Title\n");
    expect(state.selection.main.head).toBe(state.doc.length);
    expect(firstChangePosition(state)).toBeNull();
    const next = state.update({ changes: { from: 0, insert: "x" } }).state;
    expect(next.doc.toString()).toBe("# Title\n");
  });

  test("diffs a changed table against the table it was, and leaves unchanged tables alone", () => {
    const kept = "| K |\n| - |\n| k |";
    const state = historyPreviewState(
      `| A | B |\n| - | - |\n| 1 | two |\n| 5 | 6 |\n\n${kept}\n`,
      `Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\n${kept}\n`,
      () => "/n.md",
    );
    const diffs: unknown[] = [];
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === "function") continue;
      source.between(0, state.doc.length, (_from, _to, deco) => {
        const widget = deco.spec.widget as { diff?: unknown } | undefined;
        if (widget && "diff" in widget) diffs.push(widget.diff);
      });
    }
    expect(diffs).toEqual([
      {
        columns: [
          { before: 0, after: 0 },
          { before: 1, after: 1 },
        ],
        rows: [
          { kind: "same", r: 0, before: ["A", "B"] },
          { kind: "changed", r: 1, before: ["1", "2"] },
          { kind: "deleted", cells: ["3", "4"] },
          { kind: "same", r: 2, before: ["5", "6"] },
        ],
      },
      null,
    ]);
  });

  test("leaves changed tables out of the prose diff, so the old table isn't repeated as raw markdown", () => {
    const state = historyPreviewState(
      "Intro.\n\n| A | New |\n| - | - |\n| 1 | x |\n",
      "Intro.\n\n| A |\n| - |\n| 1 |\n",
      () => "/n.md",
    );
    expect(getChunks(state)?.chunks).toHaveLength(0);
    expect(firstChangePosition(state)).toBe(8);
  });

  test("shows every row of a table the version added as inserted", () => {
    const state = historyPreviewState("Hi.\n\n| A |\n| - |\n| 1 |\n", "Hi.\n", () => "/n.md");
    const kinds: string[] = [];
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === "function") continue;
      source.between(0, state.doc.length, (_from, _to, deco) => {
        const widget = deco.spec.widget as
          | { diff?: { rows: { kind: string }[] } | null }
          | undefined;
        widget?.diff?.rows.forEach((row) => kinds.push(row.kind));
      });
    }
    expect(kinds).toEqual(["inserted", "inserted"]);
  });
});

describe("version timeline", () => {
  const versions = [
    version("4", NOW - 60_000),
    version("3", NOW - 120_000),
    version("2", NOW - DAY),
    version("1", NOW - 3 * DAY),
  ];

  test("lays versions out oldest first, labelling the first of each day", () => {
    const marks = timelineMarks(versions, NOW);
    expect(marks.map((mark) => [mark.version.id, mark.day])).toEqual([
      ["1", "Oct 9"],
      ["2", "Yesterday"],
      ["3", "Today"],
      ["4", null],
    ]);
    const at = marks.map((mark) => mark.at);
    expect(at[3] - at[2]).toBeLessThan(at[2] - at[1]);
    expect(at[0]).toBeGreaterThan(0);
    expect(at[3]).toBeLessThan(100);
  });

  test("only a change of day gets a label, however many versions a day holds", () => {
    // Two, two, then four versions a day: summing the gaps drifts past 1.0.
    const day = (ago: number, count: number) =>
      Array.from({ length: count }, (_, i) => version(`${ago}-${i}`, NOW - ago - i * 60_000));
    const marks = timelineMarks([...day(0, 4), ...day(DAY, 2), ...day(3 * DAY, 2)], NOW);
    expect(marks.filter((mark) => mark.day !== null).map((mark) => mark.day)).toEqual([
      "Oct 9",
      "Yesterday",
      "Today",
    ]);
  });

  test("a single version sits in the middle", () => {
    expect(timelineMarks([version("1", NOW)], NOW)[0].at).toBe(50);
  });

  test("crowded day labels thin out, keeping the newest day", () => {
    const marks = timelineMarks(versions, NOW);
    const at = marks.map((mark) => mark.at);
    expect(visibleDays(marks, at, 1)).toEqual([0, 1, 2]);
    expect(visibleDays(marks, at, 40)).toEqual([0, 2]);
    expect(visibleDays(marks, at, 100)).toEqual([2]);
  });

  test("a pointer picks the closest mark", () => {
    const at = timelineMarks(versions, NOW).map((mark) => mark.at);
    expect(nearestMark(at, 0)).toBe(0);
    expect(nearestMark(at, 100)).toBe(3);
    expect(nearestMark(at, at[1] + 1)).toBe(1);
  });

  const WIDTH = 600;
  const track = (count: number) =>
    Array.from({ length: count }, (_, i) => 2 + (i / (count - 1)) * 96);
  const gapsPx = (at: number[]) => at.slice(1).map((x, i) => ((x - at[i]) / 100) * WIDTH);

  test("the lens spreads versions near its focus, keeping the ends and their order", () => {
    const at = track(300);
    const { peak } = lensShape(at, WIDTH);
    const lensed = magnify(at, 150, peak);
    expect(lensed[0]).toBe(2);
    expect(lensed[299]).toBeCloseTo(98);
    expect(lensed.every((x, i) => i === 0 || x > lensed[i - 1])).toBe(true);
    expect(gapsPx(lensed)[150]).toBeGreaterThan(9);
    expect(gapsPx(lensed)[0]).toBeLessThan(gapsPx(at)[0]);
    expect(magnify(at, 150, peak, 0)).toEqual(at);
  });

  test("the oldest and newest versions spread as far as the ones in the middle", () => {
    const at = track(300);
    const { peak } = lensShape(at, WIDTH);
    const oldest = gapsPx(magnify(at, 0, peak));
    const newest = gapsPx(magnify(at, 299, peak));
    for (let i = 0; i < 3; i++) {
      expect(oldest[i]).toBeGreaterThan(9);
      expect(newest[298 - i]).toBeGreaterThan(9);
    }
  });

  test("a lens comes up centred under the pointer, even near the ends", () => {
    const at = track(300);
    const { peak } = lensShape(at, WIDTH);
    const pointers = [0, 1, 2.3, 30, 70, 97.7, 99, 100];
    const foci = pointers.map((pointer) => focusAt(at, pointer, peak));
    pointers.forEach((pointer, i) => {
      expect(nearestMark(magnify(at, foci[i], peak), pointer)).toBe(Math.round(foci[i]));
    });
    expect(foci.every((focus, i) => i === 0 || focus >= foci[i - 1])).toBe(true);
    expect(focusAt(at, 0, peak)).toBeCloseTo(0);
    expect(focusAt(at, 100, peak)).toBeCloseTo(299);
  });

  test("the lens holds still under the pointer, then slides along past its edge", () => {
    const at = track(300);
    const shape = lensShape(at, WIDTH);
    const hovered = (focus: number, pointer: number) =>
      nearestMark(magnify(at, focus, shape.peak), pointer);
    const start = at[150];
    const focus = focusAt(at, start, shape.peak);
    expect(holdFocus(at, focus, start + shape.hold / 2, shape)).toBe(focus);
    // Inside the lens, a 7px move steps one version rather than three or four.
    expect(hovered(focus, start)).toBe(150);
    expect(hovered(focus, start + (7 / WIDTH) * 100)).toBe(151);
    const pushed = start + shape.hold * 2;
    expect(holdFocus(at, focus, pushed, shape)).toBeCloseTo(
      focusAt(at, pushed, shape.peak, shape.hold),
    );
    expect(holdFocus(at, focus, pushed, shape)).toBeGreaterThan(focus);
    expect(holdFocus(at, 0, 0, shape)).toBe(0);
    expect(holdFocus(at, 0, -50, shape)).toBeCloseTo(0);
  });

  test("the lens grows with the number of versions", () => {
    expect(
      lensShape(
        timelineMarks(versions, NOW).map((mark) => mark.at),
        700,
      ).peak,
    ).toBe(1);
    const at = track(1000);
    const lensed = gapsPx(magnify(at, 500, lensShape(at, WIDTH).peak));
    expect(lensed[500]).toBeGreaterThan(9);
  });

  test("the lens is only needed once versions sit too close to point at", () => {
    const few = timelineMarks(versions, NOW).map((mark) => mark.at);
    expect(isCrowded(few, 700)).toBe(false);
    const many = Array.from({ length: 250 }, (_, i) => version(`${i}`, NOW - i * 60_000));
    expect(
      isCrowded(
        timelineMarks(many, NOW).map((mark) => mark.at),
        700,
      ),
    ).toBe(true);
  });
});

describe("history store", () => {
  const versions = [
    version("3-agent", NOW, "agent"),
    version("2-user", NOW - 1000),
    version("1-external", NOW - 2000, "external"),
  ];
  const contents: Record<string, string> = {
    "3-agent": "Claude edit",
    "2-user": "---\ntitle: T\n---\nMy edit",
    "1-external": "Original",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentEditing();
    useHistoryStore.getState().close();
    useEditorStore.setState({ openFiles: new Map(), tabs: [], activeTabId: null });
    mockedInvoke.mockImplementation(async (command, args) => {
      const id = (args as { id?: string } | undefined)?.id ?? "";
      if (command === "history_list") return versions;
      if (command === "history_read" || command === "history_restore") return contents[id];
      return undefined;
    });
  });

  test("opening selects the current version and loads it with its predecessor", async () => {
    await useHistoryStore.getState().open("/n.md");
    await vi.waitFor(() => expect(useHistoryStore.getState().bodies.size).toBe(2));
    const state = useHistoryStore.getState();
    expect(state.selectedId).toBe("3-agent");
    expect(state.bodies.get(bodyKey(versions[1]))).toBe("My edit");
  });

  test("arrow navigation stays within the list", async () => {
    await useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().move(-1);
    expect(useHistoryStore.getState().selectedId).toBe("3-agent");
    useHistoryStore.getState().move(1);
    useHistoryStore.getState().move(1);
    useHistoryStore.getState().move(1);
    expect(useHistoryStore.getState().selectedId).toBe("1-external");
  });

  test("restoring the current version does nothing", async () => {
    await useHistoryStore.getState().open("/n.md");
    await useHistoryStore.getState().restore();
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_restore", expect.anything());
  });

  test("restoring an earlier version writes it and closes history", async () => {
    await useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().select("1-external");
    await useHistoryStore.getState().restore();
    expect(mockedInvoke).toHaveBeenCalledWith("history_restore", {
      path: "/n.md",
      id: "1-external",
    });
    expect(useHistoryStore.getState().path).toBeNull();
  });

  test("a stale list for a closed history is ignored", async () => {
    const opening = useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().close();
    await opening;
    expect(useHistoryStore.getState().versions).toEqual([]);
  });
});
