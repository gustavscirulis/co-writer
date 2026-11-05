import { expect, test } from "vite-plus/test";
import { insertedWordRanges, textDiff } from "../src/lib/text-diff";
for (const [before, after] of [
  ["", "text"],
  ["text", ""],
  ["abc", "abc"],
  ["one two three", "one new three"],
  ["abc", "xbc"],
  ["🙂 note", "🙃 note"],
  ["a\nb", "a\nchanged\nb"],
]) {
  test(`minimal replacement: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, () => {
    const diff = textDiff(before, after);
    expect(before.slice(0, diff.from) + diff.insert + before.slice(diff.to)).toBe(after);
    if (before === "one two three") expect(diff).toEqual({ from: 4, to: 7, insert: "new" });
  });
}

const inserted = (before: string, after: string) =>
  insertedWordRanges(before, after).map((r) => after.slice(r.from, r.to));

test("inserted word ranges mark only new words, as whole phrases", () => {
  const before = `I keep notes in plain text because they are simple and they last a long time.

- Git gives me history for free.
- Search is just grep.

Tables are awkward. I also miss linking notes together, although wiki links solve that now.

I sync the folder with iCloud. It works most of the time.
`;
  const after = `I keep notes in plain text because they are portable, readable, and will outlast any app I use today.

- Git gives me history for free, and diffs show exactly what changed.
- Search is just grep.
- Nothing is locked behind an account.

Tables are awkward.

I sync the folder with iCloud. It works most of the time, but conflicts show up as duplicates.
`;
  expect(inserted(before, after)).toEqual([
    "portable, readable, and will outlast any app I use today",
    ", and diffs show exactly what changed",
    "Nothing is locked behind an account.",
    ", but conflicts show up as duplicates",
  ]);
});

for (const [name, before, after] of [
  ["a deletion", "Keep this. Drop this.", "Keep this."],
  ["whitespace", "One.\nTwo.", "One.\n\nTwo."],
  ["a moved word", "alpha beta", "beta alpha beta"],
  ["a new paragraph", "Plain list.\n", "Plain list.\n\nNew closing line.\n"],
]) {
  test(`inserted word ranges: ${name}`, () => {
    const ranges = inserted(before, after);
    if (name === "a moved word") expect(ranges).toEqual(["beta"]);
    else if (name === "a new paragraph") expect(ranges).toEqual(["New closing line."]);
    else expect(ranges).toEqual([]);
  });
}

test("inserted word ranges fall back to a character diff for very large rewrites", () => {
  const before = "old ".repeat(2500).trim();
  const after = "new ".repeat(2500).trim();
  expect(insertedWordRanges(before, after)).toEqual([{ from: 0, to: after.length }]);
});
