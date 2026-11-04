# Update release notes

- Task: [native release notes and debug preview](../update-release-notes.md), in TODOS.
- Reviewed: updater state/presentation, native menu setup, raw AppKit helpers,
  release script, release docs, consolidation and review protocol.
- Root cause: GitHub receives NOTES_FILE while latest.json receives a title.
- Plan: share the notes file; isolate a native scrollable AppKit presenter;
  serialize lifecycle admission and version-bound responses; add compile-time
  debug-only fixture menu paths through the same presenter with inert callbacks.
- Validation: manifest round-trip fixtures, Rust lifecycle/filter tests, all
  required checks, native preview QA, and release compile/symbol exclusion.
- Plan review: Rust/Tauri review identified replacement of pending updates under
  an open prompt. Address with one lifecycle lock and version-bound consumption.
- Working tree was clean at start. User approved the full plan including preview.
- Implementation: a shared UTF-8 manifest generator preserves the notes file,
  including CRLF. Relative notes paths resolve before the build changes cwd.
  `updater/native.rs` owns the retained AppKit sheet and scrolling text system;
  `updater/preview.rs` and its fixture are compile-time debug-only. Both preview
  button responses only end preview admission. One locked session owns pending
  updates and version-bound responses; menu refreshes read current state on the
  main thread without holding the lifecycle lock across UI dispatch.
- Reviews: independent Rust/Tauri and UX reviews had no actionable findings.
  QA requested deterministic concurrency coverage; added a barrier-driven test
  proving one-time consumption and rejection of a response for the old version.
- Passed: `vp install`; `vp check` (two existing warnings); `vp test` (77 files,
  1063 tests); 6 updater tests; 2 Python manifest tests; `bash -n`;
  `cargo clippy` (existing warnings); `cargo fmt --check`; `cargo check --release`;
  binary and doc-test targets (0 tests). `cargo test` has 233 passed, 6 existing
  ignored, and the same pre-existing `test_delete_entry_moves_to_trash` failure
  seen before implementation: Finder's AppleScript/XPC connection is denied.
  Retrying with escalation did not change that environment limitation.
- Release exclusion: additionally emitted LLVM with debug assertions disabled
  (`cargo rustc --lib --profile dev -- -C debug-assertions=no --emit=llvm-ir`).
  The compiled artifact retains the real presenter but has none of the three
  preview labels, preview module/functions, final fixture marker, or fixture text.
- Native QA: normal raw dev launch could not connect to macOS services. An
  isolated, ad-hoc-signed debug app bundle launched through Computer Use worked.
  Its standard and 5x-long fixtures display selectable, wrapping native notes
  with fixed buttons. Verified scrolling to the final long-preview marker,
  Cmd+A selection, Backspace leaving the notes intact, and Escape closing the
  standard sheet. Cmd+C was exercised; clipboard readback is sandbox-blocked.
  Screenshot evidence: `.context/update-long-bottom.jpg` and
  `.context/update-notes-dark-full.png` (selection).
- Remaining native QA: empty fixture, button responses, light appearance and a
  smaller display. Computer Use subsequently returned "Computer Use was not
  approved to use Co-writer Preview QA" while attempting the preview Install
  button. Did not retry or bypass that denial. Native button behavior is covered
  by shared presenter wiring and inert preview callbacks, not a completed UI check.
- The debug bundle was produced locally without publishing anything. Tauri's
  build command ended at updater-artifact signing because no private updater
  signing key was supplied; the ad-hoc-signed app itself was built and used.
- Status: implementation complete; residual native QA limitations above.
