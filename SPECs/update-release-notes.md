# Release notes in the native update window

Show the same summary as the GitHub release in a native macOS sheet. Notes are
selectable, wrap at approximately 560pt, and scroll within a region capped at
300pt. Fit the complete sheet to its screen; keep Install and Restart / Later
visible. Missing or title-only notes omit the notes region.

The release manifest reads the exact notes file passed to GitHub. Preserve its
wording, Unicode and paragraphs. Existing published assets are not modified.

One updater operation or preview may run at a time. Responses belong to the
displayed update, and AppKit presentation and lifetime stay on the main thread.

Debug builds expose Developer menu actions for the real 0.8.3 summary, long
notes and no notes. They share the production presenter and button labels, but
both buttons only close the preview. Preview paths and fixtures are compiled
out of release builds and never check the network, install, restart, mutate
pending updates or persist dismissal.

Validate manifest encoding, note filtering, updater sequencing and preview
isolation with tests. Exercise native previews in light/dark appearances and
smaller windows, including scrolling, selection, copying and Escape. Check
release-build exclusion and run the repository's Rust and frontend checks.
