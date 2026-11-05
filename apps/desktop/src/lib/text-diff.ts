import { presentableDiff } from "@codemirror/merge";

/** One replacement that preserves the unchanged prefix/suffix and selection mapping. */
export function textDiff(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WORD = /[\p{L}\p{N}_]+/gu;
const TOKEN = /[\p{L}\p{N}_]+[^\S\n]*|[^\p{L}\p{N}_\s][^\S\n]*|\s+/gu;
const BLOCK_MARKER = /^(#{1,6} |[-*+] |\d+[.)] |> )/;
const MAX_LCS_CELLS = 4_000_000;

type Change = { fromA: number; toA: number; fromB: number; toB: number };

function tokenize(text: string, from: number, to: number) {
  const raw = text.slice(from, to).match(TOKEN) ?? [];
  const offsets = [from];
  for (const token of raw) offsets.push(offsets[offsets.length - 1] + token.length);
  // Compared without trailing spaces, so "four" still matches "four " when a word is appended.
  return { tokens: raw.map((token) => token.trimEnd() || token), offsets };
}

/** Word-level LCS over the region `textDiff` says changed, or null when it is too
 *  large. `presentableDiff` is character-level and its heuristics can splice an
 *  unrelated new sentence into the deleted one. */
function wordDiff(before: string, after: string): Change[] | null {
  const outer = textDiff(before, after);
  const A = tokenize(before, outer.from, outer.to);
  const B = tokenize(after, outer.from, outer.from + outer.insert.length);
  const n = A.tokens.length;
  const m = B.tokens.length;
  if (n * m > MAX_LCS_CELLS) return null;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        A.tokens[i] === B.tokens[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A.tokens[i] === B.tokens[j]) {
      i++;
      j++;
      continue;
    }
    const startA = i;
    const startB = j;
    while ((i < n || j < m) && !(i < n && j < m && A.tokens[i] === B.tokens[j])) {
      if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
      else i++;
    }
    changes.push({
      fromA: A.offsets[startA],
      toA: A.offsets[i],
      fromB: B.offsets[startB],
      toB: B.offsets[j],
    });
  }
  return mergeShortEqualities(before, changes);
}

/** Folds a kept run no longer than the changes on both sides into them, within
 *  one line, so shared filler words don't break a rewrite into fragments. */
function mergeShortEqualities(before: string, changes: Change[]) {
  const size = (c: Change) => Math.max(c.toA - c.fromA, c.toB - c.fromB);
  let merged = true;
  while (merged) {
    merged = false;
    const next: Change[] = [];
    for (const change of changes) {
      const last = next[next.length - 1];
      const gap = last ? change.fromA - last.toA : 0;
      if (
        last &&
        gap <= size(last) &&
        gap <= size(change) &&
        !before.slice(last.toA, change.fromA).includes("\n")
      ) {
        next[next.length - 1] = { ...last, toA: change.toA, toB: change.toB };
        merged = true;
      } else next.push(change);
    }
    changes = next;
  }
  return changes;
}

/** Slides a pure insertion right onto a line boundary when the text allows it, so
 *  "list" + ".\n\nNew." + ".\n" reads as "list." + "\n\nNew." + "\n". */
function slideToLineBoundary(text: string, from: number, to: number) {
  const atBoundary = (i: number) => text[i] === "\n" || text[i - 1] === "\n";
  let f = from;
  let t = to;
  while (t < text.length && text[f] === text[t] && !atBoundary(f)) {
    f++;
    t++;
  }
  return atBoundary(f) ? [f, t] : [from, to];
}

/** Ranges of `after` holding words that `before` lacks, whole words only.
 *  Runs split by one kept word are joined, so a rewrite reads as one phrase. */
export function insertedWordRanges(before: string, after: string) {
  const isWord = (i: number) => WORD_CHAR.test(after[i] ?? "");
  const ranges: { from: number; to: number }[] = [];
  for (const change of wordDiff(before, after) ?? presentableDiff(before, after, { timeout: 50 })) {
    if (change.fromB === change.toB) continue;
    let [from, to] =
      change.fromA === change.toA
        ? slideToLineBoundary(after, change.fromB, change.toB)
        : [change.fromB, change.toB];
    while (from > 0 && isWord(from - 1) && isWord(from)) from--;
    while (to < after.length && isWord(to - 1) && isWord(to)) to++;
    while (from < to && /\s/.test(after[from])) from++;
    from += after.slice(from, to).match(BLOCK_MARKER)?.[0].length ?? 0;
    while (to > from && /\s/.test(after[to - 1])) to--;
    if (from >= to) continue;
    const last = ranges[ranges.length - 1];
    const gap = last ? after.slice(last.to, from) : "";
    if (last && !gap.includes("\n") && (gap.match(WORD) ?? []).length <= 1) {
      last.to = Math.max(last.to, to);
    } else ranges.push({ from, to });
  }
  return ranges;
}
