//! Native presentation only. Installation and preview behavior belong to the caller.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAutoresizingMaskOptions, NSColor, NSFont, NSScreen,
    NSScrollView, NSTextView, NSWindow,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::cell::RefCell;
use tauri::{AppHandle, WebviewWindow};

pub(super) fn show(
    app: &AppHandle,
    parent: WebviewWindow,
    version: String,
    notes: Option<String>,
    respond: impl FnOnce(Result<bool, String>) + Send + 'static,
) -> Result<(), tauri::Error> {
    app.run_on_main_thread(move || {
        // Tauri dispatches this closure to AppKit's main thread.
        let mtm = MainThreadMarker::new().expect("update sheet must run on the main thread");
        let window = match parent.ns_window() {
            Ok(window) => window.cast::<NSWindow>(),
            Err(error) => {
                respond(Err(error.to_string()));
                return;
            }
        };
        // SAFETY: ns_window returns this live WebviewWindow's NSWindow. Retain it
        // on the main thread through sheet completion, even if Tauri closes it.
        let window = unsafe { Retained::retain(window) }.expect("Tauri returned a null NSWindow");
        let alert = build_alert(mtm, &window, &version, notes.as_deref());
        let respond = RefCell::new(Some(respond));
        let keep_alive = (alert.clone(), window.clone(), parent);
        let completion = RcBlock::new(move |result| {
            let _ = &keep_alive;
            if let Some(respond) = respond.borrow_mut().take() {
                respond(Ok(result == NSAlertFirstButtonReturn));
            }
        });
        alert.beginSheetModalForWindow_completionHandler(&window, Some(&completion));
    })
}

fn build_alert(
    mtm: MainThreadMarker,
    parent: &NSWindow,
    version: &str,
    notes: Option<&str>,
) -> Retained<NSAlert> {
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("What’s new in Co-writer"));
    alert.setInformativeText(&NSString::from_str(&format!(
        "Version {version} is available."
    )));
    alert.addButtonWithTitle(&NSString::from_str("Install and Restart"));
    let later = alert.addButtonWithTitle(&NSString::from_str("Later"));
    later.setKeyEquivalent(&NSString::from_str("\u{1b}"));

    if let Some(notes) = notes {
        let screen = parent.screen().or_else(|| NSScreen::mainScreen(mtm));
        let available = screen
            .map(|screen| screen.visibleFrame().size)
            .unwrap_or(NSSize::new(800.0, 600.0));
        let width = 560.0_f64.min((available.width - 160.0).max(120.0));
        let height = 300.0_f64.min((available.height - 240.0).max(40.0));
        let scroll = NSScrollView::initWithFrame(
            NSScrollView::alloc(mtm),
            NSRect::new(NSPoint::ZERO, NSSize::new(width, height)),
        );
        scroll.setHasVerticalScroller(true);
        scroll.setHasHorizontalScroller(false);
        scroll.setAutohidesScrollers(true);
        scroll.setDrawsBackground(false);

        let text = NSTextView::initWithFrame(
            NSTextView::alloc(mtm),
            NSRect::new(
                NSPoint::ZERO,
                NSSize::new(scroll.contentSize().width, height),
            ),
        );
        text.setEditable(false);
        text.setSelectable(true);
        text.setRichText(false);
        text.setDrawsBackground(false);
        text.setFont(Some(&NSFont::systemFontOfSize(14.0)));
        text.setTextColor(Some(&NSColor::labelColor()));
        text.setTextContainerInset(NSSize::new(0.0, 8.0));
        text.setMinSize(NSSize::ZERO);
        text.setMaxSize(NSSize::new(f64::MAX, f64::MAX));
        text.setVerticallyResizable(true);
        text.setHorizontallyResizable(false);
        text.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
        // SAFETY: text owns its container; all text-system work is on the main thread.
        if let Some(container) = unsafe { text.textContainer() } {
            container.setContainerSize(NSSize::new(scroll.contentSize().width, f64::MAX));
            container.setWidthTracksTextView(true);
        }
        text.setString(&NSString::from_str(notes));
        scroll.setDocumentView(Some(&text));
        text.sizeToFit();
        scroll.setFrameSize(NSSize::new(width, text.frame().size.height.min(height)));
        alert.setAccessoryView(Some(&scroll));
        alert.layout();

        // Account for the actual system alert chrome, which varies by macOS.
        let frame = alert.window().frame().size;
        let size = scroll.frame().size;
        let excess_width = (frame.width - (available.width - 40.0)).max(0.0);
        let excess_height = (frame.height - (available.height - 40.0)).max(0.0);
        if excess_width > 0.0 || excess_height > 0.0 {
            scroll.setFrameSize(NSSize::new(
                (size.width - excess_width).max(120.0),
                (size.height - excess_height).max(40.0),
            ));
            alert.layout();
        }
    }

    alert
}
