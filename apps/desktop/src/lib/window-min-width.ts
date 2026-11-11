export const EDITOR_MIN_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 220;
export const CHAT_MIN_WIDTH = 260;
export const COLLAPSED_MIN_WIDTH = 400;
export const WINDOW_MIN_HEIGHT = 500;

export function windowMinWidth({ sidebar, chat }: { sidebar: boolean; chat: boolean }) {
  return Math.max(
    COLLAPSED_MIN_WIDTH,
    EDITOR_MIN_WIDTH + (sidebar ? SIDEBAR_MIN_WIDTH : 0) + (chat ? CHAT_MIN_WIDTH : 0),
  );
}
