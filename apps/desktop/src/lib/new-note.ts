import { getOpenFile } from "@/hooks/editor-api";
import * as tauri from "@/lib/tauri";

/** Mirrors the default template `create_file_impl` writes. */
export const EMPTY_NOTE = "# ";

export function titledNote(title: string): string {
  return `# ${title}\n\n`;
}

/** Where the caret should land in an untouched new note, or null if `doc` isn't one. */
export function newNoteCaret(doc: string): number | null {
  if (doc === EMPTY_NOTE) return EMPTY_NOTE.length;
  if (/^# [^\n]+\n\n$/.test(doc)) return doc.length;
  return null;
}

/** Give a still-empty note the heading `title`. Open notes are left to the editor. */
export async function fillEmptyNoteTitle(path: string, title: string): Promise<void> {
  if (getOpenFile(path)) return;
  const file = await tauri.readFile(path);
  if (file.content !== EMPTY_NOTE) return;
  await tauri.writeFile(path, titledNote(title));
}
