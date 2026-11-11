import { expect, test } from "vite-plus/test";
import { windowMinWidth } from "../src/lib/window-min-width";

test("window min width grows only by the panels that are open", () => {
  expect(windowMinWidth({ sidebar: false, chat: false })).toBe(400);
  expect(windowMinWidth({ sidebar: true, chat: false })).toBe(540);
  expect(windowMinWidth({ sidebar: false, chat: true })).toBe(580);
  expect(windowMinWidth({ sidebar: true, chat: true })).toBe(800);
});
