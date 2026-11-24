import { ok, equal } from "node:assert/strict";

// The embed reports its layout through the frame's error channel, so reads need
// no frame switching. Self-skips without a restorable workspace.
describe("Expanded HTML embeds", function () {
  const FILE_STEM = "embed-expanded-e2e";
  const DOC = [
    "# Expanded embed check",
    "",
    "```html embed",
    '<div id="box" style="width:240px;height:80px;margin:0 auto;background:#4a5bd4"></div>',
    "<script>",
    "setInterval(() => {",
    "  const r = document.getElementById('box').getBoundingClientRect();",
    "  Promise.reject(new Error('layout ' + JSON.stringify({",
    "    top: r.top, bottom: r.bottom, left: r.left, right: r.right,",
    "    vw: innerWidth, vh: innerHeight, zoom: (/scale\\(([^)]+)\\)/.exec(document.documentElement.style.transform) || [0, '1'])[1],",
    "  })));",
    "}, 100);",
    "const sent = new Set();",
    "const wheel = (init) => document.body.dispatchEvent(new WheelEvent('wheel', {",
    "  clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true, ...init,",
    "}));",
    "addEventListener('resize', () => {",
    "  if (innerWidth <= 850 && !sent.has('pinch')) { sent.add('pinch'); wheel({ ctrlKey: true, deltaY: -40 }); }",
    "  else if (innerHeight <= 500 && !sent.has('pan')) { sent.add('pan'); wheel({ deltaX: 100 }); }",
    "});",
    "</script>",
    "```",
    "",
  ].join("\n");

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

  async function layout() {
    const text = await browser.execute(
      () => document.querySelector(".cm-embed-expanded .cm-embed-error")?.textContent ?? "",
    );
    return text.startsWith("layout ") ? JSON.parse(text.slice("layout ".length)) : null;
  }

  async function waitForZoom(zoom) {
    let last = null;
    await browser.waitUntil(
      async () => {
        last = await layout();
        return last !== null && Math.abs(Number(last.zoom) - zoom) < 0.01;
      },
      { timeout: 5_000, timeoutMsg: `zoom never reached ${zoom}: ${JSON.stringify(last)}` },
    );
    return last;
  }

  async function pressCmd(key, code) {
    await browser.execute(
      (k, c) => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: k,
            code: c,
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      key,
      code,
    );
  }

  const editorZoom = () =>
    browser.execute(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--writer-editor-zoom"),
    );

  async function shot(name) {
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/${name}.png`);
    }
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the embed document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.refresh();
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({ timeout: 15_000 });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("centers short content in the expanded view", async function () {
    const row = await $(`span*=Expanded embed check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await $(".cm-embed-iframe").waitForExist({ timeout: 10_000 });

    await browser.execute(() =>
      document.querySelector('.cm-embed-button[aria-label="Expand"]').click(),
    );
    await $(".cm-embed-expanded .cm-embed-iframe").waitForExist({ timeout: 5_000 });
    const l = await waitForZoom(1);
    await shot("embed-expanded-centered");
    console.log("centered layout:", JSON.stringify(l));
    ok(Math.abs(l.top - (l.vh - l.bottom)) <= 2, `not vertically centered: ${JSON.stringify(l)}`);
    ok(Math.abs(l.left - (l.vw - l.right)) <= 2, `not horizontally centered: ${JSON.stringify(l)}`);
  });

  it("zooms with Cmd+= / Cmd+- / Cmd+0 pressed outside the frame, not the editor", async function () {
    const before = await editorZoom();
    await pressCmd("=", "Equal");
    await pressCmd("=", "Equal");
    const zoomed = await waitForZoom(1.15 * 1.15);
    await shot("embed-expanded-zoomed");
    console.log("zoomed layout:", JSON.stringify(zoomed));
    ok(zoomed.right - zoomed.left > 240 * 1.3, "box did not grow on screen");
    await pressCmd("-", "Minus");
    await waitForZoom(1.15);
    await pressCmd("0", "Digit0");
    await waitForZoom(1);
    equal(await editorZoom(), before, "editor text zoom changed behind the overlay");
  });

  // WebDriver can't run scripts in the cross-origin frame, so resizing it
  // makes the embed dispatch a pinch or a scroll on itself.
  it("zooms on a pinch (Ctrl-wheel) inside the frame", async function () {
    await browser.execute(() => {
      document.querySelector(".cm-embed-expanded").style.width = "800px";
    });
    const l = await waitForZoom(Math.exp(40 * 0.01));
    await shot("embed-expanded-pinched");
    console.log("pinched layout:", JSON.stringify(l));
  });

  it("pans with a two-finger scroll once zoomed past the frame", async function () {
    const before = await layout();
    await browser.execute(() => {
      document.querySelector(".cm-embed-expanded").style.height = "450px";
    });
    let after = null;
    await browser.waitUntil(
      async () => {
        after = await layout();
        return after !== null && after.vh <= 500 && Math.abs(after.left - before.left) > 1;
      },
      { timeout: 5_000, timeoutMsg: `never panned: ${JSON.stringify(after)}` },
    );
    await shot("embed-expanded-panned");
    console.log("panned layout:", JSON.stringify(before), JSON.stringify(after));
    ok(Math.abs(after.left - (before.left - 100)) <= 1, "did not pan by the scroll delta");
  });
});
