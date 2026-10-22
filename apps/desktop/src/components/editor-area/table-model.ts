export type TableAlign = "left" | "center" | "right" | undefined;

interface TableRow {
  cells: string[];
  /** The line as written and the cells it parsed to, so untouched rows round-trip byte for byte. */
  source?: { line: string; cells: string[] };
}

/** A GFM table: row 0 is the header, every row has one cell per delimiter cell. */
export interface TableModel {
  rows: TableRow[];
  delimiter: TableRow;
  indent: string;
}

/** Cell content offsets relative to the table's first character, per model row. */
export type TableCellRanges = { from: number; to: number }[][];

export interface CellPos {
  r: number;
  c: number;
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

const isSpace = (char: string | undefined) => char === " " || char === "\t";

// Indentation and blockquote markers ahead of a row; rewritten rows keep the first row's.
const linePrefix = /^(?:[\t ]*>)*[\t ]*/;

function splitRow(line: string, offset: number) {
  let start = linePrefix.exec(line)?.[0].length ?? 0;
  let end = line.length;
  while (start < end && isSpace(line[start])) start++;
  while (end > start && isSpace(line[end - 1])) end--;
  if (line[start] === "|") start++;
  if (end > start && line[end - 1] === "|" && !isEscapedAt(line, end - 1)) end--;

  const cells: { text: string; from: number; to: number }[] = [];
  const push = (from: number, to: number) => {
    let a = from;
    let b = to;
    while (a < b && isSpace(line[a])) a++;
    while (b > a && isSpace(line[b - 1])) b--;
    if (a === b) a = b = Math.min(from + 1, to);
    cells.push({ text: line.slice(a, b), from: offset + a, to: offset + b });
  };
  let cellStart = start;
  for (let i = start; i < end; i++) {
    if (line[i] === "|" && !isEscapedAt(line, i)) {
      push(cellStart, i);
      cellStart = i + 1;
    }
  }
  push(cellStart, end);
  return { cells, lineEnd: offset + line.length };
}

export function parseAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

export function parseMarkdownTable(
  text: string,
): { model: TableModel; cells: TableCellRanges } | undefined {
  const lines: { line: string; offset: number }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) lines.push({ line, offset });
    offset += line.length + 1;
  }
  if (lines.length < 2) return undefined;

  const delimiter = splitRow(lines[1].line, lines[1].offset);
  const delimiterCells = delimiter.cells.map((cell) => cell.text);
  if (!delimiterCells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
  const width = delimiterCells.length;

  const rows: TableRow[] = [];
  const cells: TableCellRanges = [];
  for (const { line, offset: lineOffset } of [lines[0], ...lines.slice(2)]) {
    const split = splitRow(line, lineOffset);
    const parsed = Array.from({ length: width }, (_, c) => split.cells[c]?.text ?? "");
    rows.push({ cells: parsed, source: { line, cells: parsed } });
    cells.push(
      Array.from(
        { length: width },
        (_, c) => split.cells[c] ?? { from: split.lineEnd, to: split.lineEnd },
      ),
    );
  }

  return {
    model: {
      rows,
      delimiter: { cells: delimiterCells, source: { line: lines[1].line, cells: delimiterCells } },
      indent: linePrefix.exec(lines[0].line)?.[0] ?? "",
    },
    cells,
  };
}

const sameCells = (a: string[], b: string[]) =>
  a.length === b.length && a.every((cell, i) => cell === b[i]);

function serializeRow(row: TableRow, indent: string): string {
  if (row.source && sameCells(row.source.cells, row.cells)) return row.source.line;
  return `${indent}| ${row.cells.join(" | ")} |`;
}

/** Rewrites only the rows whose cells changed; untouched rows keep their original spacing. */
export function serializeTable(model: TableModel): string {
  const [header, ...body] = model.rows;
  return [header, model.delimiter, ...body]
    .map((row) => serializeRow(row, model.indent))
    .join("\n");
}

export function tableAligns(model: TableModel): TableAlign[] {
  return model.delimiter.cells.map(parseAlign);
}

export function tableWidth(model: TableModel): number {
  return model.delimiter.cells.length;
}

function delimiterCell(align: TableAlign): string {
  if (align === "center") return ":---:";
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  return "---";
}

const withCells = (row: TableRow, cells: string[]): TableRow => ({ ...row, cells });

const mapCells = (m: TableModel, fn: (cells: string[]) => string[]): TableModel => ({
  ...m,
  rows: m.rows.map((row) => withCells(row, fn([...row.cells]))),
  delimiter: withCells(m.delimiter, fn([...m.delimiter.cells])),
});

export function setCell(m: TableModel, { r, c }: CellPos, text: string): TableModel {
  const rows = [...m.rows];
  const cells = [...rows[r].cells];
  cells[c] = text;
  rows[r] = withCells(rows[r], cells);
  return { ...m, rows };
}

/** Inserts an empty body row at index `at`, never above the header. */
export function insertRow(m: TableModel, at: number): TableModel {
  const rows = [...m.rows];
  rows.splice(Math.max(1, at), 0, { cells: m.delimiter.cells.map(() => "") });
  return { ...m, rows };
}

export function deleteRow(m: TableModel, r: number): TableModel {
  if (r < 1) return m;
  return { ...m, rows: m.rows.filter((_, i) => i !== r) };
}

export function moveRow(m: TableModel, from: number, to: number): TableModel {
  if (from < 1 || to < 1 || to >= m.rows.length) return m;
  const rows = [...m.rows];
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  return { ...m, rows };
}

export function insertColumn(m: TableModel, at: number): TableModel {
  const next = mapCells(m, (cells) => (cells.splice(at, 0, ""), cells));
  return setAlign(next, at, undefined);
}

export function deleteColumn(m: TableModel, c: number): TableModel {
  if (tableWidth(m) < 2) return m;
  return mapCells(m, (cells) => (cells.splice(c, 1), cells));
}

export function moveColumn(m: TableModel, from: number, to: number): TableModel {
  if (to < 0 || to >= tableWidth(m)) return m;
  return mapCells(m, (cells) => {
    const [cell] = cells.splice(from, 1);
    cells.splice(to, 0, cell);
    return cells;
  });
}

export function setAlign(m: TableModel, c: number, align: TableAlign): TableModel {
  const cells = [...m.delimiter.cells];
  cells[c] = delimiterCell(align);
  return { ...m, delimiter: withCells(m.delimiter, cells) };
}

/** How one displayed row differs from the table's previous version, in display order. */
export type TableRowDiff =
  | { kind: "same" | "inserted"; r: number }
  | { kind: "changed"; r: number; before: string[] }
  | { kind: "deleted"; cells: string[] };

/**
 * Rows of `after` against `before`: the header always pairs, body rows match on
 * their cells, and unmatched rows between matches pair up as changed.
 */
export function diffTables(before: TableModel | null, after: TableModel): TableRowDiff[] {
  if (!before) return after.rows.map((_, r) => ({ kind: "inserted", r }));
  const a = before.rows.map((row) => row.cells);
  const b = after.rows.map((row) => row.cells);
  const out: TableRowDiff[] = [];
  const pair = (i: number, j: number) =>
    out.push(
      sameCells(a[i], b[j]) ? { kind: "same", r: j } : { kind: "changed", r: j, before: a[i] },
    );
  pair(0, 0);

  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 1; i--) {
    for (let j = m - 1; j >= 1; j--) {
      lcs[i][j] = sameCells(a[i], b[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  let i = 1;
  let j = 1;
  let gapA: number[] = [];
  let gapB: number[] = [];
  const flush = () => {
    const paired = Math.min(gapA.length, gapB.length);
    for (let k = 0; k < paired; k++) pair(gapA[k], gapB[k]);
    for (const di of gapA.slice(paired)) out.push({ kind: "deleted", cells: a[di] });
    for (const r of gapB.slice(paired)) out.push({ kind: "inserted", r });
    gapA = [];
    gapB = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && sameCells(a[i], b[j])) {
      flush();
      out.push({ kind: "same", r: j });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      gapB.push(j++);
    } else {
      gapA.push(i++);
    }
  }
  flush();
  return out;
}

/** Pipes in typed text are escaped and newlines become `<br>`, so the row stays one line. */
export function escapeCellText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "|" && !isEscapedAt(text, i)) out += "\\|";
    else if (char === "\n") out += "<br>";
    else out += char;
  }
  return out;
}

/** The cell whose source holds `offset` (relative to the table start), and the offset within it. */
export function cellAtOffset(
  cells: TableCellRanges,
  offset: number,
): { pos: CellPos; offset: number } {
  let best = { pos: { r: 0, c: 0 }, offset: 0 };
  let bestDistance = Infinity;
  cells.forEach((row, r) =>
    row.forEach((range, c) => {
      const distance = offset < range.from ? range.from - offset : Math.max(0, offset - range.to);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          pos: { r, c },
          offset: Math.max(0, Math.min(offset, range.to) - range.from),
        };
      }
    }),
  );
  return best;
}
