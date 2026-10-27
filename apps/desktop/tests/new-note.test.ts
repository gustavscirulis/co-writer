import { beforeEach, expect, test, vi } from "vite-plus/test";

vi.mock("../src/lib/tauri", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("../src/hooks/editor-api", () => ({ getOpenFile: vi.fn() }));

import { getOpenFile } from "../src/hooks/editor-api";
import { readFile, writeFile } from "../src/lib/tauri";
import type { FileContent } from "../src/types/fs";
import { fillEmptyNoteTitle, newNoteCaret, titledNote } from "../src/lib/new-note";

beforeEach(() => vi.resetAllMocks());

const onDisk = (content: string) =>
  vi.mocked(readFile).mockResolvedValue({ path: "/n/Ideas.md", content } as FileContent);

test("titledNote puts the title in the heading and leaves a body line", () => {
  expect(titledNote("Meeting notes")).toBe("# Meeting notes\n\n");
});

test("newNoteCaret lands after an empty heading or below a titled one", () => {
  expect(newNoteCaret("# ")).toBe(2);
  expect(newNoteCaret("# Meeting notes\n\n")).toBe("# Meeting notes\n\n".length);
  expect(newNoteCaret("# Meeting notes\n\nBody")).toBeNull();
  expect(newNoteCaret("# Meeting notes")).toBeNull();
  expect(newNoteCaret("Some text\n\n")).toBeNull();
  expect(newNoteCaret("")).toBeNull();
});

test("fillEmptyNoteTitle titles a note that is still the empty template", async () => {
  onDisk("# ");
  await fillEmptyNoteTitle("/n/Ideas.md", "Ideas");
  expect(writeFile).toHaveBeenCalledExactlyOnceWith("/n/Ideas.md", "# Ideas\n\n");
});

test("fillEmptyNoteTitle leaves notes with content alone", async () => {
  onDisk("# Draft\n\nWords");
  await fillEmptyNoteTitle("/n/Ideas.md", "Ideas");
  expect(writeFile).not.toHaveBeenCalled();
});

test("fillEmptyNoteTitle leaves open notes to the editor", async () => {
  vi.mocked(getOpenFile).mockReturnValue({} as ReturnType<typeof getOpenFile>);
  onDisk("# ");
  await fillEmptyNoteTitle("/n/Ideas.md", "Ideas");
  expect(readFile).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
