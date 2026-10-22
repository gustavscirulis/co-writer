import { describe, expect, test } from "vite-plus/test";
import {
  cellAtOffset,
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
  type TableModel,
} from "../src/components/editor-area/table-model";

const source = [
  "| Day |  Plan   | Budget |",
  "| :-- | :---: | -----: |",
  "| Thu | Land **early** |   €0 |",
  "| Fri | Tile museum \\| lunch | €45 |",
].join("\n");

function parse(text: string): TableModel {
  const parsed = parseMarkdownTable(text);
  if (!parsed) throw new Error("Expected a table");
  return parsed.model;
}

const cells = (model: TableModel) => model.rows.map((row) => row.cells);

describe("parseMarkdownTable", () => {
  test("reads cells, alignment, and escaped pipes", () => {
    const model = parse(source);
    expect(cells(model)).toEqual([
      ["Day", "Plan", "Budget"],
      ["Thu", "Land **early**", "€0"],
      ["Fri", "Tile museum \\| lunch", "€45"],
    ]);
    expect(tableAligns(model)).toEqual(["left", "center", "right"]);
  });

  test("maps each cell to its content range in the source", () => {
    const parsed = parseMarkdownTable(source);
    const range = parsed!.cells[2][1];
    expect(source.slice(range.from, range.to)).toBe("Tile museum \\| lunch");
  });

  test("pads short rows and drops cells past the delimiter width", () => {
    const model = parse("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |");
    expect(cells(model)).toEqual([
      ["a", "b"],
      ["1", ""],
      ["1", "2"],
    ]);
  });

  test("rejects text without a delimiter row", () => {
    expect(parseMarkdownTable("| a | b |\n| c | d |")).toBeUndefined();
  });
});

describe("serializeTable", () => {
  test("round-trips an untouched table byte for byte", () => {
    expect(serializeTable(parse(source))).toBe(source);
  });

  test("rewrites only the row whose cell changed", () => {
    const lines = serializeTable(setCell(parse(source), { r: 1, c: 2 }, "€10")).split("\n");
    expect(lines).toEqual([
      "| Day |  Plan   | Budget |",
      "| :-- | :---: | -----: |",
      "| Thu | Land **early** | €10 |",
      "| Fri | Tile museum \\| lunch | €45 |",
    ]);
  });

  test("keeps list indentation and blockquote markers on rewritten rows", () => {
    const indented = "  | a | b |\n  | - | - |\n  | 1 | 2 |";
    expect(serializeTable(setCell(parse(indented), { r: 1, c: 0 }, "x"))).toBe(
      "  | a | b |\n  | - | - |\n  | x | 2 |",
    );

    const quoted = "> | a | b |\n> | - | - |\n> | 1 | 2 |";
    const model = parse(quoted);
    expect(cells(model)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(serializeTable(insertRow(model, 2))).toBe(`${quoted}\n> |  |  |`);
  });
});

describe("structural edits", () => {
  const model = parse("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");

  test("insert, delete, and move rows below the header", () => {
    expect(cells(insertRow(model, 1))[1]).toEqual(["", ""]);
    expect(cells(insertRow(model, 0))[0]).toEqual(["a", "b"]);
    expect(cells(deleteRow(model, 1))).toEqual([
      ["a", "b"],
      ["3", "4"],
    ]);
    expect(deleteRow(model, 0)).toBe(model);
    expect(cells(moveRow(model, 2, 1))).toEqual([
      ["a", "b"],
      ["3", "4"],
      ["1", "2"],
    ]);
    expect(moveRow(model, 1, 0)).toBe(model);
  });

  test("insert, delete, and move columns, delimiter included", () => {
    const inserted = insertColumn(setAlign(model, 0, "right"), 1);
    expect(cells(inserted)[0]).toEqual(["a", "", "b"]);
    expect(tableAligns(inserted)).toEqual(["right", undefined, undefined]);
    expect(cells(deleteColumn(model, 0))).toEqual([["b"], ["2"], ["4"]]);
    expect(cells(moveColumn(model, 0, 1))[1]).toEqual(["2", "1"]);
    expect(moveColumn(model, 1, 2)).toBe(model);
    const single = deleteColumn(model, 0);
    expect(deleteColumn(single, 0)).toBe(single);
  });

  test("setAlign writes the canonical delimiter", () => {
    const aligned = setAlign(setAlign(model, 0, "center"), 1, "left");
    expect(serializeTable(aligned).split("\n")[1]).toBe("| :---: | :--- |");
  });
});

describe("escapeCellText", () => {
  test("escapes bare pipes and turns newlines into <br>", () => {
    expect(escapeCellText("a | b \\| c\nd")).toBe("a \\| b \\| c<br>d");
  });
});

describe("cellAtOffset", () => {
  const parsed = parseMarkdownTable("| ab | cd |\n| -- | -- |\n|  | ef |")!;

  test("finds the cell and the offset within it", () => {
    expect(cellAtOffset(parsed.cells, 8)).toEqual({ pos: { r: 0, c: 1 }, offset: 1 });
  });

  test("snaps positions between cells to the nearest one", () => {
    expect(cellAtOffset(parsed.cells, 0)).toEqual({ pos: { r: 0, c: 0 }, offset: 0 });
    expect(cellAtOffset(parsed.cells, 10)).toEqual({ pos: { r: 0, c: 1 }, offset: 2 });
  });

  test("lands in empty cells", () => {
    expect(cellAtOffset(parsed.cells, 26).pos).toEqual({ r: 1, c: 0 });
  });
});

describe("diffTables", () => {
  const before = parse("| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |");

  test("marks a changed cell, an inserted row and a deleted row in display order", () => {
    const after = parse("| A | B |\n| - | - |\n| 1 | two |\n| 5 | 6 |\n| 7 | 8 |");
    expect(diffTables(before, after)).toEqual([
      { kind: "same", r: 0 },
      { kind: "changed", r: 1, before: ["1", "2"] },
      { kind: "deleted", cells: ["3", "4"] },
      { kind: "same", r: 2 },
      { kind: "inserted", r: 3 },
    ]);
  });

  test("always pairs the header", () => {
    const after = parse("| A | C |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |");
    expect(diffTables(before, after)[0]).toEqual({ kind: "changed", r: 0, before: ["A", "B"] });
  });

  test("marks every row of a new table as inserted", () => {
    expect(diffTables(null, before).map((row) => row.kind)).toEqual(Array(4).fill("inserted"));
  });
});
