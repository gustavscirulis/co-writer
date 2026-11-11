/** The editor's floor beside an open panel; the panels shrink before it does. */
export const EDITOR_MIN_WIDTH = 480;
export const SIDEBAR_MIN_WIDTH = 220;
export const CHAT_MIN_WIDTH = 260;
/** With both panels hidden the editor is the whole window and may go narrower. */
export const COLLAPSED_MIN_WIDTH = 400;
export const WINDOW_MIN_HEIGHT = 500;

export function windowMinWidth({ sidebar, chat }: { sidebar: boolean; chat: boolean }) {
  if (!sidebar && !chat) return COLLAPSED_MIN_WIDTH;
  return EDITOR_MIN_WIDTH + (sidebar ? SIDEBAR_MIN_WIDTH : 0) + (chat ? CHAT_MIN_WIDTH : 0);
}
