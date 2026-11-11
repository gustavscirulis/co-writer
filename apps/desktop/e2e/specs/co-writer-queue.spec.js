import { ok } from "node:assert/strict";

// Needs a restorable workspace and a signed-in Claude Code CLI; it starts one real turn and stops it.
describe("Co-writer queue", function () {
  const SHOTS = process.env.WRITER_E2E_SHOTS;
  let workspaceRestored = false;
  let filePath = null;

  async function invoke(cmd, args) {
    return browser.executeAsync(
      (c, a, done) => {
        window.__TAURI_INTERNALS__
          .invoke(c, a)
          .then((v) => done({ ok: true, value: v }))
          .catch((e) => done({ ok: false, error: e && e.message ? e.message : String(e) }));
      },
      cmd,
      args,
    );
  }

  async function press(key, modifiers = {}) {
    await browser.execute(
      (pressed, mods) => {
        (document.activeElement ?? document).dispatchEvent(
          new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true, ...mods }),
        );
      },
      key,
      modifiers,
    );
  }

  // React only sees a value change that goes through the native setter plus an input event.
  async function fill(value) {
    await browser.execute((next) => {
      const input = document.querySelector('textarea[aria-label="Message"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }, value);
  }

  async function shot(name) {
    if (!SHOTS) return;
    // Let entrance animations settle so the capture shows the final layout.
    await browser.pause(600);
    await browser.saveScreenshot(`${SHOTS}/${name}.png`);
  }

  const composer = () => $('textarea[aria-label="Message"]');
  const tray = () => $("button*=queued");
  const conversation = () => $('[role="log"][aria-label="Conversation"]');

  before(async function () {
    this.timeout(120_000);
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the note into");
    filePath = `${root}/co-writer-queue-e2e.md`;
    const wrote = await invoke("write_file", { path: filePath, content: "# Queue check\n\nHi.\n" });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);
    const row = await $("span*=Queue check");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();
    await $(".cm-content").waitForExist({ timeout: 5_000 });
    const open = await $('button[aria-label="Co-writer"][aria-pressed="false"]');
    if (await open.isExisting()) await open.click();
    await composer().waitForExist({ timeout: 5_000 });
    // Stopping a previous run's turn puts its messages back in the persisted queue.
    if (await tray().isExisting()) {
      if ((await tray().getAttribute("aria-expanded")) !== "true") await tray().click();
      while (await $('button[aria-label="Remove from queue"]').isExisting())
        await $('button[aria-label="Remove from queue"]').click();
    }
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    const stop = await $('button[aria-label="Stop"]');
    if (await stop.isExisting()) await stop.click();
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("edits one queued message at a time, in place, and Esc puts it back", async function () {
    this.timeout(60_000);
    const queueTexts = () =>
      browser.execute(() =>
        [...document.querySelectorAll('ul[aria-label="Queue"] li')].map((row) =>
          row.textContent.trim(),
        ),
      );
    // Each row's first button edits it; returns whether it was enabled and clicks it if asked.
    const edit = (text, click = false) =>
      browser.execute(
        (wanted, press) => {
          const button = [...document.querySelectorAll('ul[aria-label="Queue"] li')]
            .find((row) => row.textContent.trim() === wanted)
            ?.querySelector("button");
          if (!button || button.disabled) return false;
          if (press) button.click();
          return true;
        },
        text,
        click,
      );
    await composer().click();
    for (const message of ["edit one", "edit two", "edit three"]) {
      await composer().addValue(message);
      await press("Enter", { metaKey: true });
    }
    await tray().waitForExist({ timeout: 5_000 });
    if ((await tray().getAttribute("aria-expanded")) !== "true") await tray().click();

    await composer().addValue("unsent draft");
    ok(!(await edit("edit one")), "editing should wait for an empty composer");
    await fill("");

    ok(await edit("edit one", true), "editing should work from an empty composer");
    ok((await composer().getValue()) === "edit one", "the message should fill the composer");
    ok(!(await edit("edit two")), "only one message can be out for editing");
    await press("Escape");
    await browser.waitUntil(async () => (await queueTexts()).length === 3, {
      timeout: 5_000,
      timeoutMsg: "Esc should put the message back in the queue",
    });
    ok((await composer().getValue()) === "", "Esc should clear the composer");

    ok(await edit("edit two", true), "edit two should be editable again");
    await fill("edit two, revised");
    await press("Enter", { metaKey: true });
    await browser.waitUntil(async () => (await queueTexts()).length === 3, { timeout: 5_000 });
    const texts = await queueTexts();
    ok(
      texts[0] === "edit one" && texts[1] === "edit two, revised" && texts[2] === "edit three",
      `the edited message should keep its place, got ${JSON.stringify(texts)}`,
    );
    await shot("queue-after-edit");
    while (await $('button[aria-label="Remove from queue"]').isExisting())
      await $('button[aria-label="Remove from queue"]').click();
  });

  it("sends the whole queue with the draft last when Enter is pressed", async function () {
    this.timeout(120_000);
    await composer().click();
    for (const message of ["queued alpha", "queued bravo"]) {
      await composer().addValue(message);
      await press("Enter", { metaKey: true });
    }
    await tray().waitForExist({ timeout: 5_000 });
    ok((await tray().getText()).includes("2 queued"), "two messages should be queued");
    await composer().addValue("draft charlie");
    await shot("queue-before-enter");
    await press("Enter");
    await browser.waitUntil(
      async () => (await conversation().getText()).includes("draft charlie"),
      { timeout: 15_000, timeoutMsg: "the sent turn never appeared in the conversation" },
    );
    const text = await conversation().getText();
    const order = ["queued alpha", "queued bravo", "draft charlie"].map((m) => text.indexOf(m));
    ok(
      order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
      `expected all three messages in order, got ${JSON.stringify(text)}`,
    );
    ok(!(await tray().isExisting()), "the queue tray should be empty after sending");
    await shot("queue-after-enter");
  });
});
