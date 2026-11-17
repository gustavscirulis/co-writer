import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCREENSHOT_DIR = resolve(import.meta.dirname, "../../../../.context");
const NOTES = ["alpha", "bravo", "charlie", "delta"];
const APP_DATA = join(homedir(), "Library/Application Support/com.writer-computer.e2e");

async function invoke(cmd, args) {
  const error = await browser.executeAsync(
    (command, payload, done) => {
      window.__TAURI_INTERNALS__
        .invoke(command, payload)
        .then(() => done(null))
        .catch((err) => done(err && err.message ? err.message : String(err)));
    },
    cmd,
    args,
  );
  strictEqual(error, null);
}

async function tabTitles() {
  return browser.execute(() =>
    [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].map((el) =>
      el.textContent.replace("×", "").trim(),
    ),
  );
}

async function activeTitle() {
  return browser.execute(() => {
    const active = [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].find((el) =>
      el.querySelector("[role=button].backdrop-blur-2xl"),
    );
    return active ? active.textContent.replace("×", "").trim() : null;
  });
}

/** Key chords through the driver are flaky on WKWebView, so dispatch synthetic events. */
async function pressMod(key, { shift = false, fromEditor = false } = {}) {
  await browser.execute(
    (k, withShift, inEditor) => {
      const target = inEditor ? document.querySelector(".cm-content") : window;
      if (inEditor) target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          metaKey: true,
          shiftKey: withShift,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    shift,
    fromEditor,
  );
  await browser.pause(300);
}

describe("Reopen closed tab (Cmd+Shift+T)", function () {
  before(async function () {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "writer-reopen-tab-")));
    for (const name of NOTES) writeFileSync(join(workspace, `${name}.md`), `# ${name}\n`);

    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 15_000 });
    await invoke("open_workspace", { path: workspace });
    await invoke("save_session", {
      workspaceRoot: workspace,
      tabs: NOTES.map((name) => ({
        location: { kind: "file", path: join(workspace, `${name}.md`) },
        back: [],
        forward: [],
      })),
      activeIndex: 1,
    });
    writeFileSync(join(APP_DATA, "recent_workspaces.json"), JSON.stringify([workspace]));
    await browser.execute(() => {
      window.__staleBeforeReload = true;
    });
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (expected) =>
            !window.__staleBeforeReload &&
            document.querySelectorAll("[data-tab-strip] [data-tab-id]").length === expected,
          NOTES.length,
        ),
      { timeout: 15_000, timeoutMsg: "reloaded app did not restore the tabs" },
    );
  });

  it("reopens closed tabs newest first, at their old position", async function () {
    strictEqual(await activeTitle(), "bravo");

    await pressMod("w");
    await pressMod("w");
    deepStrictEqual(await tabTitles(), ["alpha", "delta"]);
    await browser.saveScreenshot(join(SCREENSHOT_DIR, "reopen-tab-after-close.png"));

    await pressMod("T", { shift: true });
    deepStrictEqual(await tabTitles(), ["alpha", "charlie", "delta"]);
    strictEqual(await activeTitle(), "charlie");

    await pressMod("T", { shift: true });
    deepStrictEqual(await tabTitles(), NOTES);
    strictEqual(await activeTitle(), "bravo");
    await browser.saveScreenshot(join(SCREENSHOT_DIR, "reopen-tab-after-reopen.png"));
  });

  it("works from inside the editor without changing the note", async function () {
    await pressMod("w");
    deepStrictEqual(await tabTitles(), ["alpha", "charlie", "delta"]);
    await browser.waitUntil(async () => (await activeTitle()) === "charlie");
    const before = await browser.execute(() => document.querySelector(".cm-content").textContent);

    await pressMod("T", { shift: true, fromEditor: true });

    deepStrictEqual(await tabTitles(), NOTES);
    strictEqual(await activeTitle(), "bravo");
    await pressMod("3");
    const after = await browser.execute(() => document.querySelector(".cm-content").textContent);
    strictEqual(after, before);
  });
});
